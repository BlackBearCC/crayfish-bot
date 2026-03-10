/**
 * Character Engine — InventorySystem
 *
 * Manages the character's item inventory (backpack).
 * Items have effects, cooldowns, and quantity limits.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";

// ─── Types ───

export interface ItemDef {
  id: string;
  name: string;
  icon: string;
  category: "food" | "toy" | "medicine" | "special";
  description: string;
  effects: {
    hunger?: number;
    mood?: number;
    health?: number;
    intimacy?: number;
    exp?: number;
  };
  /** Use cooldown in ms (undefined = no cooldown) */
  cooldownMs?: number;
  /** If true, item is always available and not consumed */
  permanent?: boolean;
  /** If true, item is unlimited (free, but respects cooldown) */
  unlimited?: boolean;
}

export interface InventorySlot {
  itemId: string;
  quantity: number;
  lastUsedAt?: number;
}

// ─── Item Definitions ───

export const ITEM_DEFS: Record<string, ItemDef> = {
  42号口粮: {
    id: "42号口粮",
    name: "42号口粮",
    icon: "🧊",
    category: "food",
    description: "标准口粮，免费但需要冷却。恢复75饱腹值。",
    effects: { hunger: 75, mood: 3 },
    cooldownMs: 20 * 60 * 1000,
    unlimited: true,
  },
  巴别鱼罐头: {
    id: "巴别鱼罐头",
    name: "巴别鱼罐头",
    icon: "🐠",
    category: "food",
    description: "美味的鱼罐头，恢复45饱腹值和大量心情。",
    effects: { hunger: 45, mood: 12 },
  },
  泛银河爆破饮: {
    id: "泛银河爆破饮",
    name: "泛银河爆破饮",
    icon: "🌌",
    category: "food",
    description: "强力饮料，恢复120饱腹值并提升健康。",
    effects: { hunger: 120, mood: 8, health: 5 },
  },
  不要恐慌胶囊: {
    id: "不要恐慌胶囊",
    name: "不要恐慌胶囊",
    icon: "💊",
    category: "food",
    description: "镇定胶囊，少量饱腹，提升心情和健康。",
    effects: { hunger: 30, mood: 5, health: 15 },
  },
  马文牌退烧贴: {
    id: "马文牌退烧贴",
    name: "马文牌退烧贴",
    icon: "🤖",
    category: "medicine",
    description: "退烧贴，恢复20健康值。4小时冷却。",
    effects: { health: 20 },
    cooldownMs: 4 * 3600 * 1000,
  },
  深思重启针: {
    id: "深思重启针",
    name: "深思重启针",
    icon: "💉",
    category: "medicine",
    description: "终极治疗，完全恢复健康。24小时冷却。",
    effects: { health: 100 },
    cooldownMs: 24 * 3600 * 1000,
  },
  无限非概率逗猫器: {
    id: "无限非概率逗猫器",
    name: "无限非概率逗猫器",
    icon: "🎲",
    category: "toy",
    description: "永久道具，消耗少量饱腹换取大量心情。",
    effects: { mood: 15, hunger: -5 },
    permanent: true,
  },
};

const MAX_STACK = 99;
const STORE_KEY = "inventory";

// ─── Persistence shape ───

interface InventoryState {
  slots: InventorySlot[];
}

// ─── System ───

export class InventorySystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _slots: Map<string, InventorySlot>;
  private _capacity: number;

  constructor(bus: EventBus, store: PersistenceStore, capacity: number = 20) {
    this._bus = bus;
    this._store = store;
    this._slots = new Map();
    this._capacity = capacity;

    const saved = this._store.load(STORE_KEY) as InventoryState | null;
    if (saved?.slots) {
      for (const slot of saved.slots) {
        this._slots.set(slot.itemId, slot);
      }
    }
  }

  setCapacity(capacity: number): void {
    this._capacity = capacity;
  }

  /** Add items to inventory */
  addItem(itemId: string, qty: number = 1): boolean {
    const def = ITEM_DEFS[itemId];
    if (!def) return false;
    if (def.permanent || def.unlimited) return true; // no need to store quantity

    const existing = this._slots.get(itemId);
    if (existing) {
      existing.quantity = Math.min(MAX_STACK, existing.quantity + qty);
    } else {
      if (this._slots.size >= this._capacity) return false; // full
      this._slots.set(itemId, { itemId, quantity: qty });
    }
    this._save();
    return true;
  }

  /** Use an item. Returns the effects if successful, null if failed. */
  useItem(itemId: string): { effects: Record<string, number> } | null {
    const def = ITEM_DEFS[itemId];
    if (!def) return null;

    // Check cooldown
    if (def.cooldownMs) {
      const slot = this._slots.get(itemId);
      const lastUsed = slot?.lastUsedAt ?? 0;
      if (Date.now() - lastUsed < def.cooldownMs) {
        return null; // still on cooldown
      }
    }

    // Check quantity (for non-permanent, non-unlimited items)
    if (!def.permanent && !def.unlimited) {
      const slot = this._slots.get(itemId);
      if (!slot || slot.quantity <= 0) return null;
      slot.quantity--;
      if (slot.quantity <= 0) {
        this._slots.delete(itemId);
      }
    }

    // Record cooldown
    if (def.cooldownMs) {
      const slot = this._slots.get(itemId) ?? { itemId, quantity: 0 };
      slot.lastUsedAt = Date.now();
      this._slots.set(itemId, slot);
    }

    const effects: Record<string, number> = {};
    for (const [k, v] of Object.entries(def.effects)) {
      if (v !== undefined) effects[k] = v;
    }

    this._bus.emit("inventory:use", { itemId, effects });
    this._save();
    return { effects };
  }

  /** Get cooldown remaining in ms (0 = ready) */
  getCooldown(itemId: string): number {
    const def = ITEM_DEFS[itemId];
    if (!def?.cooldownMs) return 0;
    const slot = this._slots.get(itemId);
    if (!slot?.lastUsedAt) return 0;
    return Math.max(0, def.cooldownMs - (Date.now() - slot.lastUsedAt));
  }

  /** Check if an item can be used right now */
  canUse(itemId: string): boolean {
    const def = ITEM_DEFS[itemId];
    if (!def) return false;
    if (this.getCooldown(itemId) > 0) return false;
    if (def.permanent || def.unlimited) return true;
    const slot = this._slots.get(itemId);
    return !!slot && slot.quantity > 0;
  }

  /** List all inventory items with their defs and quantities */
  list(): Array<{
    itemId: string;
    def: ItemDef;
    quantity: number;
    cooldownRemaining: number;
    canUse: boolean;
  }> {
    const result: Array<{
      itemId: string;
      def: ItemDef;
      quantity: number;
      cooldownRemaining: number;
      canUse: boolean;
    }> = [];

    // Always include permanent/unlimited items
    for (const [id, def] of Object.entries(ITEM_DEFS)) {
      if (def.permanent || def.unlimited) {
        result.push({
          itemId: id,
          def,
          quantity: -1,
          cooldownRemaining: this.getCooldown(id),
          canUse: this.canUse(id),
        });
      }
    }

    // Include owned items
    for (const [id, slot] of this._slots) {
      const def = ITEM_DEFS[id];
      if (!def || def.permanent || def.unlimited) continue;
      result.push({
        itemId: id,
        def,
        quantity: slot.quantity,
        cooldownRemaining: this.getCooldown(id),
        canUse: this.canUse(id),
      });
    }

    return result;
  }

  get capacity(): number {
    return this._capacity;
  }

  get usedSlots(): number {
    let count = 0;
    for (const [id] of this._slots) {
      const def = ITEM_DEFS[id];
      if (def?.permanent || def?.unlimited) continue;
      count++;
    }
    return count;
  }

  private _save(): void {
    const slots: InventorySlot[] = [];
    for (const [, slot] of this._slots) {
      slots.push(slot);
    }
    this._store.save(STORE_KEY, { slots });
  }
}
