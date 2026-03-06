/**
 * Behaviors.js
 * 自主行为系统 — 让宠物有"生命感"
 *
 * 职责：
 * - 定时触发随机行为（走动、坐下、打盹）
 * - 根据无互动时长调整行为（久不互动→打盹）
 * - 管理宠物在屏幕上的位置移动
 * - 与 StateMachine 和 PetRenderer 协调
 */

export class Behaviors {
  /**
   * @param {import('./StateMachine').StateMachine} stateMachine
   * @param {import('./PetRenderer').PetRenderer} renderer
   * @param {object} options
   */
  constructor(stateMachine, renderer, options = {}) {
    this.sm = stateMachine;
    this.renderer = renderer;

    // 配置
    this.config = {
      minIdleTime: 3000,       // 最少待机时间(ms)
      maxIdleTime: 10000,      // 最多待机时间
      walkSpeed: 1.5,          // 走动速度(px/frame)
      walkDuration: 3000,      // 走动持续时间
      sleepThreshold: 600000,  // 无互动多久后打盹（10分钟）
      bounds: {                // 活动范围
        left: 0,
        right: options.screenWidth || 800,
        bottom: 0
      },
      ...options
    };

    // 位置
    this.x = this.config.bounds.right / 2;
    this.y = 0; // 从屏幕底部算起的偏移

    // 状态
    this.lastInteractionTime = Date.now();
    this.walkDirection = 1; // 1=右, -1=左
    this.nextBehaviorTimer = null;
    this.idleVariantTimer = null;
    this.isActive = false;

    // 走动目标
    this.walkTarget = null;

    // 边缘反应
    this._edgeListeners = [];

    // 边缘吸附
    this.edgeSnapped = null;

    // 窗口停靠
    this.isDocking = false;

    // 绑定状态变化监听（保存引用以便 destroy 时移除）
    this._onStateChangeBound = (e) => this._onStateChange(e);
    this.sm.on('stateChange', this._onStateChangeBound);
  }

  /**
   * 启动自主行为
   */
  start() {
    this.isActive = true;
    this._scheduleNextBehavior();
    this._scheduleIdleVariant();
  }

  /**
   * 停止自主行为
   */
  stop() {
    this.isActive = false;
    if (this.nextBehaviorTimer) {
      clearTimeout(this.nextBehaviorTimer);
      this.nextBehaviorTimer = null;
    }
    if (this.idleVariantTimer) {
      clearTimeout(this.idleVariantTimer);
      this.idleVariantTimer = null;
    }
  }

  /**
   * 每帧更新（由主循环调用）
   * @param {number} deltaMs
   */
  update(deltaMs) {
    if (!this.isActive) return;
    if (this.isDocking) return; // 停靠模式下跳过自主行为

    const state = this.sm.getState();

    // 走动位移
    if (state === 'walk' && this.walkTarget !== null) {
      const step = this.config.walkSpeed * (deltaMs / 16); // 归一化到 60fps
      const dir = this.walkTarget > this.x ? 1 : -1;
      this.x += dir * step;

      // 更新朝向
      this.renderer.setFlipX(dir < 0);

      // 边缘检测（在 clamp 之前）
      const EDGE_ZONE = 20;
      if ((this.x <= this.config.bounds.left + EDGE_ZONE && dir === -1) ||
          (this.x >= this.config.bounds.right - 128 - EDGE_ZONE && dir === 1)) {
        const edge = dir === -1 ? 'left' : 'right';
        this.x = Math.max(this.config.bounds.left, Math.min(this.config.bounds.right - 128, this.x));
        this.walkTarget = null;
        this._emitEdgeReaction(edge);
        this.sm.transition('click_react', { force: true, duration: 3000 });
        this.renderer.setFlipX(edge === 'right');
        return;
      }

      // 到达目标
      if (Math.abs(this.x - this.walkTarget) < step) {
        this.x = this.walkTarget;
        this.walkTarget = null;
        this.sm.transition('idle');
      }

      // 边界检测
      this.x = Math.max(this.config.bounds.left, Math.min(this.config.bounds.right - 128, this.x));
    }

    // 检查是否该打盹了
    if (!this.sm.isLocked() && this.sm.isIdle()) {
      const idleTime = Date.now() - this.lastInteractionTime;
      if (idleTime > this.config.sleepThreshold) {
        this.sm.transition('sleep');
      }
    }
  }

  /**
   * 记录用户互动（重置打盹计时器）
   */
  recordInteraction() {
    this.lastInteractionTime = Date.now();

    // 如果在睡觉，醒来
    if (this.sm.getState() === 'sleep') {
      this.sm.transition('idle', { force: true });
    }
  }

  /**
   * 调度下一个随机行为
   */
  _scheduleNextBehavior() {
    if (!this.isActive) return;

    const delay = this.config.minIdleTime +
      Math.random() * (this.config.maxIdleTime - this.config.minIdleTime);

    this.nextBehaviorTimer = setTimeout(() => {
      this._triggerRandomBehavior();
      this._scheduleNextBehavior();
    }, delay);
  }

  /**
   * 触发随机行为
   */
  _triggerRandomBehavior() {
    // 吸附/停靠中不触发随机行为
    if (this.edgeSnapped || this.isDocking) return;
    // 只在任意 idle 变体下触发随机行为
    if (!this.sm.isIdle()) return;

    const roll = Math.random();

    if (roll < 0.30) {
      this._startWalk();
    } else if (roll < 0.45) {
      this.sm.transition('sit', { duration: 5000 + Math.random() * 5000 });
    } else if (roll < 0.55) {
      // 荡秋千：随机 20~60s，enter→loop→exit 复合动画
      const duration = 20000 + Math.random() * 40000;
      this.sm.transition('swing', { duration });
    }
    // 25% 保持当前待机（什么都不做）
  }

  /**
   * 定期在三种 idle 变体之间随机切换
   * idle → idle_ear_twitch（耳朵抖动）→ idle → idle_yawn（哈欠）→ idle → ...
   */
  _scheduleIdleVariant() {
    if (!this.isActive) return;

    const delay = 8000 + Math.random() * 9000; // 8-17s 触发一次

    this.idleVariantTimer = setTimeout(() => {
      if (this.isActive && this.sm.getState() === 'idle' && !this.sm.isLocked()) {
        const roll = Math.random();
        if (roll < 0.3) {
          // idle_ear_twitch: 耳朵抖动歪头
          this.sm.transition('idle_ear_twitch', { duration: 3000 });
        } else if (roll < 0.55) {
          // idle_yawn: 打哈欠伸懒腰
          this.sm.transition('idle_yawn', { duration: 3000 });
        } else if (roll < 0.7) {
          // idle_sneeze: 打喷嚏
          this.sm.transition('idle_sneeze', { duration: 3000 });
        } else if (roll < 0.85) {
          // idle_trip: 绊倒
          this.sm.transition('idle_trip', { duration: 3000 });
        } else {
          // idle_butterfly: 追蝴蝶
          this.sm.transition('idle_butterfly', { duration: 3000 });
        }
      }
      this._scheduleIdleVariant();
    }, delay);
  }

  /**
   * 开始走动
   */
  _startWalk() {
    this.edgeSnapped = null; // 开始走动时清除吸附
    // 随机选择走动目标
    const range = this.config.bounds.right - this.config.bounds.left - 128;
    this.walkTarget = this.config.bounds.left + Math.random() * range;

    // 更新朝向
    this.walkDirection = this.walkTarget > this.x ? 1 : -1;
    this.renderer.setFlipX(this.walkDirection < 0);

    this.sm.transition('walk');
  }

  /**
   * 状态变化回调
   */
  _onStateChange({ from, to }) {
    // 更新渲染器动画
    this.renderer.setAnimation(to);
  }

  /**
   * 设置位置
   */
  setPosition(x, y) {
    this.x = x;
    this.y = y || 0;
  }

  /**
   * 获取位置
   */
  getPosition() {
    return { x: this.x, y: this.y };
  }

  /**
   * 更新活动范围
   */
  setBounds(bounds) {
    Object.assign(this.config.bounds, bounds);
  }

  // ===== 边缘反应 =====

  onEdgeReaction(cb) { this._edgeListeners.push(cb); }
  _emitEdgeReaction(edge) { this._edgeListeners.forEach(cb => cb(edge)); }

  // ===== 边缘吸附 =====

  setEdgeSnapped(edge) {
    this.edgeSnapped = edge;
    if (edge) this.walkTarget = null;
  }

  // ===== 窗口停靠 =====

  setDocking(enabled) {
    this.isDocking = enabled;
  }

  /**
   * 销毁
   */
  destroy() {
    this.stop();
    this.sm.off('stateChange', this._onStateChangeBound);
  }
}
