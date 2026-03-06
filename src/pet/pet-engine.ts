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
  click:      { mood: 2, intimacy: 1 },
  longpress:  { mood: 5, intimacy: 5 },
  feed:       { hunger: 35, mood: 3, intimacy: 10 },
  chat:       { mood: 3, intimacy: 3 },
  file_drop:  { mood: 5, intimacy: 8 },
  drag:       { mood: 1 },
};

// ─── Engine ───

export class PetEngine {
  readonly bus: EventBus;
  readonly attributes: AttributeEngine;
  readonly growth: GrowthSystem;
  readonly persona: PersonaEngine;
  readonly skills: SkillSystem;
  readonly learning: LearningSystem;
  readonly achievements: AchievementSystem;

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
  }

  /** Main tick — call from game loop / setInterval */
  tick(deltaMs: number): void {
    this.attributes.tick(deltaMs);
    this.learning.tick(deltaMs);
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
  }

  /** Record a tool use (for almanac + achievements) */
  recordToolUse(toolName: string): void {
    this.skills.recordTool(toolName);
    this.achievements.check();
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
      skills: this.skills.getAttributes(),
      learning: {
        active: this.learning.getActiveLesson(),
        isLearning: this.learning.isLearning(),
      },
      achievements: {
        total: this.achievements.getAll().length,
        unlocked: this.achievements.getAll().filter((a) => a.unlocked).length,
      },
    };
  }

  /** Convenience: feed the pet */
  feed(): void {
    this.interact("feed");
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
}

// ─── Factory ───

export function createPetEngine(options: PetEngineOptions): PetEngine {
  return new PetEngine(options);
}
