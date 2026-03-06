/**
 * LearningChoiceUI.js
 * 学习问答选择按钮 — 简单的 2-3 个选项按钮浮层
 *
 * 显示在 pet-area 中下方（LearningStatusBar 上方），
 * 用户点击后触发回调并自动隐藏。
 */

export class LearningChoiceUI {
  /** @param {HTMLElement} petArea */
  constructor(petArea) {
    this._petArea = petArea;
    this._el = null;
    this._timer = null;
    this._onChoice = null;
  }

  /**
   * 显示问答面板
   * @param {string} question - 问题文字
   * @param {Array<{text: string}>} choices - 选项数组
   * @param {(index: number) => void} onChoice - 用户选择回调
   * @param {number} [timeout=15000] - 超时自动关闭（ms）
   */
  show(question, choices, onChoice, timeout = 15000) {
    this.hide();

    this._onChoice = onChoice;
    const el = document.createElement('div');
    el.className = 'learning-choice-ui';

    el.innerHTML = `
      <div class="lcu-question">${this._escape(question)}</div>
      <div class="lcu-choices">
        ${choices.map((c, i) =>
          `<button class="lcu-btn" data-index="${i}">${this._escape(c.text)}</button>`
        ).join('')}
      </div>
    `;

    el.querySelectorAll('.lcu-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        const cb = this._onChoice;
        this.hide();
        if (cb) cb(idx);
      });
    });

    this._petArea.appendChild(el);
    this._el = el;
    requestAnimationFrame(() => el.classList.add('visible'));

    // 超时自动选中间选项
    this._timer = setTimeout(() => {
      const defaultIdx = Math.min(1, choices.length - 1);
      const cb = this._onChoice;
      this.hide();
      if (cb) cb(defaultIdx);
    }, timeout);
  }

  hide() {
    clearTimeout(this._timer);
    this._timer = null;
    this._onChoice = null;
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }

  get isVisible() { return !!this._el; }

  destroy() { this.hide(); }

  _escape(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
