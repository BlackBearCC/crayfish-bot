/**
 * AchievementSystem.js
 * 成就系统 — 12 个徽章成就，自动检测解锁条件
 *
 * localStorage key: 'pet-achievements'
 * { [id]: { unlockedAt: number } }
 */

const CAT_KEYS = {
  search:   ['web_search', 'fetch', 'browser', 'websearch'],
  code:     ['read', 'write', 'edit', 'read_file', 'write_file'],
  terminal: ['bash', 'exec', 'shell'],
};

const ACHIEVEMENTS = [
  { id: 'first_tool',      icon: '\uD83D\uDD27', name: '\u521D\u51FA\u8305\u5E90',   desc: '\u7B2C\u4E00\u6B21\u4F7F\u7528\u5DE5\u5177',               intimacyBonus: 5,  check: ctx => ctx.totalToolUses >= 1 },
  { id: 'search_expert',   icon: '\uD83D\uDD0D', name: '\u641C\u7D22\u8FBE\u4EBA',   desc: '\u641C\u7D22\u7C7B\u5DE5\u5177\u7D2F\u8BA1\u4F7F\u7528 20 \u6B21',       intimacyBonus: 10, check: ctx => ctx.toolCountByCategory('search') >= 20 },
  { id: 'code_craftsman',  icon: '\uD83D\uDCBB', name: '\u4EE3\u7801\u5DE5\u5320',   desc: '\u4EE3\u7801\u7C7B\u5DE5\u5177\u7D2F\u8BA1\u4F7F\u7528 10 \u6B21',       intimacyBonus: 10, check: ctx => ctx.toolCountByCategory('code') >= 10 },
  { id: 'terminal_master', icon: '\u26A1',        name: '\u7EC8\u7AEF\u5927\u5E08',   desc: '\u7EC8\u7AEF\u7C7B\u5DE5\u5177\u7D2F\u8BA1\u4F7F\u7528 10 \u6B21',       intimacyBonus: 10, check: ctx => ctx.toolCountByCategory('terminal') >= 10 },
  { id: 'all_rounder',     icon: '\uD83C\uDF1F', name: '\u5168\u80FD\u52A9\u624B',   desc: '\u89E3\u9501 10 \u79CD\u4E0D\u540C\u5DE5\u5177',             intimacyBonus: 20, check: ctx => ctx.uniqueToolCount >= 10 },
  { id: 'soul_bond',       icon: '\uD83D\uDC96', name: '\u5FC3\u7075\u5951\u5408',   desc: '\u4EB2\u5BC6\u5EA6\u8FBE\u5230\u7B2C 3 \u9636\u6BB5',               intimacyBonus: 0,  check: ctx => ctx.intimacyStage >= 3 },
  { id: 'agent_commander', icon: '\uD83E\uDD16', name: '\u6307\u6325\u5B98',       desc: '\u540C\u65F6\u62E5\u6709 3 \u53EA\u4EE5\u4E0A\u5C0F\u5206\u8EAB',           intimacyBonus: 15, check: ctx => ctx.activeMiniCatCount >= 3 },
  { id: 'night_owl',       icon: '\uD83C\uDF19', name: '\u591C\u732B\u5B50',       desc: '\u5728\u6DF1\u591C (0-4\u70B9) \u4F7F\u7528\u8FC7\u5DE5\u5177',       intimacyBonus: 5,  check: ctx => ctx.usedToolAtNight },
  { id: 'file_analyst',    icon: '\uD83D\uDCC2', name: '\u6587\u4EF6\u4FA6\u63A2',   desc: '\u62D6\u653E\u5206\u6790\u6587\u4EF6 5 \u6B21\u4EE5\u4E0A',             intimacyBonus: 8,  check: ctx => ctx.fileDropCount >= 5 },
  { id: 'chat_buddy',      icon: '\uD83D\uDCAC', name: '\u8BDD\u75E8\u4F19\u4F34',   desc: '\u5B8C\u6210 20 \u6B21\u5BF9\u8BDD',                   intimacyBonus: 10, check: ctx => ctx.chatCompletionCount >= 20 },
  { id: 'speed_runner',    icon: '\uD83D\uDE80', name: '\u795E\u901F\u6267\u884C',   desc: '\u5355\u6B21\u4F1A\u8BDD\u4F7F\u7528 5 \u4E2A\u4EE5\u4E0A\u5DE5\u5177',       intimacyBonus: 12, check: ctx => ctx.maxToolsInSingleSession >= 5 },
  { id: 'web_surfer',      icon: '\uD83C\uDF10', name: '\u51B2\u6D6A\u9AD8\u624B',   desc: '\u641C\u7D22\u7C7B\u5DE5\u5177\u7D2F\u8BA1\u4F7F\u7528 10 \u6B21',       intimacyBonus: 10, check: ctx => ctx.toolCountByCategory('search') >= 10 },
];

export { ACHIEVEMENTS };

export class AchievementSystem {
  constructor(skillSystem, intimacySystem) {
    this.skillSystem = skillSystem;
    this.intimacySystem = intimacySystem;
    this._miniCatSystem = null;
    this._agentStatsTracker = null;
    this._unlocked = this._load();
    this._callbacks = [];
  }

  /**
   * 延迟注入运行时依赖（避免循环依赖）
   */
  setContext({ miniCatSystem, agentStatsTracker }) {
    this._miniCatSystem = miniCatSystem;
    this._agentStatsTracker = agentStatsTracker;
  }

  /**
   * 检查所有未解锁成就，返回新解锁列表
   */
  check() {
    const ctx = this._buildContext();
    const newlyUnlocked = [];

    for (const ach of ACHIEVEMENTS) {
      if (this._unlocked[ach.id]) continue;
      try {
        if (ach.check(ctx)) {
          this._unlocked[ach.id] = { unlockedAt: Date.now() };
          newlyUnlocked.push(ach);
          for (const cb of this._callbacks) cb(ach);
        }
      } catch { /* check 出错则跳过 */ }
    }

    if (newlyUnlocked.length > 0) this._save();
    return newlyUnlocked;
  }

  /**
   * 获取所有成就（含解锁状态）
   */
  getAll() {
    return ACHIEVEMENTS.map(ach => ({
      ...ach,
      unlocked: !!this._unlocked[ach.id],
      unlockedAt: this._unlocked[ach.id]?.unlockedAt || null,
    }));
  }

  onUnlock(cb) { this._callbacks.push(cb); }

  _buildContext() {
    const unlockData = this.skillSystem?.getToolData() || {};
    const entries = Object.entries(unlockData);

    const totalToolUses = entries.reduce((sum, [, info]) => sum + info.count, 0);
    const uniqueToolCount = entries.length;
    const intimacyStage = this.intimacySystem?.stage ?? 0;
    const activeMiniCatCount = this._miniCatSystem?.miniCats?.size ?? 0;

    // 是否在深夜使用过工具
    const usedToolAtNight = entries.some(([, info]) => {
      if (!info.firstUsed) return false;
      const h = new Date(info.firstUsed).getHours();
      return h >= 0 && h < 5;
    });

    const fileDropCount = parseInt(localStorage.getItem('pet-file-drop-count') || '0');
    const chatCompletionCount = parseInt(localStorage.getItem('pet-chat-count') || '0');

    // 单次 session 最大工具数
    const allStats = this._agentStatsTracker?.getAll() || [];
    const maxToolsInSingleSession = allStats.reduce(
      (max, e) => Math.max(max, e.toolUsageCount || 0), 0
    );

    return {
      totalToolUses,
      uniqueToolCount,
      intimacyStage,
      activeMiniCatCount,
      usedToolAtNight,
      fileDropCount,
      chatCompletionCount,
      maxToolsInSingleSession,
      toolCountByCategory: (cat) => {
        const keys = CAT_KEYS[cat] || [];
        return entries.reduce((sum, [name, info]) => {
          const lower = name.toLowerCase();
          return keys.some(k => lower.includes(k)) ? sum + info.count : sum;
        }, 0);
      },
    };
  }

  _load() {
    try { return JSON.parse(localStorage.getItem('pet-achievements') || '{}'); }
    catch { return {}; }
  }

  _save() {
    localStorage.setItem('pet-achievements', JSON.stringify(this._unlocked));
  }
}
