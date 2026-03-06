/**
 * Bubble.js
 * 消息气泡组件 — 宠物头顶弹出的消息提示
 */

export class Bubble {
  constructor(container) {
    this.container = container;
    this.element = null;
    this.hideTimer = null;
    this._createDOM();
  }

  _createDOM() {
    this.element = document.createElement('div');
    this.element.className = 'pet-bubble';
    this.element.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      background: #FFF9F2;
      border: 2.5px solid #2A2A2A;
      border-radius: 16px 4px 14px 6px / 6px 14px 4px 16px;
      padding: 8px 12px;
      font-size: 12px;
      font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
      font-weight: 600;
      color: #2A2A2A;
      max-width: 170px;
      word-wrap: break-word;
      box-shadow: 3px 3px 0 #2A2A2A;
      opacity: 0;
      transition: opacity 0.3s ease, transform 0.3s ease;
      pointer-events: none;
      z-index: 10;
      white-space: pre-wrap;
    `;

    // 小三角（右下角，指向角色头部）
    const arrow = document.createElement('div');
    arrow.style.cssText = `
      position: absolute;
      bottom: -10px;
      right: 18px;
      width: 0;
      height: 0;
      border-left: 9px solid transparent;
      border-right: 9px solid transparent;
      border-top: 10px solid #2A2A2A;
    `;
    this.element.appendChild(arrow);

    const arrowInner = document.createElement('div');
    arrowInner.style.cssText = `
      position: absolute;
      bottom: -6px;
      right: 20px;
      width: 0;
      height: 0;
      border-left: 7px solid transparent;
      border-right: 7px solid transparent;
      border-top: 7px solid #FFF9F2;
    `;
    this.element.appendChild(arrowInner);

    this.textNode = document.createElement('span');
    this.element.insertBefore(this.textNode, this.element.firstChild);

    this.container.appendChild(this.element);
  }

  /**
   * 显示消息气泡
   * @param {string} text
   * @param {number} duration - 显示时长(ms), 0=不自动隐藏
   */
  show(text, duration = 3000) {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
    }

    this.textNode.textContent = text;
    this.element.style.opacity = '1';
    this.element.style.transform = 'translateY(-5px)';

    if (duration > 0) {
      this.hideTimer = setTimeout(() => this.hide(), duration);
    }
  }

  /**
   * 隐藏气泡
   */
  hide() {
    this.element.style.opacity = '0';
    this.element.style.transform = 'translateY(0)';
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /**
   * 是否正在显示
   */
  isVisible() {
    return this.element.style.opacity !== '0';
  }

  destroy() {
    this.hide();
    if (this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
