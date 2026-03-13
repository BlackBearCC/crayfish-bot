/**
 * Adventure System v2 — Rumor Card + Encounter model
 *
 * Inspired by Darkest Dungeon carriage encounters.
 * Players pick a rumor card to depart, then encounter events along the way.
 * LLM generates rumor cards, opening narratives, encounters, and settlement stories.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

// ─── Types ───

export interface RumorCard {
  id: string;
  hook: string;        // "森林深处传来奇怪的歌声..."
  location: string;    // "神秘森林"
  risk: 1 | 2 | 3;    // star rating
  duration: number;    // minutes
  theme: string;       // "forest" | "ruin" | "water" | "cave" | "town" | "sky"
}

export interface Encounter {
  id: string;
  type: "narration" | "choice" | "discovery";
  text: string;
  choices?: { a: string; b: string };
  selectedChoice?: "a" | "b";
  petDecided?: boolean;
  reward?: { item?: string; coins?: number };
  /** Scheduled trigger time (ms since adventure start) */
  triggerAtMs: number;
  triggeredAt?: number;
  resolvedAt?: number;
}

export interface AdventureRewards {
  exp: number;
  coins: number;
  items?: string[];
}

export interface AdventureResult {
  success: boolean;
  narrative: string;
  rewards: AdventureRewards;
  damage?: number;
}

export interface Adventure {
  id: string;
  card: RumorCard;
  status: "exploring" | "completed" | "cancelled";
  encounters: Encounter[];
  nextEncounterIdx: number;
  story?: string;
  result?: AdventureResult;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
}

/** LLM completion callback — same pattern as memory-graph / chat-eval */
export type AdventureLLMCallback = (prompt: string) => Promise<string | null>;

// ─── Rewards Config ───

const BASE_REWARDS: Record<1 | 2 | 3, AdventureRewards> = {
  1: { exp: 20, coins: 10 },
  2: { exp: 50, coins: 25 },
  3: { exp: 100, coins: 50 },
};

const SUCCESS_RATES: Record<1 | 2 | 3, number> = {
  1: 0.9,
  2: 0.7,
  3: 0.5,
};

/** Choice timeout in ms (60s) */
const CHOICE_TIMEOUT_MS = 60_000;

const RANDOM_ITEMS = ["巴别鱼罐头", "不要恐慌胶囊", "马文牌退烧贴", "泛银河爆破饮"];

// ─── Adventure System ───

export class AdventureSystem {
  private readonly bus: EventBus;
  private readonly store: PersistenceStore;
  private adventures: Map<string, Adventure> = new Map();
  private activeAdventureId: string | null = null;
  private _llmComplete: AdventureLLMCallback | null = null;
  /** Prevents tick() from double-triggering while async LLM completes */
  private _completing = false;
  /** Cached rumor cards for the current session */
  private _cachedRumors: RumorCard[] = [];

  constructor(bus: EventBus, store: PersistenceStore) {
    this.bus = bus;
    this.store = store;
    this.load();
  }

  /** Register the LLM completion callback (set by gateway) */
  setLLMComplete(callback: AdventureLLMCallback): void {
    this._llmComplete = callback;
  }

  // ─── Persistence ───

  private load(): void {
    const data = this.store.load("adventure-system");
    if (data?.adventures) {
      const list = data.adventures as Adventure[];
      for (const adv of list) {
        this.adventures.set(adv.id, adv);
        if (adv.status === "exploring") {
          this.activeAdventureId = adv.id;
        }
      }
    }
  }

  private save(): void {
    // Trim finished adventures to last 50
    const finished = Array.from(this.adventures.values())
      .filter((a) => a.status !== "exploring")
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
    if (finished.length > 50) {
      for (const adv of finished.slice(50)) {
        this.adventures.delete(adv.id);
      }
    }

    this.store.save("adventure-system", {
      adventures: Array.from(this.adventures.values()),
    });
  }

  // ─── Rumor Cards ───

  /**
   * Generate 3 rumor cards via LLM.
   * Falls back to hardcoded cards if LLM is unavailable.
   */
  async generateRumors(): Promise<RumorCard[]> {
    if (this._llmComplete) {
      try {
        console.log("[Adventure] generateRumors: LLM callback present, calling _generateRumorsLLM...");
        const cards = await this._generateRumorsLLM();
        console.log("[Adventure] generateRumors: LLM returned", cards.length, "cards");
        if (cards.length >= 3) {
          this._cachedRumors = cards.slice(0, 3);
          return this._cachedRumors;
        }
        console.log("[Adventure] generateRumors: LLM returned < 3 cards, falling back");
      } catch (err) {
        console.warn("[Adventure] generateRumors: LLM error, falling back:", err);
      }
    } else {
      console.log("[Adventure] generateRumors: no LLM callback, using fallback");
    }

    this._cachedRumors = this._fallbackRumors();
    return this._cachedRumors;
  }

  private async _generateRumorsLLM(): Promise<RumorCard[]> {
    if (!this._llmComplete) return [];

    // Gather recent locations to avoid repetition (v1 history has no .card)
    const recentLocations = this.getHistory(5)
      .map((a) => a.card?.location)
      .filter(Boolean);
    const avoidText = recentLocations.length
      ? `\n避免重复以下地点: ${recentLocations.join("、")}`
      : "";

    const prompt = `你是一个桌面宠物的探险线索卡生成器。请生成3张探险线索卡，每张卡描述一个可探险的地点。

要求：
1. 每张卡包含: hook(1句话钩子文案，15字以内), location(地点名，4字以内), risk(1-3整数，对应安全/中等/危险), duration(分钟数，3-15), theme(氛围标签，只能是 forest/ruin/water/cave/town/sky 之一)
2. 3张卡的risk分布尽量不同（建议1张1星、1张2星、1张3星，但可以变化）
3. hook要有悬念感和吸引力，让人想点进去
4. duration建议: 1星=3-5分钟, 2星=5-10分钟, 3星=10-15分钟${avoidText}

返回严格JSON数组（无代码块标记）：
[{"hook":"...","location":"...","risk":1,"duration":5,"theme":"forest"},{"hook":"...","location":"...","risk":2,"duration":8,"theme":"ruin"},{"hook":"...","location":"...","risk":3,"duration":12,"theme":"cave"}]`;

    const raw = await this._llmComplete(prompt);
    console.log("[Adventure] _generateRumorsLLM raw response:", raw?.substring(0, 500));
    if (!raw) return [];

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn("[Adventure] _generateRumorsLLM: no JSON array found in response");
      return [];
    }

    const parsed = JSON.parse(match[0]) as Array<{
      hook?: string;
      location?: string;
      risk?: number;
      duration?: number;
      theme?: string;
    }>;

    const VALID_THEMES = new Set(["forest", "ruin", "water", "cave", "town", "sky"]);
    console.log("[Adventure] _generateRumorsLLM parsed:", parsed.length, "items, first:", JSON.stringify(parsed[0]));

    return parsed
      .filter((c) => c.hook && c.location && c.risk && c.duration && c.theme)
      .map((c) => ({
        id: `rumor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        hook: c.hook!,
        location: c.location!,
        risk: Math.min(3, Math.max(1, Math.round(c.risk!))) as 1 | 2 | 3,
        duration: Math.min(15, Math.max(1, Math.round(c.duration!))),
        theme: VALID_THEMES.has(c.theme!) ? c.theme! : "forest",
      }));
  }

  private _fallbackRumors(): RumorCard[] {
    const now = Date.now();
    return [
      {
        id: `rumor-${now}-a`,
        hook: "森林深处传来奇怪的歌声...",
        location: "神秘森林",
        risk: 1,
        duration: 3,
        theme: "forest",
      },
      {
        id: `rumor-${now}-b`,
        hook: "废弃钟楼的门今天居然开了",
        location: "废弃钟楼",
        risk: 2,
        duration: 7,
        theme: "ruin",
      },
      {
        id: `rumor-${now}-c`,
        hook: "地下洞穴传来低沉的吼声...",
        location: "幽暗洞穴",
        risk: 3,
        duration: 12,
        theme: "cave",
      },
    ];
  }

  /** Get the currently cached rumor cards */
  getCachedRumors(): RumorCard[] {
    return this._cachedRumors;
  }

  // ─── Start Adventure ───

  /**
   * Start an adventure by selecting a rumor card.
   * Generates opening narrative + pre-generates all encounters via LLM.
   * Returns the adventure once LLM generation is complete (or falls back).
   */
  async startAdventure(cardId: string): Promise<Adventure | { error: string }> {
    // Check if already on an adventure
    if (this.activeAdventureId) {
      const active = this.adventures.get(this.activeAdventureId);
      if (active && active.status === "exploring") {
        return { error: "Already on an adventure" };
      }
    }

    // Find the card from cached rumors
    const card = this._cachedRumors.find((c) => c.id === cardId);
    if (!card) {
      return { error: "Rumor card not found" };
    }

    const id = `adv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const adventure: Adventure = {
      id,
      card,
      status: "exploring",
      encounters: [],
      nextEncounterIdx: 0,
      createdAt: now,
      startedAt: now,
    };

    this.adventures.set(id, adventure);
    this.activeAdventureId = id;

    // Generate opening story + encounters via LLM
    await this._generateStoryAndEncounters(adventure);

    this.save();
    this.bus.emit("adventure:started", {
      adventure: { id, location: card.location, type: "explore", duration: card.duration },
    });

    return adventure;
  }

  /**
   * Generate opening narrative + all encounters for an adventure.
   */
  private async _generateStoryAndEncounters(adventure: Adventure): Promise<void> {
    const card = adventure.card;
    const encounterCount = this._encounterCount(card.risk, card.duration);
    const durationMs = card.duration * 60 * 1000;

    if (this._llmComplete) {
      try {
        console.log("[Adventure] _generateStoryAndEncounters: calling LLM for", card.location);
        const generated = await this._generateViaLLM(card, encounterCount);
        if (generated) {
          console.log("[Adventure] LLM story generated, encounters:", generated.encounters.length);
          adventure.story = generated.story;
          adventure.encounters = generated.encounters.map((enc, i) => ({
            ...enc,
            triggerAtMs: this._encounterTiming(i, generated.encounters.length, durationMs),
          }));
          return;
        }
        console.log("[Adventure] _generateViaLLM returned null, falling back");
      } catch (err) {
        console.warn("[Adventure] _generateStoryAndEncounters LLM error:", err);
      }
    }

    // Fallback
    adventure.story = `你踏上了前往${card.location}的旅程，空气中弥漫着未知的气息...`;
    adventure.encounters = this._fallbackEncounters(encounterCount, durationMs);
  }

  private async _generateViaLLM(
    card: RumorCard,
    encounterCount: number,
  ): Promise<{ story: string; encounters: Omit<Encounter, "triggerAtMs">[] } | null> {
    if (!this._llmComplete) return null;

    const riskLabels: Record<1 | 2 | 3, string> = { 1: "安全", 2: "中等风险", 3: "危险" };
    const encounterTypeGuide = encounterCount === 1
      ? "生成1个事件，类型随机"
      : `生成${encounterCount}个事件，至少1个非narration类型`;

    const prompt = `你是一个桌面宠物的探险叙事生成器。宠物要去探险了！

探险信息：
- 线索：${card.hook}
- 地点：${card.location}
- 风险等级：${riskLabels[card.risk]}
- 时长：${card.duration}分钟
- 氛围：${card.theme}

请生成：
1. story: 2-3句话的开场叙事，用"你"来叙述，语气活泼有趣，符合地点氛围
2. encounters: ${encounterTypeGuide}

事件类型说明：
- narration: 纯叙事，text为旅途见闻描述（2-3句话）
- choice: 遇到岔路/困境，text为情景描述，choices.a和choices.b为两个选项（各10字以内）
- discovery: 发现东西，text为发现描述，reward.coins为获得金币数(5-20)

返回严格JSON（无代码块标记）：
{"story":"开场叙事...","encounters":[{"type":"narration","text":"..."},{"type":"choice","text":"...","choices":{"a":"选项A","b":"选项B"}},{"type":"discovery","text":"...","reward":{"coins":10}}]}`;

    const raw = await this._llmComplete(prompt);
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      story?: string;
      encounters?: Array<{
        type?: string;
        text?: string;
        choices?: { a?: string; b?: string };
        reward?: { item?: string; coins?: number };
      }>;
    };

    if (!parsed.story || !Array.isArray(parsed.encounters) || parsed.encounters.length === 0) {
      return null;
    }

    const VALID_TYPES = new Set(["narration", "choice", "discovery"]);
    const encounters: Omit<Encounter, "triggerAtMs">[] = parsed.encounters
      .filter((e) => e.type && VALID_TYPES.has(e.type) && e.text)
      .slice(0, encounterCount)
      .map((e, i) => {
        const base: Omit<Encounter, "triggerAtMs"> = {
          id: `enc-${Date.now()}-${i}`,
          type: e.type as "narration" | "choice" | "discovery",
          text: e.text!,
        };
        if (e.type === "choice" && e.choices?.a && e.choices?.b) {
          (base as Encounter).choices = { a: e.choices.a, b: e.choices.b };
        }
        if (e.type === "discovery" && e.reward) {
          (base as Encounter).reward = {
            coins: typeof e.reward.coins === "number" ? e.reward.coins : 10,
            item: e.reward.item,
          };
        }
        return base;
      });

    if (encounters.length === 0) return null;

    return { story: parsed.story, encounters };
  }

  /**
   * Determine encounter count based on risk and duration.
   */
  private _encounterCount(risk: 1 | 2 | 3, durationMin: number): number {
    if (risk === 1 || durationMin <= 5) return 1;
    if (risk === 2 || durationMin <= 10) return 1 + Math.round(Math.random()); // 1-2
    return 2 + Math.round(Math.random()); // 2-3
  }

  /**
   * Calculate encounter trigger time (evenly distributed, offset from start).
   */
  private _encounterTiming(index: number, total: number, durationMs: number): number {
    // Distribute encounters in the middle 60% of the adventure (20%-80%)
    const start = durationMs * 0.2;
    const range = durationMs * 0.6;
    if (total === 1) return start + range * 0.5;
    return start + (range / (total - 1)) * index;
  }

  private _fallbackEncounters(count: number, durationMs: number): Encounter[] {
    const types: Array<"narration" | "choice" | "discovery"> =
      count === 1
        ? ["discovery"]
        : count === 2
          ? ["narration", "choice"]
          : ["narration", "choice", "discovery"];

    return types.slice(0, count).map((type, i) => {
      const base: Encounter = {
        id: `enc-${Date.now()}-${i}`,
        type,
        text:
          type === "narration"
            ? "前方出现了一片奇异的景象，空气中飘来阵阵花香..."
            : type === "choice"
              ? "前方出现了两条路，一条看起来安全但绕远，另一条充满未知..."
              : "你在路边发现了一个闪闪发光的东西！",
        triggerAtMs: this._encounterTiming(i, count, durationMs),
      };
      if (type === "choice") {
        base.choices = { a: "走安全的路", b: "走未知的路" };
      }
      if (type === "discovery") {
        base.reward = { coins: 10 };
      }
      return base;
    });
  }

  // ─── Choice ───

  /**
   * Make a choice on an encounter.
   */
  makeChoice(adventureId: string, encounterId: string, choice: "a" | "b"): Adventure | { error: string } {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) return { error: "Adventure not found" };
    if (adventure.status !== "exploring") return { error: "Adventure not ongoing" };

    const encounter = adventure.encounters.find((e) => e.id === encounterId);
    if (!encounter) return { error: "Encounter not found" };
    if (encounter.type !== "choice") return { error: "Not a choice encounter" };
    if (encounter.selectedChoice) return { error: "Already chose" };
    if (!encounter.triggeredAt) return { error: "Encounter not triggered yet" };

    encounter.selectedChoice = choice;
    encounter.resolvedAt = Date.now();
    this.save();

    return adventure;
  }

  // ─── Cancel ───

  cancelAdventure(adventureId: string): { ok: boolean; reason?: string } {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) return { ok: false, reason: "Adventure not found" };
    if (adventure.status !== "exploring") return { ok: false, reason: "Adventure not ongoing" };

    adventure.status = "cancelled";
    adventure.endedAt = Date.now();
    adventure.result = {
      success: false,
      narrative: "探险被取消了。",
      rewards: { exp: 0, coins: 0 },
    };
    this.activeAdventureId = null;
    this._completing = false;
    this.save();

    this.bus.emit("adventure:cancelled", { adventure: { id: adventure.id } });

    return { ok: true };
  }

  // ─── Tick ───

  /**
   * Tick — called periodically by the engine.
   * Checks encounter triggers, choice timeouts, and adventure completion.
   */
  tick(_deltaMs: number): void {
    if (!this.activeAdventureId || this._completing) return;

    const adventure = this.adventures.get(this.activeAdventureId);
    if (!adventure || adventure.status !== "exploring") return;

    const elapsedMs = Date.now() - adventure.startedAt;
    const durationMs = adventure.card.duration * 60 * 1000;
    let dirty = false;

    // 1. Trigger pending encounters
    while (adventure.nextEncounterIdx < adventure.encounters.length) {
      const enc = adventure.encounters[adventure.nextEncounterIdx];
      if (elapsedMs < enc.triggerAtMs) break;

      enc.triggeredAt = Date.now();
      adventure.nextEncounterIdx++;
      dirty = true;

      // Auto-resolve non-choice encounters
      if (enc.type !== "choice") {
        enc.resolvedAt = Date.now();
      }

      this.bus.emit("adventure:encounter", {
        adventure: { id: adventure.id, location: adventure.card.location },
        encounter: enc,
      });
    }

    // 2. Check choice timeout (60s)
    for (const enc of adventure.encounters) {
      if (
        enc.type === "choice" &&
        enc.triggeredAt &&
        !enc.selectedChoice &&
        Date.now() - enc.triggeredAt >= CHOICE_TIMEOUT_MS
      ) {
        // Pet auto-decides
        enc.selectedChoice = Math.random() < 0.5 ? "a" : "b";
        enc.petDecided = true;
        enc.resolvedAt = Date.now();
        dirty = true;

        this.bus.emit("adventure:encounter", {
          adventure: { id: adventure.id, location: adventure.card.location },
          encounter: enc,
        });
      }
    }

    // 3. Check adventure completion
    if (elapsedMs >= durationMs) {
      // Ensure all encounters are triggered and resolved first
      for (const enc of adventure.encounters) {
        if (!enc.triggeredAt) {
          enc.triggeredAt = Date.now();
          if (enc.type !== "choice") enc.resolvedAt = Date.now();
          adventure.nextEncounterIdx = adventure.encounters.indexOf(enc) + 1;
          dirty = true;
        }
        if (enc.type === "choice" && !enc.selectedChoice) {
          enc.selectedChoice = Math.random() < 0.5 ? "a" : "b";
          enc.petDecided = true;
          enc.resolvedAt = Date.now();
          dirty = true;
        }
      }

      this._completing = true;
      void this._completeWithLLM(adventure.id).catch(() => {
        if (adventure.status === "exploring") {
          this._completeSync(adventure.id);
        }
      });
    }

    if (dirty) this.save();
  }

  // ─── Completion ───

  private async _completeWithLLM(adventureId: string): Promise<void> {
    const adventure = this.adventures.get(adventureId);
    if (!adventure || adventure.status !== "exploring") {
      this._completing = false;
      return;
    }

    const success = this._rollSuccess(adventure);
    const rewards = this._calculateRewards(adventure, success);

    let narrative: string | null = null;
    if (this._llmComplete) {
      try {
        narrative = await this._generateSettlementNarrative(adventure, success);
      } catch {
        // fall through
      }
    }

    if (!narrative) {
      narrative = this._pickFallbackNarrative(adventure, success);
    }

    // Adventure may have been cancelled during LLM call
    const current = this.adventures.get(adventureId);
    if (!current || current.status !== "exploring") {
      this._completing = false;
      return;
    }

    this._finalize(adventureId, {
      success,
      narrative,
      rewards,
      damage: success ? undefined : 10,
    });
  }

  private _completeSync(adventureId: string): void {
    const adventure = this.adventures.get(adventureId);
    if (!adventure || adventure.status !== "exploring") {
      this._completing = false;
      return;
    }

    const success = this._rollSuccess(adventure);
    const narrative = this._pickFallbackNarrative(adventure, success);
    const rewards = this._calculateRewards(adventure, success);

    this._finalize(adventureId, {
      success,
      narrative,
      rewards,
      damage: success ? undefined : 10,
    });
  }

  private _finalize(adventureId: string, result: AdventureResult): void {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) {
      this._completing = false;
      return;
    }

    adventure.status = "completed";
    adventure.endedAt = Date.now();
    adventure.result = result;
    this.activeAdventureId = null;
    this._completing = false;
    this.save();

    this.bus.emit("adventure:completed", {
      adventure: { id: adventure.id, location: adventure.card.location },
      result,
    });
  }

  private async _generateSettlementNarrative(adventure: Adventure, success: boolean): Promise<string | null> {
    if (!this._llmComplete) return null;

    const encounterSummary = adventure.encounters
      .filter((e) => e.triggeredAt)
      .map((e) => {
        if (e.type === "choice") {
          const choiceText = e.selectedChoice
            ? (e.selectedChoice === "a" ? e.choices?.a : e.choices?.b) ?? "未知"
            : "未选择";
          return `遭遇抉择: ${e.text} → 选了"${choiceText}"${e.petDecided ? "(宠物自决)" : ""}`;
        }
        if (e.type === "discovery") return `发现: ${e.text}`;
        return `途中: ${e.text}`;
      })
      .join("\n");

    const prompt = `你是一个桌面宠物的探险叙事生成器。探险结束了，请生成结局叙事。

探险信息：
- 地点：${adventure.card.location}
- 风险等级：${adventure.card.risk}星
- 开场故事：${adventure.story || "无"}
- 途中经历：
${encounterSummary || "（无特殊事件）"}
- 结果：${success ? "成功" : "失败"}

要求：
1. 用第二人称"你"叙述，语气生动有趣，3-4句话
2. 结局要与开场故事和途中经历呼应
3. 成功时描述收获和惊喜，失败时描述遗憾但要有鼓励
4. 不要提及具体数值奖励

只返回叙事文本，不要JSON包裹，不要引号。`;

    const raw = await this._llmComplete(prompt);
    if (!raw) return null;
    const cleaned = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    return cleaned.length > 10 ? cleaned : null;
  }

  private _rollSuccess(adventure: Adventure): boolean {
    let chance = SUCCESS_RATES[adventure.card.risk];

    // Choices affect success rate
    for (const enc of adventure.encounters) {
      if (enc.type === "choice" && enc.selectedChoice) {
        // "a" is generally the safer option (+10%), "b" is riskier (-10%)
        if (enc.selectedChoice === "a") chance += 0.1;
        else chance -= 0.1;
      }
    }

    return Math.random() < Math.min(1, Math.max(0, chance));
  }

  private _calculateRewards(adventure: Adventure, success: boolean): AdventureRewards {
    const base = { ...BASE_REWARDS[adventure.card.risk] };

    // Add discovery rewards
    let bonusCoins = 0;
    for (const enc of adventure.encounters) {
      if (enc.type === "discovery" && enc.reward?.coins) {
        bonusCoins += enc.reward.coins;
      }
    }

    if (!success) {
      return {
        exp: Math.floor(base.exp * 0.3),
        coins: Math.floor(base.coins * 0.3) + bonusCoins,
      };
    }

    const rewards: AdventureRewards = {
      exp: base.exp,
      coins: base.coins + bonusCoins,
    };

    // Random item drop on success
    if (Math.random() > 0.5) {
      rewards.items = [RANDOM_ITEMS[Math.floor(Math.random() * RANDOM_ITEMS.length)]];
    }

    return rewards;
  }

  private _pickFallbackNarrative(adventure: Adventure, success: boolean): string {
    const loc = adventure.card.location;
    const narratives = success
      ? [
          `探险成功！你在${loc}发现了宝藏。`,
          `经过一番探索，你安全返回，带回了不少收获。`,
          `这次冒险虽然惊险，但结果令人满意。`,
        ]
      : [
          `探险失败了，你在${loc}遇到了危险。`,
          `虽然没能达成目标，但你安全返回了。`,
          `这次冒险不太顺利，下次要更小心。`,
        ];
    return narratives[Math.floor(Math.random() * narratives.length)];
  }

  // ─── Queries ───

  getActiveAdventure(): Adventure | null {
    if (!this.activeAdventureId) return null;
    return this.adventures.get(this.activeAdventureId) ?? null;
  }

  getAdventure(adventureId: string): Adventure | undefined {
    return this.adventures.get(adventureId);
  }

  getHistory(limit: number = 10): Adventure[] {
    return Array.from(this.adventures.values())
      .filter((a) => a.status === "completed" || a.status === "cancelled")
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
      .slice(0, limit);
  }

  getStats(): { total: number; ongoing: number; completed: number; successRate: number } {
    const all = Array.from(this.adventures.values());
    const completed = all.filter((a) => a.status === "completed");
    const successful = completed.filter((a) => a.result?.success);

    return {
      total: all.length,
      ongoing: all.filter((a) => a.status === "exploring").length,
      completed: completed.length,
      successRate: completed.length > 0 ? successful.length / completed.length : 0,
    };
  }
}
