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

  constructor(options: PetEngineOptions) {
    this.bus = new EventBus();

    // Attributes
    this.attributes = new AttributeEngine(this.bus, options.store);
    const attrDefs = options.attributes ?? DEFAULT_ATTRIBUTES;
    for (const def of attrDefs) {
      this.attributes.register(def);
    }

    // Growth
    this.growth = new GrowthSystem(
      this.bus,
      options.store,
      options.growth ?? GROWTH_INTIMACY,
    );

    // Persona
    this.persona = new PersonaEngine(
      options.persona ?? "你是一只可爱的桌面宠物猫",
    );
  }

  /** Main tick — call from game loop / setInterval */
  tick(deltaMs: number): void {
    this.attributes.tick(deltaMs);
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
}

// ─── Factory ───

export function createPetEngine(options: PetEngineOptions): PetEngine {
  return new PetEngine(options);
}
