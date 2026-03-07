/**
 * Pet Engine — LevelSystem
 *
 * Manages pet level (Lv.1-30) driven by EXP from various sources:
 * chat, feeding, playing, learning, daily tasks, achievements, login streaks.
 *
 * Level affects decay multiplier, unlock content, and persona enrichment.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

// ─── EXP table (cumulative EXP needed for each level) ───

export const LEVEL_EXP = [
  0,     // Lv.1
  50,    // Lv.2
  120,   // Lv.3
  220,   // Lv.4
  360,   // Lv.5
  550,   // Lv.6
  800,   // Lv.7
  1120,  // Lv.8
  1520,  // Lv.9
  2000,  // Lv.10
  2600,  // Lv.11
  3300,  // Lv.12
  4100,  // Lv.13
  5000,  // Lv.14
  6000,  // Lv.15
  7200,  // Lv.16
  8600,  // Lv.17
  10200, // Lv.18
  12000, // Lv.19
  14000, // Lv.20
  16500, // Lv.21
  19500, // Lv.22
  23000, // Lv.23
  27000, // Lv.24
  31500, // Lv.25
  36500, // Lv.26
  42000, // Lv.27
  48000, // Lv.28
  55000, // Lv.29
  63000, // Lv.30
];

export const MAX_LEVEL = 30;

// ─── Level titles ───

export interface LevelTier {
  minLevel: number;
  maxLevel: number;
  title: string;
  decayMultiplier: number;
}

export const LEVEL_TIERS: LevelTier[] = [
  { minLevel: 1,  maxLevel: 5,  title: "小萌新",   decayMultiplier: 1.0 },
  { minLevel: 6,  maxLevel: 10, title: "小帮手",   decayMultiplier: 1.0 },
  { minLevel: 11, maxLevel: 15, title: "好伙伴",   decayMultiplier: 0.85 },
  { minLevel: 16, maxLevel: 20, title: "老搭档",   decayMultiplier: 0.75 },
  { minLevel: 21, maxLevel: 25, title: "灵魂伴侣", decayMultiplier: 0.70 },
  { minLevel: 26, maxLevel: 30, title: "传说之猫", decayMultiplier: 0.60 },
];

// ─── Persistence shape ───

interface LevelState {
  exp: number;
  level: number;
}

const STORE_KEY = "level-system";

// ─── System ───

export class LevelSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _exp: number;
  private _level: number;

  constructor(bus: EventBus, store: PersistenceStore) {
    this._bus = bus;
    this._store = store;
    this._exp = 0;
    this._level = 1;

    const saved = this._store.load(STORE_KEY) as LevelState | null;
    if (saved) {
      this._exp = saved.exp ?? 0;
      this._level = saved.level ?? 1;
    }
  }

  /** Add EXP from a named source */
  gainExp(amount: number, source: string): void {
    if (amount <= 0) return;
    this._exp += amount;

    this._bus.emit("level:exp-gain", {
      amount,
      source,
      totalExp: this._exp,
    });

    // Check for level ups
    const prevLevel = this._level;
    while (this._level < MAX_LEVEL && this._exp >= LEVEL_EXP[this._level]!) {
      this._level++;
    }

    if (this._level > prevLevel) {
      this._bus.emit("level:up", {
        level: this._level,
        prevLevel,
        title: this.title,
      });
    }

    this._save();
  }

  get exp(): number {
    return this._exp;
  }

  get level(): number {
    return this._level;
  }

  get title(): string {
    return this.getTier().title;
  }

  /** EXP needed for next level (0 if max) */
  get expToNext(): number {
    if (this._level >= MAX_LEVEL) return 0;
    return LEVEL_EXP[this._level]! - this._exp;
  }

  /** EXP threshold for current level */
  get currentLevelExp(): number {
    return LEVEL_EXP[this._level - 1] ?? 0;
  }

  /** EXP threshold for next level */
  get nextLevelExp(): number {
    if (this._level >= MAX_LEVEL) return LEVEL_EXP[MAX_LEVEL - 1]!;
    return LEVEL_EXP[this._level]!;
  }

  /** Get the tier info for current level */
  getTier(): LevelTier {
    for (let i = LEVEL_TIERS.length - 1; i >= 0; i--) {
      if (this._level >= LEVEL_TIERS[i]!.minLevel) {
        return LEVEL_TIERS[i]!;
      }
    }
    return LEVEL_TIERS[0]!;
  }

  /** Decay multiplier based on current level tier */
  get decayMultiplier(): number {
    return this.getTier().decayMultiplier;
  }

  /** Inventory capacity based on level */
  get inventoryCapacity(): number {
    if (this._level >= 20) return 40;
    if (this._level >= 10) return 30;
    return 20;
  }

  /** Offline floor boost for Lv.16+ */
  get offlineFloorBoost(): boolean {
    return this._level >= 16;
  }

  /** Max offline decay hours (Lv.26+ = 2h, else 4h) */
  get maxOfflineHours(): number {
    return this._level >= 26 ? 2 : 4;
  }

  /** Get a full info snapshot for RPC */
  getInfo() {
    return {
      level: this._level,
      exp: this._exp,
      expToNext: this.expToNext,
      currentLevelExp: this.currentLevelExp,
      nextLevelExp: this.nextLevelExp,
      title: this.title,
      decayMultiplier: this.decayMultiplier,
      inventoryCapacity: this.inventoryCapacity,
    };
  }

  private _save(): void {
    this._store.save(STORE_KEY, {
      exp: this._exp,
      level: this._level,
    });
  }
}
