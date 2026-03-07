/**
 * Pet Engine — CareSystem
 *
 * Manages care actions: feed, play, rest, heal.
 * Delegates item consumption to InventorySystem,
 * attribute adjustments to AttributeEngine.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { AttributeEngine } from "./attribute-engine.js";
import type { GrowthSystem } from "./growth-system.js";
import type { InventorySystem } from "./inventory-system.js";
import type { LevelSystem } from "./level-system.js";

// ─── Play actions ───

export interface PlayAction {
  id: string;
  name: string;
  effects: { mood: number; hunger?: number; intimacy?: number };
}

export const PLAY_ACTIONS: PlayAction[] = [
  { id: "pet_stroke",     name: "抚摸",             effects: { mood: 8, intimacy: 2 } },
  { id: "improbability",  name: "无限非概率逗猫器",   effects: { mood: 15, hunger: -5, intimacy: 5 } },
  { id: "hide_seek",      name: "捉迷藏",           effects: { mood: 20, hunger: -8, intimacy: 8 } },
  { id: "sunbathe",       name: "晒太阳",           effects: { mood: 10, hunger: -2, intimacy: 3 } },
];

// ─── Rest types ───

export interface RestType {
  id: string;
  name: string;
  durationMs: number;
  effects: { health: number; mood: number };
}

export const REST_TYPES: RestType[] = [
  { id: "nap",        name: "小憩", durationMs: 15 * 60 * 1000, effects: { health: 10, mood: 5 } },
  { id: "deep_sleep", name: "深度睡眠", durationMs: 60 * 60 * 1000, effects: { health: 30, mood: 10 } },
];

// ─── Persistence ───

interface CareState {
  restEndsAt?: number;
  restType?: string;
}

const STORE_KEY = "care-cooldowns";

// ─── System ───

export class CareSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _attributes: AttributeEngine;
  private _growth: GrowthSystem;
  private _inventory: InventorySystem;
  private _levels: LevelSystem;
  private _restEndsAt: number = 0;
  private _restType: string | null = null;

  constructor(
    bus: EventBus,
    store: PersistenceStore,
    attributes: AttributeEngine,
    growth: GrowthSystem,
    inventory: InventorySystem,
    levels: LevelSystem,
  ) {
    this._bus = bus;
    this._store = store;
    this._attributes = attributes;
    this._growth = growth;
    this._inventory = inventory;
    this._levels = levels;

    const saved = this._store.load(STORE_KEY) as CareState | null;
    if (saved) {
      this._restEndsAt = saved.restEndsAt ?? 0;
      this._restType = saved.restType ?? null;
    }
  }

  /** Feed using an item from inventory */
  feed(itemId: string): { ok: boolean; reason?: string; effects?: Record<string, number> } {
    if (this.isResting()) {
      return { ok: false, reason: "pet_resting" };
    }

    const result = this._inventory.useItem(itemId);
    if (!result) {
      const cd = this._inventory.getCooldown(itemId);
      if (cd > 0) {
        return { ok: false, reason: "cooldown", effects: { cooldownRemaining: cd } };
      }
      return { ok: false, reason: "no_item" };
    }

    // Apply effects
    this._applyEffects(result.effects);

    // EXP for feeding
    this._levels.gainExp(5, "feed");

    this._bus.emit("care:action", { action: "feed", effects: result.effects });

    return { ok: true, effects: result.effects };
  }

  /** Perform a play action */
  play(actionId: string): { ok: boolean; reason?: string; effects?: Record<string, number> } {
    if (this.isResting()) {
      return { ok: false, reason: "pet_resting" };
    }

    const action = PLAY_ACTIONS.find(a => a.id === actionId);
    if (!action) return { ok: false, reason: "unknown_action" };

    // Check if hunger is sufficient for play actions that consume it
    if (action.effects.hunger && action.effects.hunger < 0) {
      const currentHunger = this._attributes.getValue("hunger");
      if (currentHunger < Math.abs(action.effects.hunger)) {
        return { ok: false, reason: "too_hungry" };
      }
    }

    const effects: Record<string, number> = {};
    for (const [k, v] of Object.entries(action.effects)) {
      if (v !== undefined) effects[k] = v as number;
    }

    this._applyEffects(effects);

    // EXP for playing
    this._levels.gainExp(4, "play");

    this._bus.emit("care:action", { action: `play:${actionId}`, effects });

    return { ok: true, effects };
  }

  /** Start resting */
  rest(typeId: string): { ok: boolean; reason?: string; endsAt?: number } {
    if (this.isResting()) {
      return { ok: false, reason: "already_resting" };
    }

    const restType = REST_TYPES.find(r => r.id === typeId);
    if (!restType) return { ok: false, reason: "unknown_rest_type" };

    this._restEndsAt = Date.now() + restType.durationMs;
    this._restType = typeId;
    this._save();

    this._bus.emit("care:rest-start", {
      type: typeId,
      durationMs: restType.durationMs,
      endsAt: this._restEndsAt,
    });

    return { ok: true, endsAt: this._restEndsAt };
  }

  /** Use a healing item */
  heal(itemId: string): { ok: boolean; reason?: string; effects?: Record<string, number> } {
    // Healing items are just inventory items with health effects
    return this.feed(itemId);
  }

  /** Check and complete rest if time is up. Called from tick(). */
  tick(): void {
    if (this._restEndsAt > 0 && Date.now() >= this._restEndsAt) {
      const restType = REST_TYPES.find(r => r.id === this._restType);
      if (restType) {
        const effects: Record<string, number> = { ...restType.effects };
        this._applyEffects(effects);
        this._bus.emit("care:rest-end", { type: this._restType!, effects });
      }
      this._restEndsAt = 0;
      this._restType = null;
      this._save();
    }
  }

  isResting(): boolean {
    if (this._restEndsAt > 0 && Date.now() < this._restEndsAt) return true;
    // Auto-clear if expired
    if (this._restEndsAt > 0) {
      this._restEndsAt = 0;
      this._restType = null;
    }
    return false;
  }

  getRestStatus(): { resting: boolean; type?: string; endsAt?: number; remainingMs?: number } {
    if (!this.isResting()) return { resting: false };
    return {
      resting: true,
      type: this._restType ?? undefined,
      endsAt: this._restEndsAt,
      remainingMs: Math.max(0, this._restEndsAt - Date.now()),
    };
  }

  private _applyEffects(effects: Record<string, number>): void {
    for (const [key, amount] of Object.entries(effects)) {
      if (key === "intimacy") {
        if (amount > 0) this._growth.gain(amount);
      } else if (key === "exp") {
        this._levels.gainExp(amount, "item");
      } else {
        this._attributes.adjust(key, amount);
      }
    }
  }

  private _save(): void {
    this._store.save(STORE_KEY, {
      restEndsAt: this._restEndsAt,
      restType: this._restType,
    });
  }
}
