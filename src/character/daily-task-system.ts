/**
 * Character Engine — DailyTaskSystem
 *
 * Generates daily tasks with 3 difficulty tiers.
 * Backend controls conditions & rewards; LLM only generates names/descriptions.
 *
 * Task composition: 2 easy + 1 medium + 1 hard = 4 tasks per day.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { AttributeEngine } from "./attribute-engine.js";
import type { LevelSystem } from "./level-system.js";
import type { InventorySystem } from "./inventory-system.js";
import type { ShopSystem } from "./shop-system.js";

// ─── Types ───

export interface TaskCondition {
  type: string;
  threshold: number;
  duration_min?: number;
}

export interface TaskReward {
  exp: number;
  coins: number;
  items: Array<{ id: string; qty: number }>;
}

export interface DailyTask {
  id: string;
  date: string;
  difficulty: "easy" | "medium" | "hard";
  name: string;
  description: string;
  condition: TaskCondition;
  reward: TaskReward;
  status: "active" | "completed" | "claimed";
  progress?: number;
}

export interface DailyCounters {
  chatCount: number;
  feedCount: number;
  onlineMinutes: number;
  clickCount: number;
  toolUseCount: number;
  domainActivityCount: number;
  moodAboveDuration: number;
  learningCompleteCount: number;
  achievementUnlockCount: number;
}

// ─── Difficulty tiers ───

interface DifficultyTier {
  id: "easy" | "medium" | "hard";
  conditionTemplates: TaskCondition[];
  rewardPool: TaskReward[];
}

const DIFFICULTY_TIERS: DifficultyTier[] = [
  {
    id: "easy",
    conditionTemplates: [
      { type: "chat_count", threshold: 3 },
      { type: "feed_count", threshold: 1 },
      { type: "online_minutes", threshold: 15 },
      { type: "click_count", threshold: 5 },
    ],
    rewardPool: [
      { exp: 8,  coins: 12, items: [] },
      { exp: 5,  coins: 10, items: [{ id: "巴别鱼罐头", qty: 1 }] },
      { exp: 10, coins: 15, items: [] },
      { exp: 6,  coins: 10, items: [{ id: "巴别鱼罐头", qty: 1 }] },
    ],
  },
  {
    id: "medium",
    conditionTemplates: [
      { type: "chat_count", threshold: 10 },
      { type: "feed_count", threshold: 3 },
      { type: "online_minutes", threshold: 60 },
      { type: "tool_use_count", threshold: 5 },
      { type: "domain_activity", threshold: 3 },
      { type: "mood_above", threshold: 70, duration_min: 30 },
    ],
    rewardPool: [
      { exp: 15, coins: 25, items: [] },
      { exp: 10, coins: 20, items: [{ id: "巴别鱼罐头", qty: 2 }] },
      { exp: 12, coins: 22, items: [{ id: "不要恐慌胶囊", qty: 1 }] },
      { exp: 18, coins: 30, items: [] },
      { exp: 10, coins: 20, items: [{ id: "马文牌退烧贴", qty: 1 }] },
    ],
  },
  {
    id: "hard",
    conditionTemplates: [
      { type: "chat_count", threshold: 25 },
      { type: "all_stats_above", threshold: 60 },
      { type: "online_minutes", threshold: 180 },
      { type: "learning_complete", threshold: 1 },
      { type: "achievement_unlock", threshold: 1 },
    ],
    rewardPool: [
      { exp: 25, coins: 45, items: [{ id: "泛银河爆破饮", qty: 1 }] },
      { exp: 20, coins: 50, items: [{ id: "巴别鱼罐头", qty: 3 }] },
      { exp: 30, coins: 60, items: [] },
      { exp: 20, coins: 40, items: [{ id: "不要恐慌胶囊", qty: 2 }] },
      { exp: 25, coins: 45, items: [{ id: "马文牌退烧贴", qty: 1 }, { id: "巴别鱼罐头", qty: 1 }] },
    ],
  },
];

// ─── Fallback names ───

const FALLBACK_NAMES: Record<string, { name: string; description: string }> = {
  chat_count:          { name: "话痨时间",     description: "和主人聊上几句吧" },
  feed_count:          { name: "美食鉴赏家",   description: "享用美味的食物" },
  online_minutes:      { name: "在线陪伴",     description: "陪伴在主人身边" },
  click_count:         { name: "摸摸头",       description: "接受主人的抚摸" },
  tool_use_count:      { name: "工具达人",     description: "帮主人使用工具" },
  domain_activity:     { name: "知识探索者",   description: "探索不同领域" },
  mood_above:          { name: "快乐时光",     description: "保持好心情" },
  learning_complete:   { name: "学海无涯",     description: "完成一节课程" },
  achievement_unlock:  { name: "成就猎人",     description: "解锁一个成就" },
  all_stats_above:     { name: "全能管家",     description: "保持所有属性良好" },
};

// ─── Persistence ───

interface DailyTaskState {
  date: string;
  tasks: DailyTask[];
  counters: DailyCounters;
}

const STORE_KEY = "daily-tasks";

// ─── LLM callback ───

export type TaskLLMCallback = (conditions: string[]) => Promise<Array<{ name: string; desc: string }>>;

// ─── System ───

export class DailyTaskSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _attributes: AttributeEngine;
  private _levels: LevelSystem;
  private _inventory: InventorySystem;
  private _shop: ShopSystem | null = null;
  private _tasks: DailyTask[] = [];
  private _counters: DailyCounters;
  private _date: string = "";
  private _llmCallback: TaskLLMCallback | null = null;
  private _moodAboveStartAt: number = 0;

  constructor(
    bus: EventBus,
    store: PersistenceStore,
    attributes: AttributeEngine,
    levels: LevelSystem,
    inventory: InventorySystem,
  ) {
    this._bus = bus;
    this._store = store;
    this._attributes = attributes;
    this._levels = levels;
    this._inventory = inventory;
    this._counters = this._emptyCounters();

    const saved = this._store.load(STORE_KEY) as DailyTaskState | null;
    if (saved) {
      this._date = saved.date ?? "";
      this._tasks = saved.tasks ?? [];
      this._counters = { ...this._emptyCounters(), ...saved.counters };
      // Reset mood_above timer if it was persisted — stale timestamps
      // would include offline time in the duration calculation.
      // The timer restarts on next tick when mood is above threshold.
      this._moodAboveStartAt = 0;
    }

    // Wire up event listeners for counter tracking
    this._bus.on("interact", (data) => {
      if (data.action === "click") this._counters.clickCount++;
      if (data.action === "chat") {
        this._counters.chatCount++;
      }
      this._checkCompletion();
      this._save();
    });

    // care:action covers feed/play — inventory:use is excluded to avoid double-counting
    // since care.feed() calls inventory.useItem() internally
    this._bus.on("care:action", (data) => {
      if (data.action === "feed") this._counters.feedCount++;
      this._checkCompletion();
      this._save();
    });
  }

  /** Wire up shop system (called after construction to avoid circular deps) */
  setShopSystem(shop: ShopSystem): void {
    this._shop = shop;
  }

  /** Set LLM callback for generating task descriptions */
  setLLMCallback(callback: TaskLLMCallback): void {
    this._llmCallback = callback;
  }

  /** Ensure tasks are generated for today */
  async ensureTodayTasks(): Promise<DailyTask[]> {
    const today = this._todayStr();
    if (this._date === today && this._tasks.length > 0) {
      return this._tasks;
    }

    // New day — reset
    this._date = today;
    this._counters = this._emptyCounters();
    this._tasks = await this._generateTasks(today);
    this._save();
    return this._tasks;
  }

  /** Increment a counter (called externally for events not covered by bus) */
  incrementCounter(key: keyof DailyCounters, amount: number = 1): void {
    (this._counters[key] as number) += amount;
    this._checkCompletion();
    this._save();
  }

  /** Claim a completed task's reward */
  claimTask(taskId: string): { ok: boolean; reason?: string; reward?: TaskReward } {
    const task = this._tasks.find(t => t.id === taskId);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.status !== "completed") return { ok: false, reason: "not_completed" };

    task.status = "claimed";

    // Award EXP
    this._levels.gainExp(task.reward.exp, "daily_task");

    // Award coins
    if (task.reward.coins > 0 && this._shop) {
      this._shop.earnCoins(task.reward.coins, "daily_task");
    }

    // Award items
    for (const item of task.reward.items) {
      this._inventory.addItem(item.id, item.qty);
    }

    this._bus.emit("daily:task-claim", { taskId, reward: task.reward });
    this._save();

    return { ok: true, reward: task.reward };
  }

  /** Get all tasks */
  getTasks(): DailyTask[] {
    return this._tasks;
  }

  /** Get counters */
  getCounters(): DailyCounters {
    return { ...this._counters };
  }

  /** Called from tick to update time-based counters */
  tick(deltaMs: number): void {
    // Online minutes
    this._counters.onlineMinutes += deltaMs / 60_000;

    // Mood above tracking
    const mood = this._attributes.getValue("mood");
    const moodThreshold = this._getActiveMoodThreshold();
    if (moodThreshold !== null && mood >= moodThreshold) {
      if (this._moodAboveStartAt === 0) {
        this._moodAboveStartAt = Date.now();
      }
      this._counters.moodAboveDuration = (Date.now() - this._moodAboveStartAt) / 60_000;
    } else {
      this._moodAboveStartAt = 0;
    }

    this._checkCompletion();
  }

  private _getActiveMoodThreshold(): number | null {
    for (const task of this._tasks) {
      if (task.status === "active" && task.condition.type === "mood_above") {
        return task.condition.threshold;
      }
    }
    return null;
  }

  private _checkCompletion(): void {
    for (const task of this._tasks) {
      if (task.status !== "active") continue;
      const completed = this._checkCondition(task.condition);
      task.progress = this._getProgress(task.condition);
      if (completed) {
        task.status = "completed";
        this._bus.emit("daily:task-complete", { taskId: task.id, difficulty: task.difficulty });
      }
    }
  }

  private _checkCondition(cond: TaskCondition): boolean {
    switch (cond.type) {
      case "chat_count":
        return this._counters.chatCount >= cond.threshold;
      case "feed_count":
        return this._counters.feedCount >= cond.threshold;
      case "online_minutes":
        return this._counters.onlineMinutes >= cond.threshold;
      case "click_count":
        return this._counters.clickCount >= cond.threshold;
      case "tool_use_count":
        return this._counters.toolUseCount >= cond.threshold;
      case "domain_activity":
        return this._counters.domainActivityCount >= cond.threshold;
      case "all_stats_above":
        return this._attributes.getAll().every(a => a.value >= cond.threshold);
      case "mood_above":
        return this._counters.moodAboveDuration >= (cond.duration_min ?? 0);
      case "learning_complete":
        return this._counters.learningCompleteCount >= cond.threshold;
      case "achievement_unlock":
        return this._counters.achievementUnlockCount >= cond.threshold;
      default:
        return false;
    }
  }

  private _getProgress(cond: TaskCondition): number {
    let current: number;
    switch (cond.type) {
      case "chat_count": current = this._counters.chatCount; break;
      case "feed_count": current = this._counters.feedCount; break;
      case "online_minutes": current = Math.round(this._counters.onlineMinutes); break;
      case "click_count": current = this._counters.clickCount; break;
      case "tool_use_count": current = this._counters.toolUseCount; break;
      case "domain_activity": current = this._counters.domainActivityCount; break;
      case "mood_above": current = Math.round(this._counters.moodAboveDuration); break;
      case "learning_complete": current = this._counters.learningCompleteCount; break;
      case "achievement_unlock": current = this._counters.achievementUnlockCount; break;
      case "all_stats_above": {
        const attrs = this._attributes.getAll();
        current = Math.min(...attrs.map(a => a.value));
        break;
      }
      default: current = 0;
    }
    return Math.min(current, cond.threshold);
  }

  private async _generateTasks(date: string): Promise<DailyTask[]> {
    // Pick conditions and rewards for each tier
    const picks: Array<{ difficulty: "easy" | "medium" | "hard"; condition: TaskCondition; reward: TaskReward }> = [];

    // 2 easy
    const easyTier = DIFFICULTY_TIERS.find(t => t.id === "easy")!;
    const easyConditions = this._pickRandom(easyTier.conditionTemplates, 2);
    for (const cond of easyConditions) {
      picks.push({
        difficulty: "easy",
        condition: cond,
        reward: this._pickOne(easyTier.rewardPool),
      });
    }

    // 1 medium
    const medTier = DIFFICULTY_TIERS.find(t => t.id === "medium")!;
    picks.push({
      difficulty: "medium",
      condition: this._pickOne(medTier.conditionTemplates),
      reward: this._pickOne(medTier.rewardPool),
    });

    // 1 hard
    const hardTier = DIFFICULTY_TIERS.find(t => t.id === "hard")!;
    picks.push({
      difficulty: "hard",
      condition: this._pickOne(hardTier.conditionTemplates),
      reward: this._pickOne(hardTier.rewardPool),
    });

    // Try LLM for names/descriptions
    let descriptions: Array<{ name: string; desc: string }> | null = null;
    if (this._llmCallback) {
      try {
        const condLabels = picks.map(p => `${p.condition.type}(${p.condition.threshold})`);
        descriptions = await this._llmCallback(condLabels);
      } catch {
        // fallback
      }
    }

    // Build tasks
    return picks.map((p, i) => {
      const fb = FALLBACK_NAMES[p.condition.type] ?? { name: "任务", description: "完成任务" };
      return {
        id: `task-${date}-${String(i + 1).padStart(3, "0")}`,
        date,
        difficulty: p.difficulty,
        name: descriptions?.[i]?.name ?? fb.name,
        description: descriptions?.[i]?.desc ?? fb.description,
        condition: p.condition,
        reward: p.reward,
        status: "active" as const,
        progress: 0,
      };
    });
  }

  private _pickRandom<T>(arr: T[], count: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  private _pickOne<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
  }

  private _emptyCounters(): DailyCounters {
    return {
      chatCount: 0,
      feedCount: 0,
      onlineMinutes: 0,
      clickCount: 0,
      toolUseCount: 0,
      domainActivityCount: 0,
      moodAboveDuration: 0,
      learningCompleteCount: 0,
      achievementUnlockCount: 0,
    };
  }

  private _todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  private _save(): void {
    this._store.save(STORE_KEY, {
      date: this._date,
      tasks: this._tasks,
      counters: this._counters,
    });
  }
}
