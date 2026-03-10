/**
 * Adventure System — Exploration and adventure mechanics
 *
 * AI can start adventures (idle/interactive/explore modes).
 * Adventures generate rewards and narratives based on character state.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

// ─── Types ───

export type AdventureType = "idle" | "interactive" | "explore";
export type AdventureRisk = "safe" | "moderate" | "dangerous";
export type AdventureStatus = "ongoing" | "completed";

export interface AdventureRewards {
  exp: number;
  coins: number;
  items?: string[];
}

export interface AdventureChoice {
  id: string;
  text: string;
}

export interface AdventureResult {
  success: boolean;
  narrative: string;
  rewards: AdventureRewards;
  damage?: number;
}

export interface Adventure {
  id: string;
  type: AdventureType;
  location: string;
  duration: number; // minutes
  status: AdventureStatus;
  risk: AdventureRisk;
  rewards: AdventureRewards;
  story?: string;
  choices?: AdventureChoice[];
  selectedChoice?: string;
  result?: AdventureResult;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface AdventureSystemConfig {
  maxActiveAdventures?: number;
  baseRewards?: {
    safe: AdventureRewards;
    moderate: AdventureRewards;
    dangerous: AdventureRewards;
  };
}

const DEFAULT_CONFIG: Required<AdventureSystemConfig> = {
  maxActiveAdventures: 1,
  baseRewards: {
    safe: { exp: 20, coins: 10 },
    moderate: { exp: 50, coins: 25 },
    dangerous: { exp: 100, coins: 50 },
  },
};

// ─── Adventure System ───

export class AdventureSystem {
  private readonly bus: EventBus;
  private readonly store: PersistenceStore;
  private readonly config: Required<AdventureSystemConfig>;
  private adventures: Map<string, Adventure> = new Map();
  private activeAdventureId: string | null = null;

  constructor(
    bus: EventBus,
    store: PersistenceStore,
    config?: AdventureSystemConfig
  ) {
    this.bus = bus;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.load();
  }

  private load(): void {
    const data = this.store.load("adventure-system");
    if (data?.adventures) {
      const list = data.adventures as Adventure[];
      for (const adv of list) {
        this.adventures.set(adv.id, adv);
        if (adv.status === "ongoing") {
          this.activeAdventureId = adv.id;
        }
      }
    }
  }

  private save(): void {
    // Trim completed adventures to last 50 to prevent unbounded growth
    const completed = Array.from(this.adventures.values())
      .filter((a) => a.status === "completed")
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
    if (completed.length > 50) {
      for (const adv of completed.slice(50)) {
        this.adventures.delete(adv.id);
      }
    }

    this.store.save("adventure-system", {
      adventures: Array.from(this.adventures.values()),
    });
  }

  /**
   * Start a new adventure
   */
  startAdventure(params: {
    type: AdventureType;
    location: string;
    duration: number;
    risk: AdventureRisk;
    story?: string;
    choices?: AdventureChoice[];
  }): Adventure | { error: string } {
    // Check if already on an adventure
    if (this.activeAdventureId) {
      const active = this.adventures.get(this.activeAdventureId);
      if (active && active.status === "ongoing") {
        return { error: "Already on an adventure" };
      }
    }

    const id = `adv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const adventure: Adventure = {
      id,
      type: params.type,
      location: params.location,
      duration: params.duration,
      status: "ongoing",
      risk: params.risk,
      rewards: this.config.baseRewards[params.risk],
      story: params.story,
      choices: params.choices,
      createdAt: Date.now(),
      startedAt: Date.now(),
    };

    this.adventures.set(id, adventure);
    this.activeAdventureId = id;
    this.save();

    this.bus.emit("adventure:started", { adventure });

    return adventure;
  }

  /**
   * Make a choice in an interactive adventure
   */
  makeChoice(adventureId: string, choiceId: string): Adventure | { error: string } {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) {
      return { error: "Adventure not found" };
    }

    if (adventure.status !== "ongoing") {
      return { error: "Adventure not ongoing" };
    }

    if (adventure.type !== "interactive") {
      return { error: "Not an interactive adventure" };
    }

    adventure.selectedChoice = choiceId;
    this.save();

    this.bus.emit("adventure:choice", { adventure, choiceId });

    return adventure;
  }

  /**
   * Complete an adventure with results
   */
  completeAdventure(adventureId: string, result?: AdventureResult): Adventure | { error: string } {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) {
      return { error: "Adventure not found" };
    }

    if (adventure.status !== "ongoing") {
      return { error: "Adventure not ongoing" };
    }

    // Generate result if not provided
    const finalResult: AdventureResult = result ?? this.generateResult(adventure);

    adventure.status = "completed";
    adventure.endedAt = Date.now();
    adventure.result = finalResult;
    this.activeAdventureId = null;
    this.save();

    this.bus.emit("adventure:completed", { adventure, result: finalResult });

    return adventure;
  }

  /**
   * Generate adventure result based on risk and choices
   */
  private generateResult(adventure: Adventure): AdventureResult {
    // Base success chance based on risk
    const successChances: Record<AdventureRisk, number> = {
      safe: 0.9,
      moderate: 0.7,
      dangerous: 0.5,
    };

    let successChance = successChances[adventure.risk];

    // Modify based on choice position (if interactive)
    // First choice = safer (+0.1), last choice = riskier (-0.1), middle = neutral
    if (adventure.selectedChoice && adventure.choices?.length) {
      const idx = adventure.choices.findIndex((c) => c.id === adventure.selectedChoice);
      if (idx === 0) successChance += 0.1;
      else if (idx === adventure.choices.length - 1) successChance -= 0.1;
    }

    const success = Math.random() < successChance;

    // Generate narrative
    const narratives = success
      ? [
          `探险成功！你在${adventure.location}发现了宝藏。`,
          `经过一番探索，你安全返回，带回了不少收获。`,
          `这次冒险虽然惊险，但结果令人满意。`,
        ]
      : [
          `探险失败了，你在${adventure.location}遇到了危险。`,
          `虽然没能达成目标，但你安全返回了。`,
          `这次冒险不太顺利，下次要更小心。`,
        ];

    const narrative = narratives[Math.floor(Math.random() * narratives.length)];

    // Calculate rewards
    let rewards: AdventureRewards = { ...adventure.rewards };
    if (!success) {
      rewards = {
        exp: Math.floor(rewards.exp * 0.3),
        coins: Math.floor(rewards.coins * 0.3),
      };
    }

    // Add random items on success
    if (success && Math.random() > 0.5) {
      const items = ["神秘种子", "古旧硬币", "闪光石头", "奇异草药"];
      rewards.items = [items[Math.floor(Math.random() * items.length)]];
    }

    return {
      success,
      narrative,
      rewards,
      damage: success ? undefined : 10,
    };
  }

  /**
   * Cancel an ongoing adventure
   */
  cancelAdventure(adventureId: string): { ok: boolean; reason?: string } {
    const adventure = this.adventures.get(adventureId);
    if (!adventure) {
      return { ok: false, reason: "Adventure not found" };
    }

    if (adventure.status !== "ongoing") {
      return { ok: false, reason: "Adventure not ongoing" };
    }

    adventure.status = "completed";
    adventure.endedAt = Date.now();
    adventure.result = {
      success: false,
      narrative: "探险被取消了。",
      rewards: { exp: 0, coins: 0 },
    };
    this.activeAdventureId = null;
    this.save();

    this.bus.emit("adventure:cancelled", { adventure });

    return { ok: true };
  }

  /**
   * Tick - called periodically to check adventure completion
   */
  tick(_deltaMs: number): void {
    if (!this.activeAdventureId) return;

    const adventure = this.adventures.get(this.activeAdventureId);
    if (!adventure || adventure.status !== "ongoing") return;

    // Check if adventure duration has elapsed
    const elapsedMs = Date.now() - (adventure.startedAt ?? adventure.createdAt);
    const durationMs = adventure.duration * 60 * 1000;

    if (elapsedMs >= durationMs) {
      this.completeAdventure(adventure.id);
    }
  }

  /**
   * Get adventure by ID
   */
  getAdventure(adventureId: string): Adventure | undefined {
    return this.adventures.get(adventureId);
  }

  /**
   * Get active adventure
   */
  getActiveAdventure(): Adventure | null {
    if (!this.activeAdventureId) return null;
    return this.adventures.get(this.activeAdventureId) ?? null;
  }

  /**
   * Get all adventures
   */
  getAdventures(): Adventure[] {
    return Array.from(this.adventures.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get adventure history
   */
  getHistory(limit: number = 10): Adventure[] {
    return this.getAdventures()
      .filter((a) => a.status === "completed")
      .slice(0, limit);
  }

  /**
   * Get adventure stats
   */
  getStats(): {
    total: number;
    ongoing: number;
    completed: number;
    successRate: number;
  } {
    const all = this.getAdventures();
    const completed = all.filter((a) => a.status === "completed");
    const successful = completed.filter((a) => a.result?.success);

    return {
      total: all.length,
      ongoing: all.filter((a) => a.status === "ongoing").length,
      completed: completed.length,
      successRate: completed.length > 0 ? successful.length / completed.length : 0,
    };
  }
}
