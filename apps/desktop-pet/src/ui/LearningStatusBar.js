/**
 * LearningStatusBar.js
 * 学习状态底部横幅 — 显示当前课程名、进度条、剩余时间
 *
 * 定位在 #pet-area 底部，BottomChatInput 上方，高度约 36px。
 * 学习开始时滑入，结束/中断时滑出。
 */

export class LearningStatusBar {
  /** @param {HTMLElement} petArea */
  constructor(petArea) {
    this._petArea = petArea;
    this._visible = false;
    this._interval = null;
    this._getRemainingMs = null;
    this._totalMs = 0;

    this._createDOM();
  }

  _createDOM() {
    this.el = document.createElement('div');
    this.el.className = 'learning-status-bar';
    this.el.innerHTML = `
      <div class="lsb-header">
        <span class="lsb-icon">📚</span>
        <span class="lsb-title"></span>
        <span class="lsb-time"></span>
      </div>
      <div class="lsb-track">
        <div class="lsb-fill"></div>
      </div>
    `;
    this._petArea.appendChild(this.el);

    this._titleEl = this.el.querySelector('.lsb-title');
    this._timeEl  = this.el.querySelector('.lsb-time');
    this._fillEl  = this.el.querySelector('.lsb-fill');
  }

  /**
   * 显示学习横幅
   * @param {string} title — 课程名
   * @param {() => number} getRemainingMs — 返回剩余毫秒数
   * @param {number} totalMs — 总时长毫秒
   */
  show(title, getRemainingMs, totalMs) {
    this._getRemainingMs = getRemainingMs;
    this._totalMs = totalMs;
    this._titleEl.textContent = title.length > 12 ? title.slice(0, 12) + '…' : title;

    this._update();
    clearInterval(this._interval);
    this._interval = setInterval(() => this._update(), 5000);

    this.el.classList.add('visible');
    this._visible = true;
  }

  hide() {
    if (!this._visible) return;
    clearInterval(this._interval);
    this._interval = null;
    this._getRemainingMs = null;
    this.el.classList.remove('visible');
    this._visible = false;
  }

  _update() {
    if (!this._getRemainingMs) return;
    const remaining = this._getRemainingMs();
    if (remaining <= 0) { this.hide(); return; }

    // 剩余时间文字
    const min = Math.ceil(remaining / 60000);
    this._timeEl.textContent = `${min} min`;

    // 进度条
    const progress = this._totalMs > 0
      ? Math.min(1, 1 - remaining / this._totalMs)
      : 0;
    this._fillEl.style.width = `${Math.round(progress * 100)}%`;
  }

  get isVisible() { return this._visible; }

  destroy() {
    clearInterval(this._interval);
    this.el?.remove();
  }
}
