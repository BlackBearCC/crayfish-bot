/**
 * ToolStatusBar.js
 * 头顶状态条 — 实时展示 AI 正在执行的 tool/skill
 *
 * DOM 元素定位在 pet-area 内，canvas 正上方。
 * 比 Canvas overlay 更适合文字渲染（支持 CSS 动画、emoji 图标）。
 */

export const ICON_MAP = {
  browser: '🔍', web_search: '🔍', fetch: '🌐',
  exec: '⚡', shell: '⚡', terminal: '⚡',
  pdf: '📄', read_file: '📄', read: '📄',
  write_file: '✏️', write: '✏️', edit: '✏️',
  image: '🎨', canvas: '🎨',
  cron: '⏰', schedule: '⏰',
  discord: '💬', slack: '💬', telegram: '💬',
  grep: '🔎', glob: '📂',
  bash: '⚡', code: '💻',
};

export class ToolStatusBar {
  constructor(petArea) {
    this._visible = false;
    this._timer = null;
    this._learningMode = false;
    this._learningInterval = null;
    this._createDOM(petArea);
  }

  _createDOM(petArea) {
    this.element = document.createElement('div');
    this.element.className = 'tool-status-bar';
    petArea.insertBefore(this.element, petArea.querySelector('#pet-canvas'));
  }

  /**
   * 显示状态条
   * @param {string} toolName — 工具名称
   * @param {string} [icon] — 可选，强制指定图标
   */
  show(toolName, icon) {
    if (this._learningMode) return; // 学习中不被工具状态覆盖
    const resolvedIcon = icon || this._matchIcon(toolName) || '🔧';
    const safeName = this._escapeHtml(this._truncate(toolName, 10));

    this.element.innerHTML = `
      <span class="tool-icon">${resolvedIcon}</span>
      <span class="tool-name">${safeName}</span>
      <span class="tool-spinner"></span>
    `;
    this.element.classList.add('visible');
    this._visible = true;

    // 安全超时：最多显示 30 秒
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.hide(), 30000);
  }

  /**
   * 显示学习模式（带倒计时，不超时自动隐藏）
   * @param {string} title — 课程名称
   * @param {() => number} getRemainingMs — 返回剩余毫秒数的函数
   */
  showLearning(title, getRemainingMs) {
    this._learningMode = true;
    clearTimeout(this._timer);
    clearInterval(this._learningInterval);

    const safeTitle = this._escapeHtml(this._truncate(title, 8));

    const updateCountdown = () => {
      const ms = getRemainingMs();
      if (ms <= 0) { this.hideLearning(); return; }
      const min = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      const timeStr = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      this.element.innerHTML = `
        <span class="tool-icon">\uD83D\uDCDA</span>
        <span class="tool-name">${safeTitle}</span>
        <span class="tool-countdown">${timeStr}</span>
      `;
    };

    updateCountdown();
    this._learningInterval = setInterval(updateCountdown, 1000);
    this.element.classList.add('visible');
    this._visible = true;
  }

  hideLearning() {
    this._learningMode = false;
    clearInterval(this._learningInterval);
    this._learningInterval = null;
    this.hide();
  }

  hide() {
    this.element.classList.remove('visible');
    this._visible = false;
    clearTimeout(this._timer);
  }

  _matchIcon(name) {
    const lower = name.toLowerCase();
    for (const [key, icon] of Object.entries(ICON_MAP)) {
      if (lower.includes(key)) return icon;
    }
    return null;
  }

  _truncate(s, max) {
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  _escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  get isVisible() { return this._visible; }

  destroy() {
    clearTimeout(this._timer);
    clearInterval(this._learningInterval);
    this.element?.remove();
  }
}
