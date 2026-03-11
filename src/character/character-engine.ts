/**
 * Character Engine — Main Entry
 *
 * Composes all companion subsystems into a single engine instance.
 * This is the primary API surface for clients (desktop-pet, web widget, etc.)
 *
 * Usage:
 *   const engine = createCharacterEngine({ store, persona: '...' });
 *   engine.tick(deltaMs);              // call from game loop
 *   engine.interact('feed');           // user interaction
 *   engine.bus.on('growth:stage-up', handler);
 */

import { EventBus } from "./event-bus.js";
import { AttributeEngine, type PersistenceStore } from "./attribute-engine.js";
import { GrowthSystem, type GrowthConfig } from "./growth-system.js";
import { PersonaEngine } from "./persona-engine.js";
import { SkillSystem } from "./skill-system.js";
import { LearningSystem } from "./learning-system.js";
import { AchievementSystem } from "./achievement-system.js";
import { LevelSystem } from "./level-system.js";
import { InventorySystem } from "./inventory-system.js";
import { CareSystem } from "./care-system.js";
import { ChatEvalSystem } from "./chat-eval-system.js";
import { LoginTracker } from "./login-tracker.js";
import { DailyTaskSystem } from "./daily-task-system.js";
import { ShopSystem } from "./shop-system.js";
import { MemoryGraphSystem } from "./memory-graph.js";
import { WorldEventSystem } from "./world-event-system.js";
import { TodoSystem } from "./todo-system.js";
import { AdventureSystem } from "./adventure-system.js";
import { FirstTimeSystem } from "./first-time-system.js";
import { DEFAULT_ATTRIBUTES, GROWTH_INTIMACY } from "./presets.js";
import type { AttributeDef } from "./attribute-engine.js";

// ─── Types ───

export interface CharacterEngineOptions {
  /** Persistence adapter (localStorage wrapper, file-based, etc.) */
  store: PersistenceStore;
  /** Base persona string */
  persona?: string;
  /** Custom attribute definitions (defaults to mood/hunger/health) */
  attributes?: AttributeDef[];
  /** Custom growth config (defaults to intimacy stages) */
  growth?: GrowthConfig;
}

export interface InteractionRewards {
  [attrKey: string]: number;
}

/** Predefined interaction → reward mappings */
const INTERACTION_REWARDS: Record<string, InteractionRewards & { intimacy?: number }> = {
  click:      { mood: 3, intimacy: 1 },
  longpress:  { mood: 15, intimacy: 5 },
  feed:       { hunger: 35, mood: 20, intimacy: 10 },
  chat:       { mood: 1 },
  file_drop:  { mood: 5, intimacy: 8 },
  drag:       { mood: 1 },
};

// ─── Passive recovery constants ───

const PASSIVE_TICK_INTERVAL_MS = 30_000;

// ─── Engine ───

export class CharacterEngine {
  readonly bus: EventBus;
  readonly attributes: AttributeEngine;
  readonly growth: GrowthSystem;
  readonly persona: PersonaEngine;
  readonly skills: SkillSystem;
  readonly learning: LearningSystem;
  readonly achievements: AchievementSystem;
  readonly levels: LevelSystem;
  readonly inventory: InventorySystem;
  readonly care: CareSystem;
  readonly chatEval: ChatEvalSystem;
  readonly login: LoginTracker;
  readonly dailyTasks: DailyTaskSystem;
  readonly shop: ShopSystem;
  readonly memoryGraph: MemoryGraphSystem;
  readonly worldEvents: WorldEventSystem;
  readonly todos: TodoSystem;
  readonly adventures: AdventureSystem;
  readonly firstTime: FirstTimeSystem;

  private _passiveAcc: number = 0;

  constructor(options: CharacterEngineOptions) {
    this.bus = new EventBus();

    // Level system (must init before attributes for offline decay params)
    this.levels = new LevelSystem(this.bus, options.store);

    // Attributes (mood, hunger, health)
    this.attributes = new AttributeEngine(this.bus, options.store);
    this.attributes.setDecayMultiplier(this.levels.decayMultiplier);
    this.attributes.setMaxOfflineHours(this.levels.maxOfflineHours);
    const attrDefs = options.attributes ?? DEFAULT_ATTRIBUTES;
    for (const def of attrDefs) {
      this.attributes.register(def);
    }

    // Growth (intimacy stages)
    this.growth = new GrowthSystem(
      this.bus,
      options.store,
      options.growth ?? GROWTH_INTIMACY,
    );

    // Persona
    this.persona = new PersonaEngine(
      options.persona ?? "你是一只可爱的桌面宠物猫",
    );

    // Skills (domain tracking, epiphany, attribute XP)
    this.skills = new SkillSystem(this.bus, options.store);

    // Learning (courses, timer, XP, fragments)
    this.learning = new LearningSystem(this.bus, options.store, this.attributes);

    // Achievements (badges)
    this.achievements = new AchievementSystem(
      this.bus, options.store, this.skills, this.growth,
    );

    // Inventory
    this.inventory = new InventorySystem(
      this.bus, options.store, this.levels.inventoryCapacity,
    );

    // Care system (feed/play/rest/heal)
    this.care = new CareSystem(
      this.bus, options.store,
      this.attributes, this.growth, this.inventory, this.levels,
    );

    // Chat evaluation (LLM intent extraction)
    this.chatEval = new ChatEvalSystem(
      this.bus, options.store,
      this.attributes, this.growth, this.levels,
    );

    // Login tracker
    this.login = new LoginTracker(this.bus, options.store, this.levels);

    // Daily tasks
    this.dailyTasks = new DailyTaskSystem(
      this.bus, options.store,
      this.attributes, this.levels, this.inventory,
    );

    // Shop (wallet + store)
    this.shop = new ShopSystem(
      this.bus, options.store,
      this.inventory, this.levels,
    );

    // Wire shop into daily tasks (for coin rewards)
    this.dailyTasks.setShopSystem(this.shop);

    // Memory graph (cluster extraction + indexing)
    this.memoryGraph = new MemoryGraphSystem(options.store);

    // World events (inter-agent event queue)
    this.worldEvents = new WorldEventSystem(options.store);

    // Todo system (daily todos from chat)
    this.todos = new TodoSystem(this.bus, options.store);

    // Adventure system (exploration mechanics)
    this.adventures = new AdventureSystem(this.bus, options.store);

    // First-time user experience
    this.firstTime = new FirstTimeSystem(this.bus, options.store);

    // ─── Cross-system wiring ───

    // Level up → update decay multiplier, offline hours, inventory capacity, coin bonus
    this.bus.on("level:up", ({ level }) => {
      this.attributes.setDecayMultiplier(this.levels.decayMultiplier);
      this.attributes.setMaxOfflineHours(this.levels.maxOfflineHours);
      this.inventory.setCapacity(this.levels.inventoryCapacity);
      // Award coins: 20 × current level (design doc §9.1)
      this.shop.earnCoins(20 * level, "level_up");
    });

    // Growth stage up → award bonus EXP
    this.bus.on("growth:stage-up", ({ stage }) => {
      const bonuses = [0, 100, 200, 500];
      const bonus = bonuses[stage] ?? 0;
      if (bonus > 0) this.levels.gainExp(bonus, "growth_stage_up");
    });

    // Login streak → award coins: 5 × N (capped at 50)
    this.bus.on("login:streak", ({ streak }) => {
      const coins = Math.min(50, 5 * streak);
      this.shop.earnCoins(coins, "login_streak");
    });

    // Online 30min → award 10 coins (daily once)
    this.bus.on("login:online30min", () => {
      this.shop.earnCoins(10, "online_30min");
    });

    // Chat milestone: every 20th message → 5 coins
    this.bus.on("chat:interval", ({ count }) => {
      this.shop.earnCoins(5, `chat_milestone_${count}`);
    });

    // Online 10min → complete the "陪伴时光" newbie task
    this.bus.on("login:online10min", () => {
      if (!this.firstTime.isStepCompleted("online_10min")) {
        this.firstTime.completeStep("online_10min");
      }
    });
  }

  /** Main tick — call from game loop / setInterval */
  tick(deltaMs: number): void {
    this.attributes.tick(deltaMs);
    this.learning.tick(deltaMs);
    this.care.tick();
    this.dailyTasks.tick(deltaMs);
    this.adventures.tick(deltaMs);

    // Passive recovery (check every 30s)
    this._passiveAcc += deltaMs;
    if (this._passiveAcc >= PASSIVE_TICK_INTERVAL_MS) {
      this._passiveRecovery(this._passiveAcc);
      this._passiveAcc = 0;
    }

    // Login tracker (accumulate online time)
    this.login.tick();

    this.bus.emit("tick", { deltaMs });
  }

  /**
   * Process a user interaction.
   * Applies predefined rewards or custom rewards.
   */
  interact(action: string, customRewards?: InteractionRewards): void {
    const rewards = customRewards ?? INTERACTION_REWARDS[action] ?? {};

    for (const [key, amount] of Object.entries(rewards)) {
      if (key === "intimacy") {
        this.growth.gain(amount);
      } else {
        this.attributes.adjust(key, amount);
      }
    }

    this.bus.emit("interact", { action, payload: rewards });

    // Check achievements after interaction
    this.achievements.check();
  }

  /** Record a domain activity from chat or learning */
  recordDomainActivity(domainName: string, context?: string, weight?: number): void {
    this.skills.recordDomainActivity(domainName, context, weight);
    this.dailyTasks.incrementCounter("domainActivityCount");
  }

  /** Record a tool use (for almanac + achievements) */
  recordToolUse(toolName: string): void {
    this.skills.recordTool(toolName);
    this.achievements.check();
    this.dailyTasks.incrementCounter("toolUseCount");
  }

  /** Get a snapshot of the full companion state (for UI rendering) */
  getState(): CharacterState {
    return {
      attributes: this.attributes.getAll(),
      growth: {
        points: this.growth.points,
        stage: this.growth.stage,
        stageName: this.growth.stageDef.name,
        pointsToNext: this.growth.pointsToNext,
      },
      level: this.levels.getInfo(),
      skills: this.skills.getAttributes(),
      learning: {
        active: this.learning.getActiveLesson(),
        isLearning: this.learning.isLearning(),
      },
      achievements: {
        total: this.achievements.getAll().length,
        unlocked: this.achievements.getAll().filter((a) => a.unlocked).length,
      },
      login: this.login.getInfo(),
      resting: this.care.getRestStatus(),
      wallet: this.shop.getWallet(),
      todos: this.todos.getStats(),
      adventure: (() => {
        const adv = this.adventures.getActiveAdventure();
        return adv ? { active: true, ...adv } : { active: false };
      })(),
    };
  }

  /** Convenience: feed the character with free ration */
  feed(): void {
    this.care.feed("42号口粮");
  }

  /**
   * Build character state context fragments for LLM system prompt injection.
   * Only non-normal tiers produce fragments (zero-cost when all normal).
   * Level + intimacy are always injected (1 line each, ~40 tokens baseline).
   */
  getPromptContext(): string {
    const mood    = this.attributes.getValue("mood");
    const hunger  = this.attributes.getValue("hunger");
    const health  = this.attributes.getValue("health");
    const level   = this.levels.getInfo().level;
    const stage   = this.growth.stage;

    const fragments: string[] = [];

    // Level stage (always inject)
    fragments.push(LEVEL_FRAGMENTS[_getLevelTier(level)]);

    // Intimacy stage (always inject)
    fragments.push(INTIMACY_FRAGMENTS[_getIntimacyTier(stage)]);

    // Dynamic attributes — only non-normal tiers
    const moodTier = _getTier(mood, 30, 70);
    if (moodTier !== "normal") fragments.push(MOOD_FRAGMENTS[moodTier]);

    const hungerTier = _getTier(hunger, 60, 200);
    if (hungerTier !== "normal" && HUNGER_FRAGMENTS[hungerTier]) {
      fragments.push(HUNGER_FRAGMENTS[hungerTier]);
    }

    const healthTier = _getTier(health, 40, 80);
    if (healthTier === "low") fragments.push(HEALTH_FRAGMENTS.low);

    // Encourage agent to recall character memories during conversation
    fragments.push("你可以用 memory_search 回忆和主人相关的事情，让对话更有连续感。");

    return fragments.join("\n");
  }

  /**
   * Build a compact memory summary from top-weighted clusters.
   * Used to give sub-agents conversational context without full session history.
   */
  getMemorySummary(topN = 1): string {
    const clusters = this.memoryGraph.getClusters();
    if (clusters.length === 0) return "";

    const sorted = [...clusters].sort((a, b) => b.weight - a.weight).slice(0, topN);
    const lines: string[] = [];
    for (const c of sorted) {
      const recentFrag = c.fragments.length > 0
        ? c.fragments[c.fragments.length - 1].text
        : "";
      lines.push(`[${c.theme}] ${c.summary}${recentFrag ? ` — 最近: "${recentFrag}"` : ""}`);
    }
    return lines.join("\n");
  }

  /**
   * Passive recovery rules (applied every 30s while online):
   *  - mood >= 78 (joyful): health +0.1/min
   *  - hunger >= 225 (full): mood +0.05/min
   *  - health >= 70 + mood >= 52: small mood recovery (simulates reduced decay)
   */
  private _passiveRecovery(elapsedMs: number): void {
    const elapsedMin = elapsedMs / 60_000;

    const mood = this.attributes.getValue("mood");
    const hunger = this.attributes.getValue("hunger");
    const health = this.attributes.getValue("health");

    if (mood >= 78) {
      this.attributes.adjust("health", 0.1 * elapsedMin);
    }
    if (hunger >= 225) {
      this.attributes.adjust("mood", 0.05 * elapsedMin);
    }
    if (health >= 70 && mood >= 52) {
      this.attributes.adjust("mood", 0.02 * elapsedMin);
    }
  }
}

export interface CharacterState {
  attributes: Array<{
    key: string;
    name: string;
    value: number;
    level: string;
    max: number;
  }>;
  growth: {
    points: number;
    stage: number;
    stageName: string;
    pointsToNext: number;
  };
  level: {
    level: number;
    exp: number;
    expToNext: number;
    currentLevelExp: number;
    nextLevelExp: number;
    title: string;
    decayMultiplier: number;
    inventoryCapacity: number;
  };
  skills: Array<{
    key: string;
    name: string;
    xp: number;
    level: number;
    pct: number;
  }>;
  learning: {
    active: unknown;
    isLearning: boolean;
  };
  achievements: {
    total: number;
    unlocked: number;
  };
  login: {
    streak: number;
    lastLoginDate: string;
    todayOnlineMinutes: number;
  };
  resting: {
    resting: boolean;
    type?: string;
    endsAt?: number;
    remainingMs?: number;
  };
  wallet: {
    coins: number;
    totalEarned: number;
    totalSpent: number;
  };
  todos: {
    total: number;
    pending: number;
    completed: number;
    verified: number;
  };
  adventure: {
    active: boolean;
    id?: string;
    location?: string;
    type?: string;
    duration?: number;
  };
}

// ─── Factory ───

export function createCharacterEngine(options: CharacterEngineOptions): CharacterEngine {
  return new CharacterEngine(options);
}

// ─── Character State Prompt Builder ───

const MOOD_FRAGMENTS: Record<string, string> = {
  low:  "你现在心情很低落，说话简短消沉，不太想聊天，偶尔叹气。",
  high: "你现在心情很好，语气活泼热情，偶尔开玩笑，愿意多聊。",
};

const HUNGER_FRAGMENTS: Record<string, string> = {
  low:  "你很饿，注意力不集中，会时不时提到饿、想吃东西，回答可能敷衍。",
  high: "你刚吃饱，满足惬意，说话慢悠悠的。",
};

const HEALTH_FRAGMENTS: Record<string, string> = {
  low: "你身体不舒服，说话有气无力，希望主人关心你。",
};

const LEVEL_FRAGMENTS: Record<string, string> = {
  baby:    "你现在还很小(Lv.1-5)，对什么都好奇，说话稚嫩，经常问为什么。",
  growing: "你正在成长(Lv.6-15)，有自己的小脾气，开始有主见。",
  mature:  "你已经很成熟了(Lv.16-25)，可靠稳重，和主人很默契。",
  veteran: "你阅历丰富(Lv.26-30)，睿智从容，偶尔怀旧感慨。",
};

const INTIMACY_FRAGMENTS: Record<string, string> = {
  stranger:  "你和主人还不太熟，保持礼貌但有距离感。",
  familiar:  "你和主人已经混熟了，说话随意自然。",
  close:     "你和主人关系很亲密，会撒娇、吐槽、分享心事。",
  bonded:    "你和主人是最好的伙伴，彼此了解，默契十足。",
};

function _getTier(value: number, low: number, high: number): "low" | "normal" | "high" {
  if (value < low) return "low";
  if (value > high) return "high";
  return "normal";
}

function _getLevelTier(level: number): string {
  if (level <= 5) return "baby";
  if (level <= 15) return "growing";
  if (level <= 25) return "mature";
  return "veteran";
}

function _getIntimacyTier(stage: number): string {
  if (stage === 0) return "stranger";
  if (stage === 1) return "familiar";
  if (stage === 2) return "close";
  return "bonded";
}
