/**
 * MarkdownPanel.js
 * 完整 Markdown 面板 — AI 回复含表格/代码/列表时显示在角色左侧独立面板
 *
 * 流式 streaming 期间继续用 StreamingBubble 显示进度；
 * final 收到完整文本后调用 show()，清掉流式碎片，展示渲染好的 Markdown。
 */

const MD_EXPAND_SIZE = { width: 600, height: 580 };

export class MarkdownPanel {
  /**
   * @param {HTMLElement} _container - 保留参数兼容，实际挂到 document.body
   * @param {object} [electronAPI]
   */
  constructor(_container, electronAPI) {
    this._api = electronAPI || null;
    this._el = null;
    this._timer = null;
  }

  /**
   * 显示 Markdown 面板（在角色左侧）
   * @param {string} markdownText - 完整回复文本
   * @param {number} duration     - 自动关闭毫秒数，0=不自动关闭
   */
  show(markdownText, duration = 15000) {
    this._clear();

    const el = document.createElement('div');
    el.className = 'md-panel';

    const rendered = window.marked
      ? window.marked.parse(markdownText)
      : this._escape(markdownText).replace(/\n/g, '<br>');

    el.innerHTML = `
      <div class="md-panel-header">
        <span class="md-panel-icon">🐾</span>
        <span class="md-panel-title">AI 回复</span>
        <button class="md-panel-close" title="关闭">✕</button>
      </div>
      <div class="md-panel-content markdown-body">${rendered}</div>
    `;

    el.querySelector('.md-panel-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });

    document.body.appendChild(el);
    this._el = el;

    requestAnimationFrame(() => el.classList.add('visible'));

    if (duration > 0) {
      this._timer = setTimeout(() => this.hide(), duration);
    }
  }

  hide() {
    if (!this._el) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._el.classList.add('hiding');
    const el = this._el;
    this._el = null;
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 400);
  }

  isVisible() { return !!this._el; }

  destroy() {
    this._clear();
  }

  // ─── 内部 ───

  _clear() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }

  _escape(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

/**
 * 判断文本是否含有 Markdown 语法（需要面板渲染）
 * @param {string} text
 * @returns {boolean}
 */
export function hasMarkdown(text) {
  return /\*\*[^*\n]+\*\*|(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)|`[^`\n]+`|^#{1,6} |\|.+\||\n- |\n\d+\. |^- |^> /m.test(text);
}
