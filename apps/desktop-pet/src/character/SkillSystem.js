/**
 * SkillSystem.js
 * 技能系统 — 领域活跃度 + 领悟触发 + 宠物属性成长
 *
 * 驱动方式：
 *   - 对话内容 → inferDomainFromText() → recordDomainActivity()
 *   - 学习课程完成 → recordDomainActivity()（更高权重）
 *   不再由工具调用驱动（工具数据仅保留供工具图鉴使用）
 *
 * localStorage keys:
 *   skill-tools       — 工具使用记录（仅供工具图鉴）
 *   skill-domains     — 领域活跃度积累 + 上次领悟时间
 *   skill-attributes  — 宠物 5 个属性的 XP
 *   pet-realized-skills — 已领悟技能列表
 */

import { DOMAINS, ATTRIBUTES, DOMAIN_ATTR_WEIGHTS } from './DomainSystem.js';

export const EPIPHANY_TEMPLATES = [
  '{{insight}}',
  '（发呆了一会儿）{{insight}}',
  '嗯... {{insight}}',
  '（眯起眼睛）{{insight}}',
];

const STAR_THRESHOLDS = [1, 5, 20]; // 工具图鉴星级阈值（保持不变）

// 属性 XP 每级所需积分
const ATTR_LEVEL_THRESHOLDS = [0, 50, 150, 300, 500, 750, 1050, 1400, 1800, 2250];
const ATTR_MAX_LEVEL = 10;

// 合法领域名集合（模块级常量，避免构造器内重复创建）
const VALID_DOMAIN_NAMES = new Set(DOMAINS.map(d => d.name));

export class SkillSystem {
  constructor() {
    // 工具使用记录（仅供图鉴展示，不影响技能/属性）
    this._tools = JSON.parse(localStorage.getItem('skill-tools') || 'null')
      || JSON.parse(localStorage.getItem('skill-unlocks') || '{}');

    // 领域活跃度积累（迁移旧数据：丢弃旧工具分类名，只保留合法领域名）
    const savedDomains = JSON.parse(localStorage.getItem('skill-domains') || 'null');
    const rawDomains = savedDomains?.domains || savedDomains || {};
    this._domains = {};
    for (const [k, v] of Object.entries(rawDomains)) {
      if (VALID_DOMAIN_NAMES.has(k)) this._domains[k] = v;
    }
    this._lastEpiphanyAt = savedDomains?.lastEpiphanyAt || 0;

    // 宠物属性 XP
    const savedAttrs = JSON.parse(localStorage.getItem('skill-attributes') || 'null');
    this._attrs = savedAttrs || {};
    for (const a of ATTRIBUTES) {
      if (this._attrs[a.key] === undefined) this._attrs[a.key] = 0;
    }

    // 已领悟技能列表
    this._realized = JSON.parse(localStorage.getItem('pet-realized-skills') || '[]');

    this._unlockCallbacks = [];   // 工具升星（保留，供成就系统用）
    this._epiphanyCallbacks = []; // 领域领悟触发
    this._attrLevelUpCallbacks = [];
    this._triggering = false;
  }

  // ===== 工具图鉴（仅统计，不影响技能领域） =====

  /**
   * 记录工具使用次数（仅更新工具图鉴星级）
   * @param {string} toolName
   */
  recordTool(toolName) {
    if (!toolName) return;
    const entry = this._tools[toolName] || { count: 0, firstUsed: Date.now(), stars: 0 };
    entry.count++;
    const newStars = STAR_THRESHOLDS.reduce((s, t, i) => entry.count >= t ? i + 1 : s, 0);
    const upgraded = newStars > entry.stars;
    const isNew = entry.stars === 0 && newStars >= 1;
    entry.stars = newStars;
    this._tools[toolName] = entry;

    if (upgraded) {
      for (const cb of this._unlockCallbacks) cb({ toolName, stars: newStars, isNew });
    }

    this._saveTools();
  }

  // ===== 领域活动 + 属性成长 =====

  /**
   * 记录一次领域活动（由对话分析或学习完成触发）
   * @param {string} domainName  — 7 个生活领域之一
   * @param {string} [context]   — 活动描述/话题摘要（用于领悟生成）
   * @param {number} [weight=1]  — 权重倍数（学习完成传 3，普通对话传 1）
   */
  recordDomainActivity(domainName, context = '', weight = 1) {
    if (!VALID_DOMAIN_NAMES.has(domainName)) return;

    // 1. 更新领域积累
    if (!this._domains[domainName]) {
      this._domains[domainName] = { count: 0, nextThreshold: 5, recentContexts: [] };
    }
    const d = this._domains[domainName];
    d.count += weight;
    if (context) {
      d.recentContexts = d.recentContexts || [];
      d.recentContexts.push(context.slice(0, 60));
      if (d.recentContexts.length > 8) d.recentContexts = d.recentContexts.slice(-8);
    }

    // 2. 更新属性 XP
    const weights = DOMAIN_ATTR_WEIGHTS[domainName] || {};
    const attrLevelUps = [];
    for (const attr of ATTRIBUTES) {
      const w = weights[attr.key] || 0;
      if (w > 0) {
        const oldLevel = this._getAttrLevel(attr.key);
        this._attrs[attr.key] = (this._attrs[attr.key] || 0) + w * weight;
        const newLevel = this._getAttrLevel(attr.key);
        if (newLevel > oldLevel) attrLevelUps.push({ key: attr.key, name: attr.name, level: newLevel });
      }
    }

    // 3. 检查领悟
    this._checkEpiphany();

    this._save();

    // 4. 属性升级回调（存档后触发）
    for (const info of attrLevelUps) {
      for (const cb of this._attrLevelUpCallbacks) cb(info);
    }
  }

  /** 存入一条领悟技能 */
  addRealized(skillData) {
    this._realized.push(skillData);
    localStorage.setItem('pet-realized-skills', JSON.stringify(this._realized));
  }

  // ===== 领悟触发 =====

  _checkEpiphany() {
    if (this._triggering) return;
    if (Date.now() - this._lastEpiphanyAt < 24 * 3600 * 1000) return;

    const ready = Object.entries(this._domains)
      .filter(([, d]) => d.count >= d.nextThreshold)
      .sort((a, b) => (b[1].count - b[1].nextThreshold) - (a[1].count - a[1].nextThreshold));

    if (ready.length === 0) return;
    const [domainName, domainData] = ready[0];
    this._triggerEpiphany(domainName, domainData);
  }

  _triggerEpiphany(domainName, domainData) {
    this._triggering = true;
    this._domains[domainName].nextThreshold = domainData.count + 10;
    this._lastEpiphanyAt = Date.now();
    this._save();

    const recentTopics = [...(domainData.recentContexts || [])];
    for (const cb of this._epiphanyCallbacks) cb({ domainName, recentTopics });
    this._triggering = false;
  }

  // ===== 属性查询 =====

  getAttributeXp(key) { return this._attrs[key] || 0; }

  _getAttrLevel(key) {
    const xp = this._attrs[key] || 0;
    for (let i = ATTR_LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
      if (xp >= ATTR_LEVEL_THRESHOLDS[i]) return Math.min(i + 1, ATTR_MAX_LEVEL);
    }
    return 1;
  }

  getAttributeLevel(key) { return this._getAttrLevel(key); }

  /** 返回所有属性的完整状态 */
  getAttributes() {
    return ATTRIBUTES.map(a => {
      const xp = this._attrs[a.key] || 0;
      const level = this._getAttrLevel(a.key);
      const currentThreshold = ATTR_LEVEL_THRESHOLDS[level - 1] || 0;
      const nextThreshold = ATTR_LEVEL_THRESHOLDS[level] || Infinity;
      const xpInLevel = xp - currentThreshold;
      const xpForNext = nextThreshold === Infinity ? 0 : nextThreshold - currentThreshold;
      const pct = xpForNext > 0 ? Math.round((xpInLevel / xpForNext) * 100) : 100;
      return { ...a, xp, level, pct };
    });
  }

  // ===== 领域数据查询 =====

  /** 返回指定领域的活跃度数据（供 SkillPanel 生成课程时使用） */
  getDomainData(name) { return this._domains[name] || null; }

  // ===== 工具图鉴查询 =====

  getToolData() { return this._tools; }
  getToolStars(name) { return this._tools[name]?.stars || 0; }
  isToolUnlocked(name) { return (this._tools[name]?.stars || 0) >= 1; }

  // ===== 技能查询 =====

  getRealizedSkills() { return this._realized; }

  // ===== 回调注册 =====

  onUnlock(cb) { this._unlockCallbacks.push(cb); }
  onEpiphany(cb) { this._epiphanyCallbacks.push(cb); }
  onAttrLevelUp(cb) { this._attrLevelUpCallbacks.push(cb); }

  // ===== 工具方法 =====

  static renderBubble(insight, template = null) {
    const tpl = template || EPIPHANY_TEMPLATES[Math.floor(Math.random() * EPIPHANY_TEMPLATES.length)];
    return tpl.replace('{{insight}}', insight);
  }

  // ===== 持久化 =====

  _saveTools() {
    localStorage.setItem('skill-tools', JSON.stringify(this._tools));
  }

  _save() {
    localStorage.setItem('skill-domains', JSON.stringify({
      domains: this._domains,
      lastEpiphanyAt: this._lastEpiphanyAt,
    }));
    localStorage.setItem('skill-attributes', JSON.stringify(this._attrs));
  }
}
