/**
 * Pet Engine — Main Entry
 *
 * Composes all pet subsystems into a single engine instance.
 * This is the primary API surface for clients (desktop-pet, web widget, etc.)
 *
 * Usage:
 *   const engine = createPetEngine({ store, persona: '...' });
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
import { DEFAULT_ATTRIBUTES, GROWTH_INTIMACY } from "./presets.js";
import type { AttributeDef } from "./attribute-engine.js";

// ─── Types ───

export interface PetEngineOptions {
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

export class PetEngine {
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

  private _passiveAcc: number = 0;

  constructor(options: PetEngineOptions) {
    this.bus = new EventBus();

    // Attributes (mood, hunger, health)
    this.attributes = new AttributeEngine(this.bus, options.store);
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

    // Level system
    this.levels = new LevelSystem(this.bus, options.store);

    // Apply decay multiplier from level
    this.attributes.setDecayMultiplier(this.levels.decayMultiplier);

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

    // ─── Cross-system wiring ───

    // Level up → update decay multiplier + inventory capacity
    this.bus.on("level:up", () => {
      this.attributes.setDecayMultiplier(this.levels.decayMultiplier);
      this.inventory.setCapacity(this.levels.inventoryCapacity);
    });

    // Growth stage up → award bonus EXP
    this.bus.on("growth:stage-up", ({ stage }) => {
      const bonuses = [0, 100, 200, 500];
      const bonus = bonuses[stage] ?? 0;
      if (bonus > 0) this.levels.gainExp(bonus, "growth_stage_up");
    });
  }

  /** Main tick — call from game loop / setInterval */
  tick(deltaMs: number): void {
    this.attributes.tick(deltaMs);
    this.learning.tick(deltaMs);
    this.care.tick();
    this.dailyTasks.tick(deltaMs);

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

  /** Get a snapshot of the full pet state (for UI rendering) */
  getState(): PetState {
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
    };
  }

  /** Convenience: feed the pet with free ration */
  feed(): void {
    this.care.feed("ration_42");
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

export interface PetState {
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
}

// ─── Factory ───

export function createPetEngine(options: PetEngineOptions): PetEngine {
  return new PetEngine(options);
}
