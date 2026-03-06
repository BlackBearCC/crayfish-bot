/**
 * AgentStatsTracker.js
 * Agent 战绩追踪 — 记录每个子 session 的工具调用统计
 *
 * localStorage key: 'agent-stats'
 * { [sessionKey]: { sessionKey, taskName, toolUsageCount, uniqueTools[], startedAt, lastActiveAt, completedAt, activeDurationMs } }
 */

export class AgentStatsTracker {
  constructor() {
    this._data = this._load();
  }

  /**
   * 记录一次工具调用
   */
  recordTool(sessionKey, toolName, taskName) {
    if (!sessionKey || !toolName) return;
    const now = Date.now();
    const entry = this._data[sessionKey] || {
      sessionKey,
      taskName: taskName || null,
      toolUsageCount: 0,
      uniqueTools: [],
      startedAt: now,
      lastActiveAt: now,
      completedAt: null,
      activeDurationMs: 0,
    };

    entry.toolUsageCount++;
    entry.lastActiveAt = now;
    if (taskName) entry.taskName = taskName;
    if (!entry.uniqueTools.includes(toolName)) {
      entry.uniqueTools.push(toolName);
    }

    this._data[sessionKey] = entry;
    this._save();
  }

  /**
   * 记录 session 完成
   */
  recordComplete(sessionKey) {
    const entry = this._data[sessionKey];
    if (!entry) return;
    entry.completedAt = Date.now();
    entry.activeDurationMs = entry.completedAt - entry.startedAt;
    this._save();
  }

  /**
   * 获取所有记录，按 lastActiveAt 倒序
   */
  getAll() {
    return Object.values(this._data)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  }

  /**
   * 获取单个 session 记录
   */
  get(sessionKey) {
    return this._data[sessionKey] || null;
  }

  /**
   * 获取已完成的 session 总数
   */
  getTotalCompleted() {
    return Object.values(this._data).filter(e => e.completedAt).length;
  }

  _load() {
    try {
      const data = JSON.parse(localStorage.getItem('agent-stats') || '{}');
      // 清理超过 7 天的已完成记录，防止无限增长
      const cutoff = Date.now() - 7 * 86400000;
      for (const [key, entry] of Object.entries(data)) {
        if (entry.completedAt && entry.completedAt < cutoff) delete data[key];
      }
      return data;
    } catch { return {}; }
  }

  _save() {
    localStorage.setItem('agent-stats', JSON.stringify(this._data));
  }
}
