/**
 * MoodSystem.js
 * 心情值系统 — 宠物情感状态管理
 *
 * 心情值 0-100，随时间缓慢衰减，通过互动补充。
 * 跨会话持久化（localStorage），启动时计算离线衰减。
 */

export class MoodSystem {
  constructor() {
    const savedMood = parseFloat(localStorage.getItem('pet-mood') ?? '80');
    const savedTime = parseInt(localStorage.getItem('pet-mood-time') ?? String(Date.now()));

    // 离线衰减：最多计算 8 小时
    const elapsedMin = Math.min((Date.now() - savedTime) / 60000, 480);
    this.mood = Math.max(15, savedMood - elapsedMin * 0.15);

    this._decayAcc = 0;
    this._saveAcc = 0;
    this._decayMultiplier = 1;
    this._callbacks = [];
    this._prevLevel = this.getLevel();
    this._lastSavedMood = null; // 上次持久化的值，用于跳过无变化写入

    this._save();
    console.log(`[mood] Restored: ${Math.round(this.mood)} (${this.getLevel()}), offline decay: ${elapsedMin.toFixed(1)} min`);
  }

  /**
   * 增加心情值（互动时调用）
   * @param {number} amount
   */
  gain(amount) {
    const before = this.getLevel();
    this.mood = Math.min(100, this.mood + amount);
    this._save();
    const after = this.getLevel();
    if (before !== after) this._emitChange(after);
  }

  /**
   * 每帧更新（由主循环调用）
   * @param {number} deltaMs
   */
  update(deltaMs) {
    this._decayAcc += deltaMs;
    // 每 10 秒衰减一次，每分钟 -0.4
    if (this._decayAcc >= 10000) {
      const before = this.getLevel();
      this.mood = Math.max(15, this.mood - (this._decayAcc / 60000) * 0.4 * this._decayMultiplier);
      this._decayAcc = 0;
      const after = this.getLevel();
      if (before !== after) this._emitChange(after);
    }

    // 每 30 秒持久化一次
    this._saveAcc += deltaMs;
    if (this._saveAcc >= 30000) {
      this._save();
      this._saveAcc = 0;
    }
  }

  /**
   * 获取心情等级
   * @returns {'joyful'|'happy'|'normal'|'sad'}
   */
  getLevel() {
    if (this.mood >= 78) return 'joyful';
    if (this.mood >= 52) return 'happy';
    if (this.mood >= 30) return 'normal';
    return 'sad';
  }

  getMood() { return Math.round(this.mood); }

  setDecayMultiplier(n) { this._decayMultiplier = n; }

  /**
   * 注册心情等级变化回调
   * @param {(level: string, mood: number) => void} callback
   */
  onChange(callback) {
    this._callbacks.push(callback);
  }

  _emitChange(level) {
    this._callbacks.forEach(cb => cb(level, Math.round(this.mood)));
  }

  _save() {
    const rounded = String(Math.round(this.mood));
    // pet-mood-time 必须每次都更新，用于下次启动计算离线衰减的起点
    // pet-mood 值若未变化则跳过写入，减少无效存储操作
    if (rounded !== this._lastSavedMood) {
      this._lastSavedMood = rounded;
      localStorage.setItem('pet-mood', rounded);
    }
    localStorage.setItem('pet-mood-time', String(Date.now()));
  }
}
