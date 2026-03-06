/**
 * MiniCatSystem.js
 * 小分身系统 — 每个活跃 agent session 对应一只 48px 半透明小猫
 *
 * 功能：
 * - 轮询活跃 session 列表，显示/移除小猫
 * - 每只小猫有 idle / busy 两种动画状态
 * - 最多同时显示 4 只，排列在主猫两侧
 * - 带名字标签（session title）
 * - 有入场/退场动画和浮动效果
 */

export class MiniCatSystem {
  constructor(petArea, spriteSheet, electronAPI) {
    this.petArea = petArea;
    this.spriteSheet = spriteSheet;
    this.electronAPI = electronAPI;
    this.miniCats = new Map();  // sessionKey → MiniCat
    this._pollTimer = null;
    this._positions = [
      { left: 4, bottom: 80 },    // 左下
      { right: 4, bottom: 80 },   // 右下
      { left: 4, bottom: 150 },   // 左上
      { right: 4, bottom: 150 },  // 右上
    ];
  }

  start() {
    this._pollSessions();
    this._pollTimer = setInterval(() => this._pollSessions(), 10000);
  }

  async _pollSessions() {
    if (!this.electronAPI?.getSessionsList) return;
    try {
      const result = await this.electronAPI.getSessionsList();
      const sessions = result?.sessions || [];
      // 只显示最近 5 分钟内活跃的 session（排除主 session）
      const now = Date.now();
      const active = sessions.filter(s =>
        s.updatedAt && (now - s.updatedAt < 5 * 60 * 1000) &&
        !s.key.endsWith(':main')
      ).slice(0, 4);

      // 移除消失的
      const activeKeys = new Set(active.map(s => s.key));
      for (const [key, cat] of this.miniCats) {
        if (!activeKeys.has(key)) {
          cat.destroy();
          this.miniCats.delete(key);
        }
      }
      // 添加新的
      let slotIndex = 0;
      const usedSlots = new Set();
      for (const cat of this.miniCats.values()) {
        usedSlots.add(cat.slotIndex);
      }
      for (const session of active) {
        if (!this.miniCats.has(session.key)) {
          // 找到空闲槽位
          while (usedSlots.has(slotIndex) && slotIndex < this._positions.length) slotIndex++;
          if (slotIndex < this._positions.length) {
            this._spawnMiniCat(session, slotIndex);
            usedSlots.add(slotIndex);
          }
        }
      }
    } catch { /* gateway 未连接时静默降级 */ }
  }

  /** agent 事件驱动的状态更新 */
  onAgentEvent(event) {
    const { sessionKey, stream } = event;
    if (!sessionKey) return;
    const cat = this.miniCats.get(sessionKey);
    if (!cat) return;

    if (stream === 'tool') {
      const toolName = event.data?.tool || event.data?.name;
      cat.setBusy(true, toolName);
    } else if (stream === 'lifecycle' && event.data?.phase === 'complete') {
      cat.setBusy(false);
      cat.setHappy(2000);
    }
  }

  _spawnMiniCat(session, index) {
    if (index >= this._positions.length) return;
    const cat = new MiniCat(this.petArea, this.spriteSheet, session, this._positions[index], index);
    this.miniCats.set(session.key, cat);
  }

  stop() { clearInterval(this._pollTimer); }

  destroy() {
    this.stop();
    for (const cat of this.miniCats.values()) cat.destroy();
    this.miniCats.clear();
  }
}


class MiniCat {
  constructor(parent, spriteSheet, session, position, slotIndex) {
    this.spriteSheet = spriteSheet;
    this.session = session;
    this.slotIndex = slotIndex;
    this._busy = false;
    this._happy = false;
    this._happyTimeout = null;
    this._currentTool = null;
    this._frame = 0;
    this._frameAcc = 0;
    this._animId = null;
    this._bobPhase = Math.random() * Math.PI * 2;
    this._destroyed = false;

    // DOM
    this.container = document.createElement('div');
    this.container.className = 'mini-cat';
    Object.assign(this.container.style, {
      position: 'absolute',
      ...this._posToCSS(position),
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = 48;
    this.canvas.height = 48;
    this.canvas.className = 'mini-cat-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.label = document.createElement('div');
    this.label.className = 'mini-cat-label';
    this.label.textContent = this._deriveLabel(session);

    this.container.appendChild(this.canvas);
    this.container.appendChild(this.label);
    parent.appendChild(this.container);

    // 入场动画
    requestAnimationFrame(() => this.container.classList.add('visible'));

    this._startAnimation();
  }

  _deriveLabel(session) {
    const raw = session.derivedTitle || session.title || session.key || '';
    // 取最后一段（冒号分隔）
    const parts = raw.split(':');
    const name = parts[parts.length - 1] || raw;
    return name.length > 8 ? name.slice(0, 7) + '\u2026' : name;
  }

  _posToCSS(pos) {
    const css = {};
    if (pos.left !== undefined) css.left = pos.left + 'px';
    if (pos.right !== undefined) css.right = pos.right + 'px';
    css.bottom = (pos.bottom || 0) + 'px';
    return css;
  }

  setBusy(busy, toolName) {
    this._busy = busy;
    if (toolName) this._currentTool = toolName;
    else if (!busy) this._currentTool = null;
  }

  setHappy(durationMs = 2000) {
    this._happy = true;
    this.container.classList.add('happy');
    clearTimeout(this._happyTimeout);
    this._happyTimeout = setTimeout(() => {
      this._happy = false;
      this.container.classList.remove('happy');
    }, durationMs);
  }

  _startAnimation() {
    let last = performance.now();
    const loop = (now) => {
      if (this._destroyed) return;
      const dt = now - last;
      last = now;
      this._frameAcc += dt;
      const fps = this._happy ? 8 : this._busy ? 8 : 4;
      if (this._frameAcc > 1000 / fps) {
        this._frameAcc = 0;
        this._frame++;
      }

      // 绘制
      this.ctx.clearRect(0, 0, 48, 48);
      const animName = this._happy ? 'happy' : this._busy ? 'walk' : 'idle';
      const anim = this.spriteSheet.getAnimation(animName);
      if (anim) {
        const frameIdx = this._frame % anim.frames.length;
        this.spriteSheet.drawFrame(this.ctx, animName, frameIdx, 0, 0, 48, 48, false);
      }

      // 上下浮动
      this._bobPhase += dt * 0.002;
      const bob = Math.sin(this._bobPhase) * 2;
      this.canvas.style.transform = `translateY(${bob}px)`;

      this._animId = requestAnimationFrame(loop);
    };
    this._animId = requestAnimationFrame(loop);
  }

  destroy() {
    this._destroyed = true;
    if (this._animId) cancelAnimationFrame(this._animId);
    this.container.classList.remove('visible');
    setTimeout(() => this.container.remove(), 300);
  }
}
