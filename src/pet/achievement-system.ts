/**
 * Pet Engine — AchievementSystem
 *
 * 12 achievement badges with auto-detection conditions.
 * Replaces the renderer-side AchievementSystem.js.
 */

import type { EventBus } from "./event-bus.js";
import type { PersistenceStore } from "./attribute-engine.js";
import type { SkillSystem } from "./skill-system.js";
import type { GrowthSystem } from "./growth-system.js";

// ─── Types ───

interface AchievementContext {
  totalToolUses: number;
  uniqueToolCount: number;
  intimacyStage: number;
  activeMiniCatCount: number;
  usedToolAtNight: boolean;
  fileDropCount: number;
  chatCompletionCount: number;
  maxToolsInSingleSession: number;
  toolCountByCategory: (cat: string) => number;
}

interface AchievementDef {
  id: string;
  icon: string;
  name: string;
  desc: string;
  intimacyBonus: number;
  check: (ctx: AchievementContext) => boolean;
}

const CAT_KEYS: Record<string, string[]> = {
  search: ["web_search", "fetch", "browser", "websearch"],
  code: ["read", "write", "edit", "read_file", "write_file"],
  terminal: ["bash", "exec", "shell"],
};

const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first_tool", icon: "🔧", name: "初出茅庐", desc: "第一次使用工具", intimacyBonus: 5, check: (ctx) => ctx.totalToolUses >= 1 },
  { id: "search_expert", icon: "🔍", name: "搜索达人", desc: "搜索类工具累计使用 20 次", intimacyBonus: 10, check: (ctx) => ctx.toolCountByCategory("search") >= 20 },
  { id: "code_craftsman", icon: "💻", name: "代码工匠", desc: "代码类工具累计使用 10 次", intimacyBonus: 10, check: (ctx) => ctx.toolCountByCategory("code") >= 10 },
  { id: "terminal_master", icon: "⚡", name: "终端大师", desc: "终端类工具累计使用 10 次", intimacyBonus: 10, check: (ctx) => ctx.toolCountByCategory("terminal") >= 10 },
  { id: "all_rounder", icon: "🌟", name: "全能助手", desc: "解锁 10 种不同工具", intimacyBonus: 20, check: (ctx) => ctx.uniqueToolCount >= 10 },
  { id: "soul_bond", icon: "💖", name: "心灵契合", desc: "亲密度达到第 3 阶段", intimacyBonus: 0, check: (ctx) => ctx.intimacyStage >= 3 },
  { id: "agent_commander", icon: "🤖", name: "指挥官", desc: "同时拥有 3 只以上小分身", intimacyBonus: 15, check: (ctx) => ctx.activeMiniCatCount >= 3 },
  { id: "night_owl", icon: "🌙", name: "夜猫子", desc: "在深夜 (0-4点) 使用过工具", intimacyBonus: 5, check: (ctx) => ctx.usedToolAtNight },
  { id: "file_analyst", icon: "📂", name: "文件侦探", desc: "拖放分析文件 5 次以上", intimacyBonus: 8, check: (ctx) => ctx.fileDropCount >= 5 },
  { id: "chat_buddy", icon: "💬", name: "话痨伙伴", desc: "完成 20 次对话", intimacyBonus: 10, check: (ctx) => ctx.chatCompletionCount >= 20 },
  { id: "speed_runner", icon: "🚀", name: "神速执行", desc: "单次会话使用 5 个以上工具", intimacyBonus: 12, check: (ctx) => ctx.maxToolsInSingleSession >= 5 },
  { id: "web_surfer", icon: "🌐", name: "冲浪高手", desc: "搜索类工具累计使用 10 次", intimacyBonus: 10, check: (ctx) => ctx.toolCountByCategory("search") >= 10 },
];

interface UnlockRecord {
  [id: string]: { unlockedAt: number };
}

interface AchievementPersistence {
  unlocked: UnlockRecord;
  counters: {
    fileDropCount: number;
    chatCompletionCount: number;
    maxToolsInSingleSession: number;
  };
}

// ─── AchievementSystem ───

export class AchievementSystem {
  private _bus: EventBus;
  private _store: PersistenceStore;
  private _skillSystem: SkillSystem;
  private _growthSystem: GrowthSystem;
  private _unlocked: UnlockRecord = {};
  private _fileDropCount = 0;
  private _chatCompletionCount = 0;
  private _maxToolsInSingleSession = 0;
  private _activeMiniCatCount = 0;

  constructor(bus: EventBus, store: PersistenceStore, skillSystem: SkillSystem, growthSystem: GrowthSystem) {
    this._bus = bus;
    this._store = store;
    this._skillSystem = skillSystem;
    this._growthSystem = growthSystem;
    this._load();
  }

  /** Update runtime context from external sources */
  updateContext(ctx: { activeMiniCatCount?: number; maxToolsInSingleSession?: number }): void {
    if (ctx.activeMiniCatCount !== undefined) this._activeMiniCatCount = ctx.activeMiniCatCount;
    if (ctx.maxToolsInSingleSession !== undefined) {
      this._maxToolsInSingleSession = Math.max(this._maxToolsInSingleSession, ctx.maxToolsInSingleSession);
    }
  }

  incrementFileDropCount(): void {
    this._fileDropCount++;
    this._save();
  }

  incrementChatCount(): void {
    this._chatCompletionCount++;
    this._save();
  }

  /** Check all achievements, return newly unlocked ones */
  check(): AchievementDef[] {
    const ctx = this._buildContext();
    const newlyUnlocked: AchievementDef[] = [];

    for (const ach of ACHIEVEMENTS) {
      if (this._unlocked[ach.id]) continue;
      try {
        if (ach.check(ctx)) {
          this._unlocked[ach.id] = { unlockedAt: Date.now() };
          newlyUnlocked.push(ach);
        }
      } catch {
        // skip
      }
    }

    if (newlyUnlocked.length > 0) this._save();
    return newlyUnlocked;
  }

  getAll(): Array<AchievementDef & { unlocked: boolean; unlockedAt: number | null }> {
    return ACHIEVEMENTS.map((ach) => ({
      ...ach,
      unlocked: !!this._unlocked[ach.id],
      unlockedAt: this._unlocked[ach.id]?.unlockedAt ?? null,
    }));
  }

  private _buildContext(): AchievementContext {
    const toolData = this._skillSystem.getToolData();
    const entries = Object.entries(toolData);
    const totalToolUses = entries.reduce((sum, [, info]) => sum + info.count, 0);
    const uniqueToolCount = entries.length;

    const usedToolAtNight = entries.some(([, info]) => {
      if (!info.firstUsed) return false;
      const h = new Date(info.firstUsed).getHours();
      return h >= 0 && h < 5;
    });

    return {
      totalToolUses,
      uniqueToolCount,
      intimacyStage: this._growthSystem.stage,
      activeMiniCatCount: this._activeMiniCatCount,
      usedToolAtNight,
      fileDropCount: this._fileDropCount,
      chatCompletionCount: this._chatCompletionCount,
      maxToolsInSingleSession: this._maxToolsInSingleSession,
      toolCountByCategory: (cat: string) => {
        const keys = CAT_KEYS[cat] ?? [];
        return entries.reduce((sum, [name, info]) => {
          const lower = name.toLowerCase();
          return keys.some((k) => lower.includes(k)) ? sum + info.count : sum;
        }, 0);
      },
    };
  }

  // ─── Persistence ───

  private _load(): void {
    const saved = this._store.load("achievement-system");
    if (!saved) return;
    try {
      const data = saved as unknown as AchievementPersistence;
      if (data.unlocked) this._unlocked = data.unlocked;
      if (data.counters) {
        this._fileDropCount = data.counters.fileDropCount ?? 0;
        this._chatCompletionCount = data.counters.chatCompletionCount ?? 0;
        this._maxToolsInSingleSession = data.counters.maxToolsInSingleSession ?? 0;
      }
    } catch {
      // ignore
    }
  }

  private _save(): void {
    const data: AchievementPersistence = {
      unlocked: this._unlocked,
      counters: {
        fileDropCount: this._fileDropCount,
        chatCompletionCount: this._chatCompletionCount,
        maxToolsInSingleSession: this._maxToolsInSingleSession,
      },
    };
    this._store.save("achievement-system", {
      ...data,
      updatedAt: Date.now(),
    });
  }
}
