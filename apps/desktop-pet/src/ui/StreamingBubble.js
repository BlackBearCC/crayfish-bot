/**
 * StreamingBubble.js
 * 流式多段气泡 — AI 回复按标点分段，逐段浮现，旧段缩小淡出上移
 *
 * 位于宠物头顶，段从下往上堆叠，不规则倾斜漫画感
 */

import { splitAtPunctuation } from '../utils/textSplitter.js';

export class StreamingBubble {
  /**
   * @param {HTMLElement} petArea - #pet-area
   * @param {import('./Bubble').Bubble} simpleBubble - 普通气泡（流式期间隐藏）
   */
  constructor(petArea, simpleBubble) {
    this.petArea = petArea;
    this.simpleBubble = simpleBubble;

    this.maxSegments = 8;
    this.segments = [];        // { el, text, timer }
    this.pendingText = '';     // 未到标点的缓冲
    this.lastFullText = '';    // 上次 appendText 收到的全文（用于 diff）
    this.isActive = false;
    this.hideTimer = null;

    // 最少 1 秒间隔
    this._lastPromoteTime = 0;
    this._pendingPromote = [];  // 排队等待显示的段
    this._promoteTimer = null;

    // 容器 DOM — 直接挂在 pet-area 上
    this.wrapEl = document.createElement('div');
    this.wrapEl.className = 'stream-segments-container';
    this.wrapEl.style.display = 'none';
    this.petArea.appendChild(this.wrapEl);

    // 当前正在打字的段
    this.currentEl = null;
  }

  /** 兼容调用 */
  updateSide() {}

  /** 开始新一轮流式输出 */
  start() {
    this._clearHideTimer();
    this.clear();
    this.isActive = true;
    this.wrapEl.style.display = '';
    if (this.simpleBubble) this.simpleBubble.hide();

    // 思考中省略号
    this._showThinkingDots();
  }

  /**
   * 追加文本（接收累计全文，内部 diff）
   * @param {string} fullText - 当前累计的完整回复文本
   */
  appendText(fullText) {
    if (!this.isActive) return;
    const newChars = fullText.slice(this.lastFullText.length);
    if (!newChars) return;
    this.lastFullText = fullText;

    this.pendingText += newChars;
    this._processBuffer();
  }

  /** 流结束，刷出剩余文本 */
  finalize() {
    if (!this.isActive) return;

    const rest = this.pendingText.trim();
    if (rest) {
      this._enqueueSegment(rest);
    } else {
      // 无剩余文本时，_showSegment 不会被调用，须手动移除 thinking dots
      this._removeThinkingDots();
    }
    this.pendingText = '';
    this._removeCurrentEl();
  }

  /** 是否正在展示 */
  isVisible() { return this.isActive; }

  /** 清除所有段 */
  clear() {
    this._clearHideTimer();
    if (this._promoteTimer) {
      clearTimeout(this._promoteTimer);
      this._promoteTimer = null;
    }
    this._pendingPromote = [];
    for (const seg of this.segments) {
      if (seg.timer) clearTimeout(seg.timer);
    }
    this.segments = [];
    this.pendingText = '';
    this.lastFullText = '';
    this._lastPromoteTime = 0;
    this._thinkingEl = null;
    this.currentEl = null;
    this.isActive = false;
    this.wrapEl.innerHTML = '';
    this.wrapEl.style.display = 'none';
  }

  destroy() {
    this.clear();
    if (this.wrapEl.parentNode) this.wrapEl.parentNode.removeChild(this.wrapEl);
  }

  // ─── 内部方法 ───

  _processBuffer() {
    const { segments, remainder } = splitAtPunctuation(this.pendingText);

    for (const text of segments) {
      this._enqueueSegment(text);
    }

    this.pendingText = remainder;
  }

  /** 入队 — 确保至少 1 秒间隔 */
  _enqueueSegment(text) {
    this._pendingPromote.push(text);
    this._flushQueue();
  }

  _flushQueue() {
    if (this._promoteTimer || this._pendingPromote.length === 0) return;

    const now = Date.now();
    const elapsed = now - this._lastPromoteTime;
    const MIN_INTERVAL = 1000;

    if (elapsed >= MIN_INTERVAL) {
      this._showSegment(this._pendingPromote.shift());
      this._lastPromoteTime = Date.now();
      // 继续排空队列
      if (this._pendingPromote.length > 0) {
        this._promoteTimer = setTimeout(() => {
          this._promoteTimer = null;
          this._flushQueue();
        }, MIN_INTERVAL);
      }
    } else {
      this._promoteTimer = setTimeout(() => {
        this._promoteTimer = null;
        this._flushQueue();
      }, MIN_INTERVAL - elapsed);
    }
  }

  /** 显示思考中省略号 */
  _showThinkingDots() {
    this._thinkingEl = document.createElement('div');
    this._thinkingEl.className = 'stream-segment thinking-dots';
    this._thinkingEl.innerHTML = '<span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span>';
    const tilt = (Math.random() - 0.5) * 4;
    this._thinkingEl.style.setProperty('--tilt', `rotate(${tilt.toFixed(1)}deg)`);
    this.wrapEl.appendChild(this._thinkingEl);
    requestAnimationFrame(() => this._thinkingEl?.classList.add('visible'));
  }

  /** 移除思考省略号 */
  _removeThinkingDots() {
    if (this._thinkingEl) {
      this._thinkingEl.classList.add('retiring');
      const el = this._thinkingEl;
      this._thinkingEl = null;
      setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
    }
  }

  /** 实际显示一个段 */
  _showSegment(text) {
    this._removeThinkingDots();
    this._removeCurrentEl();

    const el = document.createElement('div');
    el.className = 'stream-segment';
    el.textContent = text;

    // 随机倾斜 — 漫画感
    const tilt = (Math.random() - 0.5) * 5; // -2.5° ~ +2.5°
    el.style.setProperty('--tilt', `rotate(${tilt.toFixed(1)}deg)`);

    this.wrapEl.appendChild(el);
    const seg = { el, text, timer: null };
    this.segments.push(seg);

    // 触发入场动画
    requestAnimationFrame(() => el.classList.add('visible'));

    // 超出上限 → 立即退休最老的
    while (this.segments.length > this.maxSegments) {
      const oldest = this.segments[0];
      if (oldest.timer) clearTimeout(oldest.timer);
      this._retireSegment(oldest);
    }

    // 5 秒后自动退休
    seg.timer = setTimeout(() => this._retireSegment(seg), 5000);
  }

  /** 更新正在打字的临时段 */
  _updateCurrentEl(text) {
    if (!this.currentEl) {
      this.currentEl = document.createElement('div');
      this.currentEl.className = 'stream-segment current';
      this.wrapEl.appendChild(this.currentEl);
      requestAnimationFrame(() => this.currentEl?.classList.add('visible'));
    }
    this.currentEl.textContent = text;
  }

  _removeCurrentEl() {
    if (this.currentEl) {
      this.currentEl.remove();
      this.currentEl = null;
    }
  }

  /** 指定段缩小淡出 */
  _retireSegment(seg) {
    const idx = this.segments.indexOf(seg);
    if (idx >= 0) this.segments.splice(idx, 1);
    seg.el.classList.add('retiring');
    setTimeout(() => { if (seg.el.parentNode) seg.el.remove(); }, 600);

    // 所有段都退完且队列空且流已结束 → 隐藏容器
    if (this.segments.length === 0 && this._pendingPromote.length === 0 && !this.currentEl) {
      setTimeout(() => {
        if (this.segments.length === 0) this.clear();
      }, 700);
    }
  }

  _clearHideTimer() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
