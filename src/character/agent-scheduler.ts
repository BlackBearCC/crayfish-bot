/**
 * Agent Scheduler — World Agent + Soul Agent
 *
 * Two internal "agents" that run on a timer with program-rule pre-filtering.
 * Pre-filter checks conditions deterministically (zero tokens). Only when
 * there is something meaningful to process does it call the LLM.
 *
 * World Agent: generates events, quests, rewards (writes to WorldEventSystem)
 * Soul Agent: decides what the character should say/do (outputs to delivery callback)
 *
 * Neither agent uses OpenClaw's full agent pipeline. They call the LLM directly
 * via a provided `llmComplete` callback, keeping the implementation lightweight.
 */

import type { CharacterEngine } from "./character-engine.js";
import type { WorldEvent } from "./world-event-system.js";

// ─── Types ───

export type LLMCompleteCallback = (prompt: string) => Promise<string | null>;

/** Delivery payload from Soul Agent — what the character wants to do */
export interface SoulAction {
  type: "speak" | "self_care" | "express" | "remember" | "silent";
  /** Text to deliver to user (for "speak") */
  text?: string;
  /** Care action (for "self_care") */
  careAction?: "feed" | "rest" | "play";
  /** Emotion expression (for "express") */
  emotion?: string;
  /** Memory to store (for "remember") */
  memory?: { fact: string; category: string };
}

/** Called when Soul Agent decides to do something */
export type SoulActionCallback = (action: SoulAction) => void;

/** Holidays — static list for pre-filter */
const HOLIDAYS: Record<string, string> = {
  "01-01": "元旦",
  "02-14": "情人节",
  "03-08": "妇女节",
  "04-01": "愚人节",
  "05-01": "劳动节",
  "05-04": "青年节",
  "06-01": "儿童节",
  "09-10": "教师节",
  "10-01": "国庆节",
  "10-31": "万圣节",
  "12-24": "平安夜",
  "12-25": "圣诞节",
};

// ─── Timing constants ───

const WORLD_AGENT_INTERVAL_MS = 60 * 60_000;       // 1 hour
const SOUL_AGENT_INTERVAL_MS  = 30 * 60_000;       // 30 minutes
const SOUL_COOLDOWN_MS        = 20 * 60_000;       // Don't talk again within 20min

// ─── Scheduler ───

export class AgentScheduler {
  private _worldAcc = 0;
  private _soulAcc  = 0;
  private _worldRunning = false;
  private _soulRunning  = false;

  /** Timestamp of last proactive chat from Soul Agent */
  lastProactiveChatAt = 0;

  private _llmComplete: LLMCompleteCallback | null = null;
  private _onSoulAction: SoulActionCallback | null = null;

  constructor(private readonly _engine: CharacterEngine) {}

  /** Set LLM completion callback (wired from gateway) */
  setLLMComplete(fn: LLMCompleteCallback): void {
    this._llmComplete = fn;
  }

  /** Set Soul Agent output callback */
  setOnSoulAction(fn: SoulActionCallback): void {
    this._onSoulAction = fn;
  }

  /** Called from engine.tick() every second */
  tick(deltaMs: number): void {
    this._worldAcc += deltaMs;
    this._soulAcc  += deltaMs;

    if (this._worldAcc >= WORLD_AGENT_INTERVAL_MS && !this._worldRunning) {
      this._worldAcc = 0;
      this._runWorldAgent();
    }

    if (this._soulAcc >= SOUL_AGENT_INTERVAL_MS && !this._soulRunning) {
      this._soulAcc = 0;
      this._runSoulAgent();
    }
  }

  // ─── World Agent ───

  private _runWorldAgent(): void {
    const prompt = this._buildWorldAgentPrompt();
    if (!prompt) return;         // Pre-filter: nothing interesting
    if (!this._llmComplete) return;

    this._worldRunning = true;
    this._llmComplete(prompt)
      .then((output) => { if (output) this._handleWorldOutput(output); })
      .catch((err) => console.error("[agent-scheduler] world agent error:", err))
      .finally(() => { this._worldRunning = false; });
  }

  /** Program-rule pre-filter for World Agent. Returns null → skip LLM. */
  private _buildWorldAgentPrompt(): string | null {
    const triggers: string[] = [];
    const e = this._engine;

    // 1. Login streak milestones
    const streak = e.login.streak;
    const milestones = [3, 7, 14, 30, 60, 100];
    for (const m of milestones) {
      if (streak === m && !e.worldEvents.hasFired(`streak_${m}`)) {
        triggers.push(`[里程碑] 主人连续登录了 ${m} 天`);
      }
    }

    // 2. New tools discovered since last world tick
    const toolData = e.skills.getToolData();
    const toolNames = Object.keys(toolData);
    for (const name of toolNames) {
      const entry = toolData[name]!;
      // Tool used exactly once means it's brand new
      if (entry.count === 1 && !e.worldEvents.hasFired(`tool_${name}`)) {
        triggers.push(`[新技能] 主人首次使用了工具: ${name}`);
      }
    }

    // 3. Holiday check
    const holiday = this._getHolidayToday();
    if (holiday && !e.worldEvents.hasFired(`holiday_${this._todayStr()}`)) {
      triggers.push(`[节日] 今天是 ${holiday}`);
    }

    // 4. Weak domains (30% chance to trigger exploration quest)
    const domains = e.skills.getAttributes();
    const weakDomains = domains.filter((d) => d.level <= 1 && d.xp < 10);
    if (weakDomains.length > 0 && Math.random() < 0.3) {
      triggers.push(`[探索] 这些领域还很薄弱: ${weakDomains.map((d) => d.name).join(", ")}`);
    }

    // 5. Level-up milestone (every 5 levels)
    const level = e.levels.getInfo().level;
    const levelMilestone = Math.floor(level / 5) * 5;
    if (levelMilestone > 0 && !e.worldEvents.hasFired(`level_${levelMilestone}`)) {
      triggers.push(`[成长] 角色达到了 Lv.${level}`);
    }

    if (triggers.length === 0) return null;

    return `你是养成世界的事件生成器。以下情况发生了：
${triggers.map((t) => `- ${t}`).join("\n")}

请为桌宠角色生成合适的世界事件。

回复格式（严格 JSON）：
{
  "id": "唯一事件ID",
  "type": "milestone|skill_unlock|holiday|quest",
  "title": "事件标题(简短)",
  "desc": "事件描述(一句话)",
  "rewards": {"coins": 数字, "exp": 数字}
}

每次只生成 1 个最有意义的事件。只输出 JSON，不要额外文字。`;
  }

  /** Parse World Agent output and write to WorldEventSystem */
  private _handleWorldOutput(output: string): void {
    try {
      const match = output.match(/\{[\s\S]*\}/);
      if (!match) return;
      const parsed = JSON.parse(match[0]) as Partial<WorldEvent>;

      if (!parsed.id || !parsed.type || !parsed.title || !parsed.desc) return;

      const added = this._engine.worldEvents.addEvent({
        id: parsed.id,
        type: parsed.type as WorldEvent["type"],
        title: parsed.title,
        desc: parsed.desc,
        rewards: parsed.rewards,
      });

      if (added) {
        console.log(`[agent-scheduler] world event: ${parsed.type} — ${parsed.title}`);
      }
    } catch {
      // Malformed output, silently skip
    }
  }

  // ─── Soul Agent ───

  private _runSoulAgent(): void {
    const prompt = this._buildSoulAgentPrompt();
    if (!prompt) return;         // Pre-filter: nothing to do
    if (!this._llmComplete) return;

    this._soulRunning = true;
    this._llmComplete(prompt)
      .then((output) => { if (output) this._handleSoulOutput(output); })
      .catch((err) => console.error("[agent-scheduler] soul agent error:", err))
      .finally(() => { this._soulRunning = false; });
  }

  /** Program-rule pre-filter for Soul Agent. Returns null → skip LLM. */
  private _buildSoulAgentPrompt(): string | null {
    const e = this._engine;
    const state = e.getState();
    const pendingEvents = e.worldEvents.peekPending();

    const mood   = e.attributes.getValue("mood");
    const hunger = e.attributes.getValue("hunger");
    const health = e.attributes.getValue("health");

    // All normal + no events + spoke recently → skip
    if (
      pendingEvents.length === 0 &&
      mood > 30 && hunger > 60 && health > 40 &&
      Date.now() - this.lastProactiveChatAt < SOUL_COOLDOWN_MS
    ) {
      return null;
    }

    // Build context summary
    const statusLines: string[] = [];
    statusLines.push(`等级: Lv.${state.level.level} (${state.level.title})`);
    statusLines.push(`心情: ${Math.round(mood)} | 饱腹: ${Math.round(hunger)} | 健康: ${Math.round(health)}`);
    statusLines.push(`亲密阶段: ${state.growth.stageName}`);

    if (state.resting.resting) {
      statusLines.push("当前正在休息中");
    }

    let prompt = `你是桌宠角色的灵魂。根据当前状态，决定此刻最想做的一件事。

当前状态:
${statusLines.join("\n")}

你可以选择以下行动之一:
1. speak — 对主人说句话 (需要有话想说的理由)
2. self_care — 照顾自己 (feed/rest/play，状态不好时使用)
3. express — 表达情绪 (happy/sad/excited/sleepy/curious)
4. remember — 记住什么重要的事
5. silent — 什么都不做 (状态正常且无特别想法时选这个)

`;

    // Inject pending world events
    if (pendingEvents.length > 0) {
      prompt += `最近发生的世界事件:\n`;
      for (const ev of pendingEvents) {
        prompt += `- [${ev.type}] ${ev.title}: ${ev.desc}\n`;
      }
      prompt += "\n";
    }

    // Inject state-driven hints
    if (hunger < 60) prompt += "提示: 你很饿了，可以 self_care(feed) 或者跟主人撒娇要吃的。\n";
    if (mood < 30) prompt += "提示: 心情很低落，可以表达情绪或找主人说说话。\n";
    if (health < 40) prompt += "提示: 身体不舒服，可以 self_care(rest)。\n";

    prompt += `
回复格式（严格 JSON）：
{
  "type": "speak|self_care|express|remember|silent",
  "text": "要说的话（speak时必填）",
  "careAction": "feed|rest|play（self_care时必填）",
  "emotion": "happy|sad|excited|sleepy|curious（express时必填）"
}

只输出 JSON，不要额外文字。如果选 silent，输出 {"type":"silent"}。`;

    return prompt;
  }

  /** Parse Soul Agent output and dispatch action */
  private _handleSoulOutput(output: string): void {
    // Consume pending events (Soul Agent has seen them now)
    this._engine.worldEvents.consumePending();

    try {
      const match = output.match(/\{[\s\S]*\}/);
      if (!match) return;
      const parsed = JSON.parse(match[0]) as SoulAction;

      if (!parsed.type) return;

      // Silent → nothing to do
      if (parsed.type === "silent") return;

      // Record proactive chat time
      if (parsed.type === "speak") {
        this.lastProactiveChatAt = Date.now();
      }

      // Apply self-care effects directly
      if (parsed.type === "self_care" && parsed.careAction) {
        this._applySelfCare(parsed.careAction);
      }

      // Deliver to callback (broadcast to all clients)
      if (this._onSoulAction) {
        this._onSoulAction(parsed);
      }
    } catch {
      // Malformed output, silently skip
    }
  }

  /** Apply self-care action from Soul Agent */
  private _applySelfCare(action: string): void {
    const e = this._engine;
    switch (action) {
      case "feed":
        e.care.feed("ration_42");
        break;
      case "rest":
        e.care.rest("nap");
        break;
      case "play":
        e.care.play("ball");
        break;
    }
  }

  // ─── Helpers ───

  private _getHolidayToday(): string | null {
    const now = new Date();
    const key = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return HOLIDAYS[key] ?? null;
  }

  private _todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}
