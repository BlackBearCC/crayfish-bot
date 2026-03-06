/**
 * Pet Engine — GrowthSystem
 *
 * Manages growth stages (evolution) based on accumulated points.
 * Replaces IntimacySystem's stage logic with a more general system.
 *
 * Stages are defined by point thresholds. Points only increase (no decay).
 * Stage transitions emit events via the EventBus.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

export interface GrowthStageDef {
  threshold: number;
  name: string;
  /** Optional message shown on reaching this stage */
  milestone?: string;
}

export interface GrowthConfig {
  /** Storage key for persistence */
  key: string;
  stages: GrowthStageDef[];
}

export class GrowthSystem {
  private _config: GrowthConfig;
  private _points: number;
  private _stage: number;
  private _bus: EventBus;
  private _store: PersistenceStore;

  constructor(bus: EventBus, store: PersistenceStore, config: GrowthConfig) {
    this._bus = bus;
    this._store = store;
    this._config = config;
    this._points = 0;
    this._stage = 0;

    // Restore
    const saved = this._store.load(config.key) as { value: number } | null;
    if (saved) {
      this._points = saved.value;
      this._stage = this._resolveStage(this._points);
    }
  }

  /** Add growth points */
  gain(amount: number): void {
    if (amount <= 0) return;
    const prevStage = this._stage;
    this._points += amount;
    this._stage = this._resolveStage(this._points);
    this._save();

    if (this._stage > prevStage) {
      this._bus.emit("growth:stage-up", {
        stage: this._stage,
        name: this._config.stages[this._stage]!.name,
        prevStage,
      });
    }
  }

  get points(): number {
    return this._points;
  }

  get stage(): number {
    return this._stage;
  }

  get stageDef(): GrowthStageDef {
    return this._config.stages[this._stage]!;
  }

  get stages(): GrowthStageDef[] {
    return this._config.stages;
  }

  /** Points needed for next stage, or Infinity if at max */
  get pointsToNext(): number {
    const next = this._config.stages[this._stage + 1];
    return next ? next.threshold - this._points : Infinity;
  }

  private _resolveStage(points: number): number {
    let stage = 0;
    for (let i = 1; i < this._config.stages.length; i++) {
      if (points >= this._config.stages[i]!.threshold) {
        stage = i;
      }
    }
    return stage;
  }

  private _save(): void {
    this._store.save(this._config.key, {
      value: this._points,
      updatedAt: Date.now(),
    });
  }
}
