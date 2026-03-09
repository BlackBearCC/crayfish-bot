/**
 * Character Engine — ShopSystem
 *
 * Manages the star-coin (星币) wallet and in-game shop.
 * Coins are earned through gameplay only (tasks, login, level-up, achievements).
 * Shop items have daily/weekly purchase limits.
 *
 * Persistence: wallet.json + shop-purchases.json
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { InventorySystem } from "./inventory-system.js";
import type { LevelSystem } from "./level-system.js";

// ─── Types ───

export interface ShopItemDef {
  id: string;            // matches ITEM_DEFS key
  price: number;         // star-coin cost
  dailyLimit: number;    // max purchases per day (0 = unlimited)
  weeklyLimit?: number;  // max purchases per week (optional)
  unlockLevel?: number;  // minimum character level to buy (default 1)
}

export interface WalletInfo {
  coins: number;
  totalEarned: number;
  totalSpent: number;
}

export interface ShopListItem extends ShopItemDef {
  /** How many purchased today */
  todayBought: number;
  /** How many purchased this week */
  weekBought: number;
  /** Whether the player can buy right now */
  canBuy: boolean;
  /** Reason if canBuy is false */
  reason?: string;
}

export interface BuyResult {
  ok: boolean;
  reason?: string;
  wallet?: WalletInfo;
}

// ─── Shop catalog (from design doc §9.2) ───

export const SHOP_CATALOG: ShopItemDef[] = [
  { id: "babel_fish_can",  price: 30,  dailyLimit: 5 },
  { id: "gargle_blaster",  price: 80,  dailyLimit: 2 },
  { id: "dont_panic",      price: 25,  dailyLimit: 3 },
  { id: "marvin_patch",    price: 40,  dailyLimit: 3 },
  { id: "deep_thought",    price: 200, dailyLimit: 0, weeklyLimit: 1 },
];

// ─── Persistence keys ───

const WALLET_KEY = "wallet";
const PURCHASES_KEY = "shop-purchases";

// ─── Persistence shapes ───

interface WalletState {
  coins: number;
  totalEarned: number;
  totalSpent: number;
}

interface PurchaseRecord {
  /** ISO date "2026-03-08" */
  date: string;
  /** ISO week "2026-W10" */
  week: string;
  /** { itemId: count } for today */
  daily: Record<string, number>;
  /** { itemId: count } for this week */
  weekly: Record<string, number>;
}

// ─── Helpers ───

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoWeek(): string {
  const d = new Date();
  // Simple ISO week calculation
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.ceil((d.getTime() - jan1.getTime()) / 86_400_000);
  const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// ─── System ───

export class ShopSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _inventory: InventorySystem;
  private _levels: LevelSystem;

  private _coins: number = 0;
  private _totalEarned: number = 0;
  private _totalSpent: number = 0;

  private _purchaseDate: string = "";
  private _purchaseWeek: string = "";
  private _dailyPurchases: Record<string, number> = {};
  private _weeklyPurchases: Record<string, number> = {};

  constructor(
    bus: EventBus,
    store: PersistenceStore,
    inventory: InventorySystem,
    levels: LevelSystem,
  ) {
    this._bus = bus;
    this._store = store;
    this._inventory = inventory;
    this._levels = levels;

    // Load wallet
    const walletSaved = this._store.load(WALLET_KEY) as WalletState | null;
    if (walletSaved) {
      this._coins = walletSaved.coins ?? 0;
      this._totalEarned = walletSaved.totalEarned ?? 0;
      this._totalSpent = walletSaved.totalSpent ?? 0;
    }

    // Load purchase records
    const purchSaved = this._store.load(PURCHASES_KEY) as PurchaseRecord | null;
    if (purchSaved) {
      this._purchaseDate = purchSaved.date ?? "";
      this._purchaseWeek = purchSaved.week ?? "";
      this._dailyPurchases = purchSaved.daily ?? {};
      this._weeklyPurchases = purchSaved.weekly ?? {};
    }

    // Reset stale records
    this._ensureFresh();
  }

  // ─── Wallet ───

  /** Add coins (from tasks, login, achievements, level-up) */
  earnCoins(amount: number, source: string): void {
    if (amount <= 0) return;
    this._coins += amount;
    this._totalEarned += amount;
    this._bus.emit("shop:coin-earn", { amount, source, balance: this._coins });
    this._saveWallet();
  }

  /** Get current wallet info */
  getWallet(): WalletInfo {
    return {
      coins: this._coins,
      totalEarned: this._totalEarned,
      totalSpent: this._totalSpent,
    };
  }

  // ─── Shop ───

  /** List all shop items with purchase state */
  listShop(): ShopListItem[] {
    this._ensureFresh();
    const playerLevel = this._levels.level;

    return SHOP_CATALOG.map(def => {
      const todayBought = this._dailyPurchases[def.id] ?? 0;
      const weekBought = this._weeklyPurchases[def.id] ?? 0;
      const { canBuy, reason } = this._checkCanBuy(def, todayBought, weekBought, playerLevel);

      return {
        ...def,
        todayBought,
        weekBought,
        canBuy,
        reason,
      };
    });
  }

  /** Purchase an item */
  buy(itemId: string, qty: number = 1): BuyResult {
    this._ensureFresh();

    const def = SHOP_CATALOG.find(d => d.id === itemId);
    if (!def) return { ok: false, reason: "item_not_found" };

    if (qty < 1) return { ok: false, reason: "invalid_quantity" };

    const todayBought = this._dailyPurchases[def.id] ?? 0;
    const weekBought = this._weeklyPurchases[def.id] ?? 0;
    const playerLevel = this._levels.level;

    // Check each unit
    for (let i = 0; i < qty; i++) {
      const { canBuy, reason } = this._checkCanBuy(
        def, todayBought + i, weekBought + i, playerLevel,
      );
      if (!canBuy) return { ok: false, reason };
    }

    const totalCost = def.price * qty;
    if (this._coins < totalCost) {
      return { ok: false, reason: "insufficient_coins" };
    }

    // Execute purchase
    this._coins -= totalCost;
    this._totalSpent += totalCost;
    this._dailyPurchases[def.id] = todayBought + qty;
    this._weeklyPurchases[def.id] = weekBought + qty;

    // Add to inventory
    this._inventory.addItem(itemId, qty);

    this._bus.emit("shop:buy", {
      itemId,
      qty,
      totalCost,
      balance: this._coins,
    });

    this._saveWallet();
    this._savePurchases();

    return { ok: true, wallet: this.getWallet() };
  }

  // ─── Internals ───

  private _checkCanBuy(
    def: ShopItemDef,
    todayBought: number,
    weekBought: number,
    playerLevel: number,
  ): { canBuy: boolean; reason?: string } {
    if (def.unlockLevel && playerLevel < def.unlockLevel) {
      return { canBuy: false, reason: `需要 Lv.${def.unlockLevel}` };
    }
    if (def.dailyLimit > 0 && todayBought >= def.dailyLimit) {
      return { canBuy: false, reason: "今日已售罄" };
    }
    if (def.weeklyLimit && weekBought >= def.weeklyLimit) {
      return { canBuy: false, reason: "本周已售罄" };
    }
    if (this._coins < def.price) {
      return { canBuy: false, reason: "星币不足" };
    }
    return { canBuy: true };
  }

  private _ensureFresh(): void {
    const today = todayStr();
    const week = isoWeek();

    if (this._purchaseDate !== today) {
      this._purchaseDate = today;
      this._dailyPurchases = {};
    }
    if (this._purchaseWeek !== week) {
      this._purchaseWeek = week;
      this._weeklyPurchases = {};
    }
  }

  private _saveWallet(): void {
    this._store.save(WALLET_KEY, {
      coins: this._coins,
      totalEarned: this._totalEarned,
      totalSpent: this._totalSpent,
    });
  }

  private _savePurchases(): void {
    this._store.save(PURCHASES_KEY, {
      date: this._purchaseDate,
      week: this._purchaseWeek,
      daily: this._dailyPurchases,
      weekly: this._weeklyPurchases,
    });
  }
}
