/**
 * Pet Engine — SkillSystem
 *
 * Tracks domain activity, triggers epiphany events, and manages
 * pet skill attribute XP growth.
 *
 * Replaces the renderer-side SkillSystem.js with a server-side engine module.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import {
  SKILL_ATTRIBUTES,
  DOMAIN_ATTR_WEIGHTS,
  isValidDomain,
  type SkillAttributeDef,
} from "./domain-system.js";

// ─── Constants ───

const ATTR_LEVEL_THRESHOLDS = [0, 50, 150, 300, 500, 750, 1050, 1400, 1800, 2250];
const ATTR_MAX_LEVEL = 10;
const EPIPHANY_COOLDOWN_MS = 24 * 3600 * 1000;
const STAR_THRESHOLDS = [1, 5, 20];

// ─── Types ───

interface DomainData {
  count: number;
  nextThreshold: number;
  recentContexts: string[];
}

interface ToolEntry {
  count: number;
  firstUsed: number;
  stars: number;
}

interface SkillPersistence {
  domains: Record<string, DomainData>;
  lastEpiphanyAt: number;
  attrs: Record<string, number>;
  tools: Record<string, ToolEntry>;
  realized: RealizedSkill[];
}

export interface RealizedSkill {
  skillName: string;
  skillTitle: string;
  skillDesc: string;
  skillContent: string;
  domainName: string;
  createdAt: number;
}

export interface EpiphanyEvent {
  domainName: string;
  recentTopics: string[];
}

export interface AttrLevelInfo {
  key: string;
  name: string;
  xp: number;
  level: number;
  pct: number;
}

// ─── SkillSystem ───

export class SkillSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _domains: Record<string, DomainData> = {};
  private _lastEpiphanyAt = 0;
  private _attrs: Record<string, number> = {};
  private _tools: Record<string, ToolEntry> = {};
  private _realized: RealizedSkill[] = [];
  private _triggering = false;

  constructor(bus: EventBus, store: PersistenceStore) {
    this._bus = bus;
    this._store = store;

    // Init attributes
    for (const a of SKILL_ATTRIBUTES) {
      this._attrs[a.key] = 0;
    }

    this._load();
  }

  // ─── Tool Tracking (for almanac display) ───

  recordTool(toolName: string): { upgraded: boolean; isNew: boolean; stars: number } | null {
    if (!toolName) return null;
    const entry = this._tools[toolName] ?? { count: 0, firstUsed: Date.now(), stars: 0 };
    entry.count++;
    const newStars = STAR_THRESHOLDS.reduce((s, t, i) => (entry.count >= t ? i + 1 : s), 0);
    const upgraded = newStars > entry.stars;
    const isNew = entry.stars === 0 && newStars >= 1;
    entry.stars = newStars;
    this._tools[toolName] = entry;
    this._save();
    if (upgraded) return { upgraded, isNew, stars: newStars };
    return null;
  }

  // ─── Domain Activity + Attribute Growth ───

  recordDomainActivity(domainName: string, context = "", weight = 1): void {
    if (!isValidDomain(domainName)) return;

    // Update domain accumulation
    if (!this._domains[domainName]) {
      this._domains[domainName] = { count: 0, nextThreshold: 5, recentContexts: [] };
    }
    const d = this._domains[domainName]!;
    d.count += weight;
    if (context) {
      d.recentContexts.push(context.slice(0, 60));
      if (d.recentContexts.length > 8) d.recentContexts = d.recentContexts.slice(-8);
    }

    // Update attribute XP
    const weights = DOMAIN_ATTR_WEIGHTS[domainName] ?? {};
    for (const attr of SKILL_ATTRIBUTES) {
      const w = weights[attr.key] ?? 0;
      if (w > 0) {
        const oldLevel = this._getAttrLevel(attr.key);
        this._attrs[attr.key] = (this._attrs[attr.key] ?? 0) + w * weight;
        const newLevel = this._getAttrLevel(attr.key);
        if (newLevel > oldLevel) {
          this._bus.emit("skill:attr-level-up", {
            key: attr.key,
            name: attr.name,
            level: newLevel,
          });
        }
      }
    }

    // Check epiphany
    this._checkEpiphany();
    this._save();
  }

  addRealized(skill: RealizedSkill): void {
    this._realized.push(skill);
    this._save();
  }

  // ─── Epiphany ───

  private _checkEpiphany(): void {
    if (this._triggering) return;
    if (Date.now() - this._lastEpiphanyAt < EPIPHANY_COOLDOWN_MS) return;

    const ready = Object.entries(this._domains)
      .filter(([, d]) => d.count >= d.nextThreshold)
      .sort((a, b) => b[1].count - b[1].nextThreshold - (a[1].count - a[1].nextThreshold));

    if (ready.length === 0) return;
    const [domainName, domainData] = ready[0]!;
    this._triggerEpiphany(domainName, domainData);
  }

  private _triggerEpiphany(domainName: string, domainData: DomainData): void {
    this._triggering = true;
    domainData.nextThreshold = domainData.count + 10;
    this._lastEpiphanyAt = Date.now();
    this._save();

    this._bus.emit("skill:epiphany", {
      domainName,
      recentTopics: [...(domainData.recentContexts ?? [])],
    });
    this._triggering = false;
  }

  // ─── Queries ───

  getAttributeXp(key: string): number {
    return this._attrs[key] ?? 0;
  }

  getAttributeLevel(key: string): number {
    return this._getAttrLevel(key);
  }

  getAttributes(): AttrLevelInfo[] {
    return SKILL_ATTRIBUTES.map((a) => {
      const xp = this._attrs[a.key] ?? 0;
      const level = this._getAttrLevel(a.key);
      const currentThreshold = ATTR_LEVEL_THRESHOLDS[level - 1] ?? 0;
      const nextThreshold = ATTR_LEVEL_THRESHOLDS[level] ?? Infinity;
      const xpInLevel = xp - currentThreshold;
      const xpForNext = nextThreshold === Infinity ? 0 : nextThreshold - currentThreshold;
      const pct = xpForNext > 0 ? Math.round((xpInLevel / xpForNext) * 100) : 100;
      return { key: a.key, name: a.name, xp, level, pct };
    });
  }

  getToolData(): Record<string, ToolEntry> {
    return { ...this._tools };
  }

  getToolStars(name: string): number {
    return this._tools[name]?.stars ?? 0;
  }

  getDomainData(name: string): DomainData | null {
    return this._domains[name] ?? null;
  }

  getRealizedSkills(): RealizedSkill[] {
    return [...this._realized];
  }

  // ─── Internal ───

  private _getAttrLevel(key: string): number {
    const xp = this._attrs[key] ?? 0;
    for (let i = ATTR_LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
      if (xp >= ATTR_LEVEL_THRESHOLDS[i]!) return Math.min(i + 1, ATTR_MAX_LEVEL);
    }
    return 1;
  }

  // ─── Persistence ───

  private _load(): void {
    const saved = this._store.load("skill-system");
    if (!saved) return;
    try {
      const data = saved as unknown as SkillPersistence;
      if (data.domains) {
        for (const [k, v] of Object.entries(data.domains)) {
          if (isValidDomain(k)) this._domains[k] = v;
        }
      }
      if (data.lastEpiphanyAt) this._lastEpiphanyAt = data.lastEpiphanyAt;
      if (data.attrs) {
        for (const a of SKILL_ATTRIBUTES) {
          if (typeof data.attrs[a.key] === "number") this._attrs[a.key] = data.attrs[a.key]!;
        }
      }
      if (data.tools) this._tools = data.tools;
      if (data.realized) this._realized = data.realized;
    } catch {
      // ignore parse errors
    }
  }

  private _save(): void {
    const data: SkillPersistence = {
      domains: this._domains,
      lastEpiphanyAt: this._lastEpiphanyAt,
      attrs: this._attrs,
      tools: this._tools,
      realized: this._realized,
    };
    this._store.save("skill-system", {
      ...data,
      updatedAt: Date.now(),
    });
  }
}
