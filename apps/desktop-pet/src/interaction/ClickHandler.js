/**
 * ClickHandler.js
 * 点击交互 — 单击触发反应动画，双击打开聊天面板
 */

export class ClickHandler {
  /**
   * @param {HTMLElement} element
   * @param {import('../pet/StateMachine').StateMachine} stateMachine
   * @param {import('../pet/Behaviors').Behaviors} behaviors
   * @param {object} options
   */
  constructor(element, stateMachine, behaviors, options = {}) {
    this.element = element;
    this.sm = stateMachine;
    this.behaviors = behaviors;

    this.clickTimeout = null;
    this.clickDelay = 250; // 区分单击和双击的延迟

    this.onSingleClick = options.onSingleClick || null;
    this.onDoubleClick = options.onDoubleClick || null;
    this.onLongPress = options.onLongPress || null;

    // 长按检测
    this.longPressTimer = null;
    this.longPressDelay = 1500;
    this._isLongPressing = false;

    this._onClick = this._onClick.bind(this);
    this._onDblClick = this._onDblClick.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);

    this.element.addEventListener('click', this._onClick);
    this.element.addEventListener('dblclick', this._onDblClick);
    this.element.addEventListener('mousedown', this._onMouseDown);
    this.element.addEventListener('mouseup', this._onMouseUp);
    this.element.addEventListener('mouseleave', this._onMouseUp);
  }

  _onClick(e) {
    // 延迟执行，以判断是否为双击
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
      return; // 双击的第二次点击，由 dblclick 处理
    }

    this.clickTimeout = setTimeout(() => {
      this.clickTimeout = null;
      this._handleSingleClick(e);
    }, this.clickDelay);
  }

  _onDblClick(e) {
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
    }
    this._handleDoubleClick(e);
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    this._isLongPressing = false;
    this.longPressTimer = setTimeout(() => {
      this._isLongPressing = true;
      this.longPressTimer = null;
      if (this.clickTimeout) {
        clearTimeout(this.clickTimeout);
        this.clickTimeout = null;
      }
      if (this.onLongPress) this.onLongPress(e);
    }, this.longPressDelay);
  }

  _onMouseUp(e) {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  _handleSingleClick(e) {
    if (this._isLongPressing) {
      this._isLongPressing = false;
      return; // 长按已处理，忽略 click 事件
    }
    this.behaviors.recordInteraction();

    // 播放点击反应动画（36帧@12fps = 3000ms）
    this.sm.transition('click_react', { force: true, duration: 3000 });

    if (this.onSingleClick) {
      this.onSingleClick(e);
    }
  }

  _handleDoubleClick(e) {
    this.behaviors.recordInteraction();

    // 播放开心动画（36帧@12fps = 3000ms）
    this.sm.transition('happy', { force: true, duration: 3000 });

    if (this.onDoubleClick) {
      this.onDoubleClick(e);
    }
  }

  destroy() {
    if (this.clickTimeout) clearTimeout(this.clickTimeout);
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.element.removeEventListener('click', this._onClick);
    this.element.removeEventListener('dblclick', this._onDblClick);
    this.element.removeEventListener('mousedown', this._onMouseDown);
    this.element.removeEventListener('mouseup', this._onMouseUp);
    this.element.removeEventListener('mouseleave', this._onMouseUp);
  }
}
