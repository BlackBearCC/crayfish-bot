/**
 * StateMachine.js
 * 动画状态机 — 管理宠物的动画状态转换
 *
 * 状态转换规则：
 *   idle → walk（随机触发）
 *   idle → sit（随机）
 *   idle → sleep（无交互 >60s）
 *   any → drag（鼠标按下）
 *   drag → idle（鼠标释放）
 *   any → click_react（点击，持续后回到前状态）
 *   any → talk（收到消息）
 *   any → happy/sad（根据情绪）
 */

export class StateMachine {
  constructor() {
    this.currentState = 'idle';
    this.previousState = 'idle';
    this.stateTime = 0;          // 当前状态持续时间(ms)
    this.listeners = new Map();   // 状态变化监听器
    this.locked = false;          // 是否锁定状态（用于临时动画）
    this.lockTimer = null;
    this.transitions = this._buildTransitions();
  }

  _buildTransitions() {
    const fromIdle = ['walk', 'sit', 'sleep', 'swing', 'work', 'drag', 'click_react', 'talk', 'happy', 'sad', 'idle_ear_twitch', 'idle_yawn', 'idle_sneeze', 'idle_trip', 'idle_butterfly', 'eat', 'edge_idle'];
    const interruptible = ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad'];
    return {
      idle:        fromIdle,
      idle_ear_twitch: ['idle', ...interruptible, 'eat', 'edge_idle', 'work'],
      idle_yawn:       ['idle', ...interruptible, 'eat', 'edge_idle', 'work'],
      idle_sneeze: ['idle', ...interruptible, 'eat', 'edge_idle', 'work'],
      idle_trip:   ['idle', ...interruptible, 'eat', 'edge_idle', 'work'],
      idle_butterfly: ['idle', ...interruptible, 'eat', 'edge_idle', 'work'],
      walk:        ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad', 'eat', 'edge_idle', 'work'],
      sit:         ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad', 'eat', 'edge_idle', 'work'],
      sleep:       ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad', 'eat', 'edge_idle', 'work'],
      swing:       ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad', 'eat', 'edge_idle'],
      work:        ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad', 'eat', 'edge_idle'],
      drag:        ['idle', 'edge_idle'],
      click_react: ['idle', 'walk', 'sit', 'sleep', 'edge_idle', 'work'],
      talk:        ['idle', 'edge_idle', 'work'],
      happy:       ['idle', 'edge_idle'],
      sad:         ['idle', 'edge_idle'],
      eat:         ['idle', 'happy', 'edge_idle'],
      edge_idle:   ['idle', 'drag', 'click_react', 'talk', 'happy', 'sad', 'eat'],
    };
  }

  /**
   * 尝试切换状态
   * @param {string} newState
   * @param {object} options - { force: bool, duration: number (ms) }
   * @returns {boolean} 是否成功切换
   */
  transition(newState, options = {}) {
    const { force = false, duration = 0 } = options;

    // 如果锁定且非强制，拒绝切换
    if (this.locked && !force) return false;

    // 检查转换是否合法
    const allowed = this.transitions[this.currentState];
    if (!force && allowed && !allowed.includes(newState)) {
      return false;
    }

    this.previousState = this.currentState;
    this.currentState = newState;
    this.stateTime = 0;

    // 清除旧的锁定计时器
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }

    // 如果指定了持续时间，锁定状态并在结束后回到之前状态
    if (duration > 0) {
      this.locked = true;
      this.lockTimer = setTimeout(() => {
        this.locked = false;
        this.lockTimer = null;
        this.transition(this._getReturnState());
      }, duration);
    } else {
      this.locked = false;
    }

    // 触发监听器
    this._emit('stateChange', {
      from: this.previousState,
      to: this.currentState,
      duration
    });

    return true;
  }

  /**
   * 获取临时状态结束后应该返回的状态
   */
  _getReturnState() {
    // 临时状态结束后返回 idle
    const tempStates = ['click_react', 'happy', 'sad', 'talk', 'drag', 'idle_ear_twitch', 'idle_yawn', 'idle_sneeze', 'idle_trip', 'idle_butterfly', 'eat', 'edge_idle', 'work', 'swing'];
    if (tempStates.includes(this.previousState)) {
      return 'idle';
    }
    return this.previousState;
  }

  /**
   * 判断是否处于任意 idle 变体
   */
  isIdle() {
    return this.currentState === 'idle' || this.currentState === 'idle_ear_twitch' || this.currentState === 'idle_yawn' || this.currentState === 'edge_idle';
  }

  /**
   * 更新状态时间
   * @param {number} deltaMs
   */
  update(deltaMs) {
    this.stateTime += deltaMs;
  }

  /**
   * 监听状态变化
   * @param {string} event - 'stateChange'
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    const list = this.listeners.get(event);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  _emit(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach(cb => cb(data));
    }
  }

  /**
   * 获取当前状态
   */
  getState() {
    return this.currentState;
  }

  /**
   * 获取当前状态持续时间
   */
  getStateTime() {
    return this.stateTime;
  }

  /**
   * 是否处于锁定状态
   */
  isLocked() {
    return this.locked;
  }

  /**
   * 强制解锁
   */
  unlock() {
    this.locked = false;
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }

  /**
   * 销毁
   */
  destroy() {
    this.unlock();
    this.listeners.clear();
  }
}
