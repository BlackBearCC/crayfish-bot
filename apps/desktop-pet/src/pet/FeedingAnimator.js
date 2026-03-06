/**
 * FeedingAnimator.js
 * 喂零食动画：4阶段 Canvas 叠加动画
 *
 * 阶段1 (600ms)  — 小鱼干从右上角抛物线飞入，旋转+缩放+拖尾残影
 * 阶段2 (800ms)  — 猫切换 eat 动画，食物缩小消失到嘴巴位置
 * 阶段3 (500ms)  — 星星+碎屑粒子从嘴巴四散弹出
 * 阶段4 (1200ms) — 猫 happy 弹跳，爱心上浮
 */

export class FeedingAnimator {
  constructor(renderer, stateMachine) {
    this.renderer = renderer;
    this.stateMachine = stateMachine;

    this._playing = false;
    this._phase = 0;        // 0=idle, 1-4=动画阶段
    this._phaseTime = 0;    // 当前阶段已过时间
    this._particles = [];
    this._trail = [];       // 拖尾残影
    this._foodX = 0;
    this._foodY = 0;
    this._foodRotation = 0;
    this._foodScale = 1;
    this._bounceScale = 1;  // 猫弹跳缩放

    this._onComplete = null;

    // 食物飞行参数
    this._startX = 0;
    this._startY = 0;
    this._targetX = 0;
    this._targetY = 0;

    // 绑定 overlay 回调
    this._drawOverlay = this._drawOverlay.bind(this);
  }

  /**
   * 播放喂食动画
   * @param {Function} onComplete — 动画结束回调
   */
  play(onComplete) {
    if (this._playing) return; // 防止重复触发

    this._playing = true;
    this._phase = 1;
    this._phaseTime = 0;
    this._particles = [];
    this._trail = [];
    this._foodScale = 1;
    this._foodRotation = 0;
    this._bounceScale = 1;
    this._onComplete = onComplete || null;

    const w = this.renderer.canvas.width;
    const h = this.renderer.canvas.height;

    // 起点：右上角外侧
    this._startX = w + 10;
    this._startY = -10;
    // 终点：猫嘴巴位置（大约画布中心偏下）
    this._targetX = w * 0.5;
    this._targetY = h * 0.52;

    this._foodX = this._startX;
    this._foodY = this._startY;

    // 挂载 overlay
    this.renderer.overlayDrawFn = this._drawOverlay;
  }

  /**
   * overlay 绘制回调 — 每帧由 PetRenderer 调用
   */
  _drawOverlay(ctx, w, h) {
    if (!this._playing) return;

    // 计算 deltaMs（用 performance.now 差值）
    const now = performance.now();
    const delta = this._lastTime ? Math.min(now - this._lastTime, 50) : 16;
    this._lastTime = now;
    this._phaseTime += delta;

    switch (this._phase) {
      case 1: this._updatePhase1(delta, ctx, w, h); break;
      case 2: this._updatePhase2(delta, ctx, w, h); break;
      case 3: this._updatePhase3(delta, ctx, w, h); break;
      case 4: this._updatePhase4(delta, ctx, w, h); break;
    }
  }

  // ===== 阶段1: 食物飞入 (600ms) =====
  _updatePhase1(dt, ctx, w, h) {
    const duration = 600;
    const t = Math.min(this._phaseTime / duration, 1);

    // 缓动函数 (ease-out cubic)
    const ease = 1 - Math.pow(1 - t, 3);

    // 抛物线飞行
    this._foodX = this._startX + (this._targetX - this._startX) * ease;
    // 抛物线 y：向上抛然后落下
    const arcHeight = -80; // 抛物线高度
    const linearY = this._startY + (this._targetY - this._startY) * ease;
    const arc = arcHeight * 4 * t * (1 - t); // 抛物线偏移
    this._foodY = linearY + arc;

    // 旋转（飞行过程中旋转 720 度）
    this._foodRotation = t * Math.PI * 4;

    // 缩放（从0.6到1.2再到1）
    this._foodScale = t < 0.5
      ? 0.6 + 1.0 * t    // 0.6 → 1.1
      : 1.1 + (1 - t) * 0.2; // 1.1 → 1.2 → 1.0-ish

    // 拖尾残影
    if (this._phaseTime % 3 < dt) {
      this._trail.push({
        x: this._foodX, y: this._foodY,
        alpha: 0.5, rotation: this._foodRotation
      });
      if (this._trail.length > 8) this._trail.shift();
    }

    // 绘制拖尾
    for (const tr of this._trail) {
      tr.alpha -= dt * 0.003;
      if (tr.alpha > 0) {
        ctx.save();
        ctx.globalAlpha = tr.alpha * 0.4;
        this._drawFish(ctx, tr.x, tr.y, 0.6, tr.rotation);
        ctx.restore();
      }
    }
    this._trail = this._trail.filter(tr => tr.alpha > 0);

    // 绘制食物
    this._drawFish(ctx, this._foodX, this._foodY, this._foodScale, this._foodRotation);

    // 阶段结束
    if (t >= 1) {
      this._nextPhase();
      // 切换到 eat 动画
      this.stateMachine.transition('eat', { force: true, duration: 800 });
    }
  }

  // ===== 阶段2: 接住吃掉 (800ms) =====
  _updatePhase2(dt, ctx, w, h) {
    const duration = 800;
    const t = Math.min(this._phaseTime / duration, 1);

    // 食物缩小消失到嘴巴位置
    const ease = t * t; // ease-in
    this._foodScale = 1 - ease * 0.9; // 1 → 0.1
    this._foodRotation += dt * 0.01;

    // 食物向嘴巴中心收缩 + 轻微抖动
    const shake = Math.sin(t * Math.PI * 8) * (1 - t) * 3;
    this._foodX = this._targetX + shake;
    this._foodY = this._targetY + Math.sin(t * Math.PI * 6) * 2;

    // 只在前半段显示食物
    if (t < 0.6) {
      ctx.save();
      ctx.globalAlpha = 1 - t * 1.2;
      this._drawFish(ctx, this._foodX, this._foodY, this._foodScale, this._foodRotation);
      ctx.restore();
    }

    // 吃掉瞬间闪光
    if (t > 0.3 && t < 0.5) {
      const flashAlpha = 1 - Math.abs(t - 0.4) * 10;
      ctx.save();
      ctx.globalAlpha = flashAlpha * 0.6;
      ctx.fillStyle = '#FFF8E0';
      ctx.beginPath();
      ctx.arc(this._targetX, this._targetY, 18 * (1 + flashAlpha), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (t >= 1) {
      this._spawnChewParticles(w, h);
      this._nextPhase();
    }
  }

  // ===== 阶段3: 咀嚼粒子 (500ms) =====
  _updatePhase3(dt, ctx, w, h) {
    const duration = 500;
    const t = Math.min(this._phaseTime / duration, 1);

    this._updateParticles(dt);
    this._drawParticles(ctx);

    if (t >= 1) {
      this._spawnHeartParticles(w, h);
      this._nextPhase();
      // 切换到 happy
      this.stateMachine.transition('happy', { force: true, duration: 3000 });
    }
  }

  // ===== 阶段4: 满足反应 (1200ms) =====
  _updatePhase4(dt, ctx, w, h) {
    const duration = 1200;
    const t = Math.min(this._phaseTime / duration, 1);

    // 猫弹跳缩放效果（通过 overlay 额外绘制一些效果来强化）
    // 实际弹跳通过粒子和爱心表现

    this._updateParticles(dt);
    this._drawParticles(ctx);

    // 弹跳星星闪烁
    if (t < 0.5) {
      const sparkle = Math.sin(t * Math.PI * 12) * 0.5 + 0.5;
      ctx.save();
      ctx.globalAlpha = sparkle * 0.8 * (1 - t * 2);
      this._drawStar(ctx, w * 0.25, h * 0.2, 6, '#FFD700');
      this._drawStar(ctx, w * 0.75, h * 0.25, 5, '#FFD700');
      this._drawStar(ctx, w * 0.15, h * 0.5, 4, '#FFEC80');
      this._drawStar(ctx, w * 0.85, h * 0.45, 4, '#FFEC80');
      ctx.restore();
    }

    if (t >= 1) {
      this._finish();
    }
  }

  // ===== 粒子系统 =====

  _spawnChewParticles(w, h) {
    const cx = this._targetX;
    const cy = this._targetY;
    // 星星粒子 (6个)
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 * i) / 6 + Math.random() * 0.5;
      const speed = 60 + Math.random() * 80;
      this._particles.push({
        type: 'star',
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        life: 1,
        decay: 1.5 + Math.random() * 0.8,
        size: 3 + Math.random() * 3,
        color: Math.random() > 0.5 ? '#FFD700' : '#FFA500',
      });
    }
    // 碎屑粒子 (8个)
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 60;
      this._particles.push({
        type: 'debris',
        x: cx + (Math.random() - 0.5) * 10,
        y: cy + (Math.random() - 0.5) * 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 20,
        life: 1,
        decay: 2.0 + Math.random() * 1.0,
        size: 2 + Math.random() * 2,
        color: Math.random() > 0.4 ? '#FF8C42' : '#FFB366',
      });
    }
  }

  _spawnHeartParticles(w, h) {
    const cx = w * 0.5;
    // 爱心粒子 (5个，从头顶飘出)
    for (let i = 0; i < 5; i++) {
      this._particles.push({
        type: 'heart',
        x: cx + (Math.random() - 0.5) * 40,
        y: h * 0.2 + Math.random() * 10,
        vx: (Math.random() - 0.5) * 20,
        vy: -(30 + Math.random() * 30),
        life: 1,
        decay: 0.6 + Math.random() * 0.3,
        size: 5 + Math.random() * 4,
        color: Math.random() > 0.5 ? '#FF4466' : '#FF8899',
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleSpeed: 3 + Math.random() * 2,
      });
    }
  }

  _updateParticles(dt) {
    const dtSec = dt / 1000;
    const gravity = 180;

    for (const p of this._particles) {
      p.life -= p.decay * dtSec;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;

      if (p.type === 'heart') {
        // 爱心缓慢上浮+左右摇摆
        p.wobblePhase += p.wobbleSpeed * dtSec;
        p.x += Math.sin(p.wobblePhase) * 20 * dtSec;
      } else {
        // 星星和碎屑有重力
        p.vy += gravity * dtSec;
      }
    }

    this._particles = this._particles.filter(p => p.life > 0);
  }

  _drawParticles(ctx) {
    for (const p of this._particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);

      if (p.type === 'star') {
        this._drawStar(ctx, p.x, p.y, p.size, p.color);
      } else if (p.type === 'debris') {
        // 像素碎屑 — 小方块
        ctx.fillStyle = p.color;
        const s = p.size * p.life;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.type === 'heart') {
        this._drawHeart(ctx, p.x, p.y, p.size * (0.5 + p.life * 0.5), p.color);
      }

      ctx.restore();
    }
  }

  // ===== 绘制工具 =====

  /**
   * 8x8 像素小鱼干（橙黄色鱼形）
   * 4x 缩放 → 32x32，与猫咪像素风格一致
   */
  _drawFish(ctx, x, y, scale, rotation) {
    const FISH = [
      [0,0,0,1,1,0,0,0],
      [0,0,1,1,1,1,0,0],
      [0,1,1,1,1,1,1,0],
      [1,1,2,1,1,1,1,1],
      [1,1,1,1,1,1,1,1],
      [0,1,1,1,1,1,1,0],
      [0,0,1,1,1,1,0,0],
      [0,0,0,1,1,0,0,0],
    ];

    // Tail shape overlay
    const TAIL = [
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1],
      [0,0,0,0,0,0,0,1],
      [0,0,0,0,0,0,0,1],
      [0,0,0,0,0,0,1,1],
      [0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0],
    ];

    const bodyColor = '#FFB347';  // 鱼身橙黄
    const eyeColor  = '#333333';  // 鱼眼
    const tailColor = '#FF9F1C';  // 尾巴深橙

    const pixelSize = 3 * scale;  // 每个像素 3px * scale
    const totalSize = 8 * pixelSize;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.translate(-totalSize / 2, -totalSize / 2);

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (TAIL[row][col]) {
          ctx.fillStyle = tailColor;
          ctx.fillRect(col * pixelSize, row * pixelSize, pixelSize, pixelSize);
        } else if (FISH[row][col]) {
          ctx.fillStyle = FISH[row][col] === 2 ? eyeColor : bodyColor;
          ctx.fillRect(col * pixelSize, row * pixelSize, pixelSize, pixelSize);
        }
      }
    }

    ctx.restore();
  }

  /**
   * 绘制 4 角星星
   */
  _drawStar(ctx, x, y, size, color) {
    ctx.fillStyle = color;
    // 十字形像素星星
    const s = size;
    ctx.fillRect(x - s / 2, y - 1, s, 2);  // 横
    ctx.fillRect(x - 1, y - s / 2, 2, s);  // 竖
    // 对角小点
    const d = s * 0.35;
    ctx.fillRect(x - d, y - d, 2, 2);
    ctx.fillRect(x + d - 2, y - d, 2, 2);
    ctx.fillRect(x - d, y + d - 2, 2, 2);
    ctx.fillRect(x + d - 2, y + d - 2, 2, 2);
  }

  /**
   * 像素风格爱心
   */
  _drawHeart(ctx, x, y, size, color) {
    ctx.fillStyle = color;
    const s = Math.max(1, size);
    // 像素爱心：3x3 基本形状 scaled
    const p = s / 3;
    // 上面两个方块
    ctx.fillRect(x - s / 2, y - p / 2, p, p);
    ctx.fillRect(x + s / 2 - p, y - p / 2, p, p);
    // 中间一排
    ctx.fillRect(x - s / 2, y + p / 2, s, p);
    // 下面一个
    ctx.fillRect(x - p, y + p * 1.5, p * 2, p);
    // 底部尖
    ctx.fillRect(x - p / 2, y + p * 2.5, p, p);
  }

  // ===== 流程控制 =====

  _nextPhase() {
    this._phase++;
    this._phaseTime = 0;
  }

  _finish() {
    this._playing = false;
    this._phase = 0;
    this._particles = [];
    this._trail = [];
    this._lastTime = 0;

    // 卸载 overlay
    if (this.renderer.overlayDrawFn === this._drawOverlay) {
      this.renderer.overlayDrawFn = null;
    }

    if (this._onComplete) {
      this._onComplete();
      this._onComplete = null;
    }
  }

  /**
   * 是否正在播放
   */
  get isPlaying() {
    return this._playing;
  }
}
