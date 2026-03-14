/**
 * Horror System — AI text-based interactive horror story instances (怪谈副本)
 *
 * The pet character "transmigrates" into a horror scenario world.
 * User acts as the player outside the story, sending commands to control the pet.
 * LLM simultaneously plays DM (narrator) and the pet character.
 *
 * Key mechanics:
 * - Scenario-based worldview injection via agent:bootstrap hook
 * - 5 character attributes used for TRPG-style skill checks
 * - Sanity as session-local resource (0-100)
 * - Turn-limited sessions driven by chat messages
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { AttrLevelInfo } from "./skill-system.js";
import { BUILTIN_SCENARIOS, type HorrorScenario } from "./horror-scenarios.js";

// ─── Types ───

export type HorrorSessionStatus = "active" | "won" | "lost" | "abandoned";

export interface SkillCheckRecord {
  turn: number;
  attribute: string;
  dc: number;
  playerLevel: number;
  roll: number;
  success: boolean;
  context: string;
  sanityChange: number;
}

export interface HorrorRewards {
  exp: number;
  coins: number;
  intimacy: number;
  moodDelta: number;
  skillXp: Record<string, number>;
}

export interface HorrorOutcome {
  won: boolean;
  narrative: string;
  sanityRemaining: number;
  rewards: HorrorRewards;
}

export interface HorrorSession {
  id: string;
  scenarioId: string;
  status: HorrorSessionStatus;
  turnCount: number;
  maxTurns: number;
  sanity: number;
  cluesFound: string[];
  checksPerformed: SkillCheckRecord[];
  npcsEncountered: string[];
  startedAt: number;
  endedAt?: number;
  outcome?: HorrorOutcome;
}

export interface SkillCheckResult {
  success: boolean;
  roll: number;
  playerLevel: number;
  effectiveScore: number;
  targetScore: number;
  sanityChange: number;
  attribute: string;
  dc: number;
}


// ─── Reward Tables ───

const DIFFICULTY_REWARDS: Record<number, { exp: number; coins: number; intimacy: number; mood: number }> = {
  1: { exp: 80,  coins: 40,  intimacy: 15, mood: 20 },
  2: { exp: 150, coins: 75,  intimacy: 25, mood: 25 },
  3: { exp: 250, coins: 120, intimacy: 40, mood: 30 },
};

const LOSS_REWARD_FACTOR = 0.3;

const SKILL_XP_SUCCESS = 5;
const SKILL_XP_FAILURE = 2;

const SANITY_LOSS_ON_FAIL = -12;

const ENTRY_HUNGER_COST = 30;

// ─── Horror System ───

export class HorrorSystem {
  private readonly bus: EventBus;
  private readonly store: PersistenceStore;
  private sessions: Map<string, HorrorSession> = new Map();
  private activeSessionId: string | null = null;
  private _getSkillAttributes: (() => AttrLevelInfo[]) | null = null;
  private _getPersona: (() => string) | null = null;

  constructor(bus: EventBus, store: PersistenceStore) {
    this.bus = bus;
    this.store = store;
    this.load();
  }

  // ─── Callbacks ───

  setSkillAttributeProvider(fn: () => AttrLevelInfo[]): void {
    this._getSkillAttributes = fn;
  }

  setPersonaProvider(fn: () => string): void {
    this._getPersona = fn;
  }

  // ─── Scenario Queries ───

  getScenarios(): HorrorScenario[] {
    return BUILTIN_SCENARIOS;
  }

  getScenario(id: string): HorrorScenario | undefined {
    return BUILTIN_SCENARIOS.find((s) => s.id === id);
  }

  // ─── Session Lifecycle ───

  /**
   * Start a new horror session.
   * Returns the session or an error object.
   */
  startSession(scenarioId: string): HorrorSession | { error: string } {
    if (this.activeSessionId) {
      const active = this.sessions.get(this.activeSessionId);
      if (active && active.status === "active") {
        return { error: "Already in an active horror session" };
      }
    }

    const scenario = this.getScenario(scenarioId);
    if (!scenario) {
      return { error: `Scenario not found: ${scenarioId}` };
    }

    const id = `horror-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const maxTurns = Math.round(scenario.estimatedTurns * 1.5);

    const session: HorrorSession = {
      id,
      scenarioId,
      status: "active",
      turnCount: 0,
      maxTurns,
      sanity: 100,
      cluesFound: [],
      checksPerformed: [],
      npcsEncountered: [],
      startedAt: Date.now(),
    };

    this.sessions.set(id, session);
    this.activeSessionId = id;
    this.save();

    this.bus.emit("horror:started", {
      session: { id, scenarioId, title: scenario.title },
    });

    return session;
  }

  /**
   * Get the hunger cost to enter a horror session.
   */
  getEntryCost(): number {
    return ENTRY_HUNGER_COST;
  }

  /**
   * Record a turn (called on each user message during active session).
   */
  recordTurn(): void {
    const session = this._getActive();
    if (!session) return;

    session.turnCount++;

    // Check max turns — force end
    if (session.turnCount >= session.maxTurns) {
      this.endSession(false, "时间耗尽了……回合数已达上限，副本强制结束。");
      return;
    }

    this.save();
  }

  /**
   * Perform a skill check.
   * Called by the horror_skill_check LLM tool.
   */
  performSkillCheck(
    attribute: string,
    dc: number,
    context: string,
  ): SkillCheckResult | { error: string } {
    const session = this._getActive();
    if (!session) {
      return { error: "No active horror session" };
    }

    // Get player's attribute level
    const attrs = this._getSkillAttributes?.() ?? [];
    const attrInfo = attrs.find((a) => a.key === attribute);
    const playerLevel = attrInfo?.level ?? 1;

    // Roll 1-10
    const roll = Math.floor(Math.random() * 10) + 1;
    const effectiveScore = roll + playerLevel;
    const targetScore = dc + 5;
    const success = effectiveScore >= targetScore;

    // Sanity change
    const sanityChange = success ? 0 : SANITY_LOSS_ON_FAIL;
    session.sanity = Math.max(0, Math.min(100, session.sanity + sanityChange));

    // Record the check
    const record: SkillCheckRecord = {
      turn: session.turnCount,
      attribute,
      dc,
      playerLevel,
      roll,
      success,
      context,
      sanityChange,
    };
    session.checksPerformed.push(record);

    this.save();

    this.bus.emit("horror:check", {
      attribute,
      dc,
      success,
      sanity: session.sanity,
    });

    // Check sanity loss condition
    if (session.sanity <= 0) {
      this.endSession(false, "理智归零……意识逐渐模糊，一切陷入黑暗。");
    }

    return {
      success,
      roll,
      playerLevel,
      effectiveScore,
      targetScore,
      sanityChange,
      attribute,
      dc,
    };
  }

  /**
   * Add a discovered clue.
   */
  addClue(clue: string): void {
    const session = this._getActive();
    if (!session) return;
    if (!session.cluesFound.includes(clue)) {
      session.cluesFound.push(clue);
      this.save();
    }
  }

  /**
   * Record an NPC encounter.
   */
  addNpcEncounter(npcName: string): void {
    const session = this._getActive();
    if (!session) return;
    if (!session.npcsEncountered.includes(npcName)) {
      session.npcsEncountered.push(npcName);
      this.save();
    }
  }

  /**
   * Reduce sanity (called by LLM tool for scary events).
   */
  reduceSanity(amount: number): void {
    const session = this._getActive();
    if (!session) return;
    session.sanity = Math.max(0, session.sanity - Math.abs(amount));
    this.save();

    if (session.sanity <= 0) {
      this.endSession(false, "理智归零……意识逐渐模糊，一切陷入黑暗。");
    }
  }

  /**
   * End the session (called by horror_end_session tool or internal triggers).
   */
  endSession(won: boolean, narrative: string): HorrorOutcome | { error: string } {
    const session = this._getActive();
    if (!session) {
      return { error: "No active horror session" };
    }

    const scenario = this.getScenario(session.scenarioId);
    const difficulty = scenario?.difficulty ?? 1;
    const baseRewards = DIFFICULTY_REWARDS[difficulty] ?? DIFFICULTY_REWARDS[1]!;

    // Calculate skill XP from checks
    const skillXp: Record<string, number> = {};
    for (const check of session.checksPerformed) {
      const xp = check.success ? SKILL_XP_SUCCESS : SKILL_XP_FAILURE;
      skillXp[check.attribute] = (skillXp[check.attribute] ?? 0) + xp;
    }

    const rewards: HorrorRewards = won
      ? {
          exp: baseRewards.exp,
          coins: baseRewards.coins,
          intimacy: baseRewards.intimacy,
          moodDelta: baseRewards.mood,
          skillXp,
        }
      : {
          exp: Math.floor(baseRewards.exp * LOSS_REWARD_FACTOR),
          coins: Math.floor(baseRewards.coins * LOSS_REWARD_FACTOR),
          intimacy: 5,
          moodDelta: -10,
          skillXp,
        };

    const outcome: HorrorOutcome = {
      won,
      narrative,
      sanityRemaining: session.sanity,
      rewards,
    };

    session.status = won ? "won" : "lost";
    session.endedAt = Date.now();
    session.outcome = outcome;
    this.activeSessionId = null;
    this.save();

    this.bus.emit("horror:completed", {
      session: { id: session.id, scenarioId: session.scenarioId },
      outcome,
    });

    return outcome;
  }

  /**
   * Abandon the current session.
   */
  abandonSession(sessionId: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "Session not found" };
    if (session.status !== "active") return { ok: false, reason: "Session not active" };

    session.status = "abandoned";
    session.endedAt = Date.now();
    session.outcome = {
      won: false,
      narrative: "副本被放弃了。",
      sanityRemaining: session.sanity,
      rewards: { exp: 0, coins: 0, intimacy: 0, moodDelta: -5, skillXp: {} },
    };
    this.activeSessionId = null;
    this.save();

    this.bus.emit("horror:abandoned", { session: { id: session.id } });

    return { ok: true };
  }

  // ─── Prompt Context Generation ───

  /**
   * Generate the HORROR_SESSION.md content for LLM prompt injection.
   * Returns null if no active session.
   */
  getActivePromptContext(): string | null {
    const session = this._getActive();
    if (!session) return null;

    const scenario = this.getScenario(session.scenarioId);
    if (!scenario) return null;

    const attrs = this._getSkillAttributes?.() ?? [];
    const attrLines = attrs
      .map((a) => `- ${a.name}(${a.key}): Lv.${a.level}`)
      .join("\n");

    const npcLines = scenario.npcs
      .map((n) => `- **${n.name}**（${n.role}）：${n.personality}`)
      .join("\n");

    const checkSummary = session.checksPerformed.length > 0
      ? session.checksPerformed
          .slice(-5)
          .map((c) => `  - [${c.success ? "✓" : "✗"}] ${c.attribute} DC${c.dc}: ${c.context}`)
          .join("\n")
      : "  无";

    const persona = this._getPersona?.() ?? "";

    return `# 怪谈副本模式 — 活跃中

你同时扮演两个角色：
1. **DM（旁白）**：第三人称叙述世界、环境、NPC 行为
2. **宠物角色**：穿越进了这个怪谈世界，按用户指令行动

用户 = 在故事之外操控宠物的"玩家"，用户的消息是对宠物的指令或建议。

## 宠物人设（必须贯穿全程）
${persona || "（未配置人设）"}

> 宠物在怪谈中必须保持以上性格和说话风格。恐惧、紧张等情绪叠加在原有性格之上，而非替代。

## 输出格式
- 先写【旁白】段落：描述环境变化、NPC 动作、事件发展（第三人称）
- 再写宠物反应：宠物的台词用「」包裹，动作用叙述描写，**语气和用词必须符合上述人设**
- 末尾用 > 引用块给出 2-3 个建议行动供用户选择（非强制）

## 当前副本：${scenario.title}
${scenario.worldview}

## 场景设定
${scenario.setting}

## NPC
${npcLines}

## 世界规则（必须遵守）
${scenario.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}

## 胜利条件
${scenario.winConditions.map((w) => `- ${w}`).join("\n")}

## 失败条件
${scenario.loseConditions.map((l) => `- ${l}`).join("\n")}

## 宠物当前属性（用于判定）
${attrLines}

## 当前状态
- 轮次：${session.turnCount}/${session.maxTurns}
- 理智值：${session.sanity}/100
- 已发现线索：${session.cluesFound.length > 0 ? session.cluesFound.join("、") : "无"}
- 已遭遇NPC：${session.npcsEncountered.length > 0 ? session.npcsEncountered.join("、") : "无"}
- 技能判定记录（最近5次）：
${checkSummary}

## 技能判定规则（核心机制，严格执行）
- 公式：**roll(1~10) + 属性等级 ≥ DC + 5** → 成功，否则失败
- 以下行动**必须**调用 character_horror 工具进行判定，禁止跳过或自行编造结果：
  - 搜索/调查/观察可疑物品 → 逻辑(logic) 或 感知(sensitivity) 判定
  - 说服/安抚/与 NPC 交涉 → 共情(empathy) 判定
  - 逃跑/开锁/物理操作 → 执行(execution) 判定
  - 推理/解谜/分析线索 → 逻辑(logic) 判定
  - 即兴发挥/灵机一动 → 创造(creativity) 判定
- 判定结果决定叙事走向：成功则行动达成，失败则遇阻/受惊（理智-12）
- 每轮至少 0~2 次判定，根据行动复杂度决定
- **禁止**未调用工具就写"判定成功/失败"

## GM 行为规则
1. 每次回复推进 1 步，保持悬疑节奏
2. 用户指令 → 宠物尝试执行 → 触发技能判定（见上方规则）→ 根据工具返回的结果叙述成败
3. PG-13 恐怖氛围，不过度血腥
4. 理智值高(>60) → 暗示恐怖（气氛描写），低(<40) → 直接恐怖（异象显现）
5. 宠物的恐惧/勇气/吐槽必须符合上方人设的性格和语气
6. 轮次接近上限（剩余<5轮）时加速推向结局
7. 达成胜利/失败条件时调用 character_horror 工具结束副本
8. 发现新线索时调用 character_horror 工具记录
9. 首次遇到 NPC 时调用 character_horror 工具记录`;
  }

  // ─── Queries ───

  getActiveSession(): HorrorSession | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  getSession(id: string): HorrorSession | undefined {
    return this.sessions.get(id);
  }

  getHistory(limit = 10): HorrorSession[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.status !== "active")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
      .slice(0, limit);
  }

  getStats(): {
    total: number;
    won: number;
    lost: number;
    abandoned: number;
    active: boolean;
  } {
    const all = Array.from(this.sessions.values());
    return {
      total: all.length,
      won: all.filter((s) => s.status === "won").length,
      lost: all.filter((s) => s.status === "lost").length,
      abandoned: all.filter((s) => s.status === "abandoned").length,
      active: this.activeSessionId !== null,
    };
  }

  // ─── Internal ───

  private _getActive(): HorrorSession | null {
    if (!this.activeSessionId) return null;
    const session = this.sessions.get(this.activeSessionId);
    if (!session || session.status !== "active") {
      this.activeSessionId = null;
      return null;
    }
    return session;
  }

  // ─── Persistence ───

  private load(): void {
    const data = this.store.load("horror-system");
    if (data?.sessions) {
      const list = data.sessions as HorrorSession[];
      for (const s of list) {
        this.sessions.set(s.id, s);
        if (s.status === "active") {
          this.activeSessionId = s.id;
        }
      }
    }
  }

  private save(): void {
    // Trim completed sessions to last 30
    const completed = Array.from(this.sessions.values())
      .filter((s) => s.status !== "active")
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    if (completed.length > 30) {
      for (const s of completed.slice(30)) {
        this.sessions.delete(s.id);
      }
    }

    this.store.save("horror-system", {
      sessions: Array.from(this.sessions.values()),
      updatedAt: Date.now(),
    });
  }
}
