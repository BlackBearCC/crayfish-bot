/**
 * HungerSystem.js
 * 饱腹度系统 — 宠物进食状态管理
 *
 * 饱腹值 0-100，随时间衰减（比心情更快，需要主动喂食）。
 * 主要来源：右键喂食 +35，AI 对话完成按回复长度 +5~20。
 * 跨会话持久化（localStorage），启动时计算离线衰减。
 */

export class HungerSystem {
  constructor() {
    const saved = parseFloat(localStorage.getItem('pet-hunger') ?? '70');
    const savedTime = parseInt(localStorage.getItem('pet-hunger-time') ?? String(Date.now()));

    // 离线衰减：最多计算 8 小时，速率 0.6/min
    const elapsedMin = Math.min((Date.now() - savedTime) / 60000, 480);
    this.hunger = Math.max(0, saved - elapsedMin * 0.6);

    this._decayAcc = 0;
    this._saveAcc = 0;
    this._decayMultiplier = 1;
    this._callbacks = [];
    this._prevLevel = this.getLevel();

    this._save();
    console.log(`[hunger] Restored: ${Math.round(this.hunger)} (${this.getLevel()}), offline decay: ${elapsedMin.toFixed(1)} min`);
  }

  /**
   * 喂食（右键喂零食）
   */
  feedSnack() {
    this._gainInternal(35);
  }

  /**
   * AI 对话完成时喂食（按回复字符数估算 token）
   * @param {number} responseLen 回复文本长度
   */
  onChatFinal(responseLen) {
    const amount = Math.min(20, Math.max(5, responseLen / 80));
    this._gainInternal(amount);
  }

  /**
   * 每帧更新（由主循环调用）
   * @param {number} deltaMs
   */
  update(deltaMs) {
    this._decayAcc += deltaMs;
    // 每 10 秒衰减一次，每分钟 -0.6
    if (this._decayAcc >= 10000) {
      const before = this.getLevel();
      this.hunger = Math.max(0, this.hunger - (this._decayAcc / 60000) * 0.6 * this._decayMultiplier);
      this._decayAcc = 0;
      const after = this.getLevel();
      if (before !== after) this._emitChange(after);
    }

    // 每 30 秒持久化
    this._saveAcc += deltaMs;
    if (this._saveAcc >= 30000) {
      this._save();
      this._saveAcc = 0;
    }
  }

  /**
   * 获取饱腹等级
   * @returns {'full'|'normal'|'hungry'|'starving'}
   */
  getLevel() {
    if (this.hunger >= 75) return 'full';
    if (this.hunger >= 35) return 'normal';
    if (this.hunger >= 10) return 'hungry';
    return 'starving';
  }

  getHunger() { return Math.round(this.hunger); }

  setDecayMultiplier(n) { this._decayMultiplier = n; }

  /**
   * 注册饱腹等级变化回调
   * @param {(level: string, hunger: number) => void} callback
   */
  onChange(callback) {
    this._callbacks.push(callback);
  }

  _gainInternal(amount) {
    const before = this.getLevel();
    this.hunger = Math.min(100, this.hunger + amount);
    this._save();
    const after = this.getLevel();
    if (before !== after) this._emitChange(after);
  }

  _emitChange(level) {
    this._callbacks.forEach(cb => cb(level, Math.round(this.hunger)));
  }

  _save() {
    localStorage.setItem('pet-hunger', String(Math.round(this.hunger)));
    localStorage.setItem('pet-hunger-time', String(Date.now()));
  }
}
