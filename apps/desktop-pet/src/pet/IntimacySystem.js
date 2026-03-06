/**
 * IntimacySystem.js
 * 亲密度 / 成长阶段管理
 *
 * 阶段：
 *   0 — 幼猫 🐱  (0 pts)     幼猫 sprite
 *   1 — 朋友 😺  (100 pts)   成人 sprite + 偏亮滤镜
 *   2 — 亲密 😻  (350 pts)   成人 sprite 默认外观
 *   3 — 契合 💖  (800 pts)   成人 sprite + 饱和度增强
 *
 * 无衰减。localStorage 持久化（key: pet-intimacy）。
 */

const STORAGE_KEY = 'pet-intimacy';

const STAGES = [
  { threshold: 0,   name: '幼猫',     emoji: '🐱', milestoneMsg: null },
  { threshold: 100, name: '朋友',     emoji: '😺', milestoneMsg: '我们成为朋友啦！谢谢你陪伴我~ 😺' },
  { threshold: 350, name: '亲密伙伴', emoji: '😻', milestoneMsg: '主人，我们已经是亲密伙伴了喵！❤️' },
  { threshold: 800, name: '心灵契合', emoji: '💖', milestoneMsg: '心灵契合！我跟主人之间有特别的缘分喵~ 💖' },
];

export class IntimacySystem {
  constructor() {
    this.points = 0;
    this.stage = 0;
    this._milestoneCallback = null;

    this._load();
  }

  /**
   * 增加亲密度
   * @param {number} amount
   */
  gain(amount) {
    if (amount <= 0) return;
    this.points += amount;
    this._checkMilestone();
    this._save();
  }

  /**
   * 注册里程碑回调
   * @param {function(stage: number, info: {name: string, emoji: string, milestoneMsg: string}): void} callback
   */
  onMilestone(callback) {
    this._milestoneCallback = callback;
  }

  /**
   * 当前阶段信息
   */
  getStageInfo() {
    return STAGES[this.stage];
  }

  _checkMilestone() {
    // 找到当前 points 对应的最高阶段
    let newStage = this.stage;
    for (let i = this.stage + 1; i < STAGES.length; i++) {
      if (this.points >= STAGES[i].threshold) {
        newStage = i;
      }
    }

    if (newStage > this.stage) {
      this.stage = newStage;
      // 只触发最终阶段的里程碑消息，避免连跳时多次 bubble 互相覆盖
      if (this._milestoneCallback && STAGES[newStage].milestoneMsg) {
        this._milestoneCallback(this.stage, STAGES[newStage]);
      }
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        points: this.points,
        stage: this.stage,
      }));
    } catch (e) {
      // ignore storage errors
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.points === 'number' && data.points >= 0) this.points = data.points;
      if (typeof data.stage === 'number' && data.stage >= 0 && data.stage < STAGES.length) {
        this.stage = data.stage;
      }
    } catch (e) {
      // ignore parse errors
    }
  }
}
