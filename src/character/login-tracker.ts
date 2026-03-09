/**
 * Character Engine — LoginTracker
 *
 * Tracks consecutive login days and online time per day.
 * Awards streak bonuses: +5 x N EXP (capped at +50).
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { LevelSystem } from "./level-system.js";

// ─── Persistence ───

interface LoginState {
  lastLoginDate: string;   // "2026-03-07"
  streak: number;
  onlineStartAt: number;
  todayOnlineMinutes: number;
}

const STORE_KEY = "login-tracker";
const MAX_STREAK_BONUS = 50;
const SAVE_INTERVAL_MS = 60_000; // persist online time every 60s

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isYesterday(dateStr: string): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  return dateStr === yStr;
}

// ─── System ───

export class LoginTracker {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _levels: LevelSystem;
  private _lastLoginDate: string = "";
  private _streak: number = 0;
  private _onlineStartAt: number = 0;
  private _todayOnlineMinutes: number = 0;
  private _saveAcc: number = 0;

  constructor(bus: EventBus, store: PersistenceStore, levels: LevelSystem) {
    this._bus = bus;
    this._store = store;
    this._levels = levels;

    const saved = this._store.load(STORE_KEY) as LoginState | null;
    if (saved) {
      this._lastLoginDate = saved.lastLoginDate ?? "";
      this._streak = saved.streak ?? 0;
      this._todayOnlineMinutes = saved.todayOnlineMinutes ?? 0;
    }

    this._onlineStartAt = Date.now();
    this._checkLogin();
  }

  /** Check login and update streak */
  private _checkLogin(): void {
    const today = todayStr();
    if (this._lastLoginDate === today) return; // already logged in today

    if (isYesterday(this._lastLoginDate)) {
      this._streak++;
    } else if (this._lastLoginDate !== today) {
      this._streak = 1;
    }

    this._lastLoginDate = today;
    this._todayOnlineMinutes = 0;

    // Award streak EXP
    const bonus = Math.min(MAX_STREAK_BONUS, 5 * this._streak);
    this._levels.gainExp(bonus, "login_streak");

    this._bus.emit("login:streak", { streak: this._streak, date: today });
    this._save();
  }

  /** Called periodically to accumulate online time */
  tick(): void {
    const now = Date.now();
    const elapsed = (now - this._onlineStartAt) / 60_000;
    this._onlineStartAt = now;

    // Check if day changed — if so, reset before adding elapsed
    const today = todayStr();
    if (this._lastLoginDate !== today) {
      this._checkLogin();
      // Don't carry over elapsed time from previous day
      return;
    }

    this._todayOnlineMinutes += elapsed;

    // Periodic save to avoid losing online time on crash
    this._saveAcc += elapsed * 60_000;
    if (this._saveAcc >= SAVE_INTERVAL_MS) {
      this._saveAcc = 0;
      this._save();
    }
  }

  get streak(): number {
    return this._streak;
  }

  get todayOnlineMinutes(): number {
    return Math.round(this._todayOnlineMinutes);
  }

  get lastLoginDate(): string {
    return this._lastLoginDate;
  }

  getInfo() {
    return {
      streak: this._streak,
      lastLoginDate: this._lastLoginDate,
      todayOnlineMinutes: this.todayOnlineMinutes,
    };
  }

  private _save(): void {
    this._store.save(STORE_KEY, {
      lastLoginDate: this._lastLoginDate,
      streak: this._streak,
      onlineStartAt: this._onlineStartAt,
      todayOnlineMinutes: this._todayOnlineMinutes,
    });
  }
}
