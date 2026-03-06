/**
 * HealthSystem.js
 * 健康度系统 — 由饱腹度和心情的持续状态驱动
 *
 * 不响应单次事件，而是每 30 秒检查当前饱腹+心情等级来决定涨跌。
 * 长期处于饥饿或心情差 → 健康下降。喂饱且心情好 → 缓慢恢复。
 */

export class HealthSystem {
  constructor() {
    const saved = parseFloat(localStorage.getItem('pet-health') ?? '100');
    this.health = Math.max(0, Math.min(100, saved));

    this._checkAcc = 0;
    this._saveAcc = 0;
    this._callbacks = [];
    this._prevLevel = this.getLevel();

    console.log(`[health] Restored: ${Math.round(this.health)} (${this.getLevel()})`);
  }

  /**
   * 每帧更新（由主循环调用）
   * @param {number} deltaMs
   * @param {string} hungerLevel  HungerSystem.getLevel() 的返回值
   * @param {string} moodLevel    MoodSystem.getLevel() 的返回值
   */
  update(deltaMs, hungerLevel, moodLevel) {
    this._checkAcc += deltaMs;
    // 每 30 秒根据饱腹+心情状态调整一次
    if (this._checkAcc >= 30000) {
      const before = this.getLevel();
      this._applyEffect(hungerLevel, moodLevel);
      this._checkAcc = 0;
      const after = this.getLevel();
      if (before !== after) this._emitChange(after);
    }

    this._saveAcc += deltaMs;
    if (this._saveAcc >= 30000) {
      this._save();
      this._saveAcc = 0;
    }
  }

  /**
   * 获取健康等级
   * @returns {'healthy'|'subhealthy'|'sick'}
   */
  getLevel() {
    if (this.health >= 70) return 'healthy';
    if (this.health >= 35) return 'subhealthy';
    return 'sick';
  }

  getHealth() { return Math.round(this.health); }

  /**
   * 注册健康等级变化回调
   * @param {(level: string, health: number) => void} callback
   */
  onChange(callback) {
    this._callbacks.push(callback);
  }

  _applyEffect(hungerLevel, moodLevel) {
    const isHungry = hungerLevel === 'hungry' || hungerLevel === 'starving';
    const isSad = moodLevel === 'sad';
    const isWell = (hungerLevel === 'full' || hungerLevel === 'normal') &&
                   (moodLevel === 'joyful' || moodLevel === 'happy');

    if (isHungry && isSad) {
      this.health = Math.max(0, this.health - 2);
    } else if (isHungry || isSad) {
      this.health = Math.max(0, this.health - 0.8);
    } else if (isWell) {
      this.health = Math.min(100, this.health + 0.3);
    }

    this._save();
  }

  _emitChange(level) {
    this._callbacks.forEach(cb => cb(level, Math.round(this.health)));
  }

  _save() {
    localStorage.setItem('pet-health', String(Math.round(this.health)));
  }
}
