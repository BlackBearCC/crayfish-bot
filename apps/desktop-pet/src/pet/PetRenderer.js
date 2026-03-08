/**
 * PetRenderer.js
 * Canvas 帧动画渲染器
 *
 * 职责：
 * - 管理 Canvas 元素
 * - 按帧率从 SpriteSheet 中绘制当前动画帧
 * - 支持水平翻转（左右走动）
 * - 透明背景渲染
 */

export class PetRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./SpriteSheet').SpriteSheet} spriteSheetKitten - 幼猫 spritesheet（stage 0 使用）
   * @param {number} renderSize - 渲染尺寸（正方形）
   */
  constructor(canvas, spriteSheetKitten, renderSize = 128) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.spriteSheetKitten = spriteSheetKitten;
    this.renderSize = renderSize;
    this._growthStage = 0;
    this.characterScale = 1.0; // 角色渲染放大倍数（以底部中心为锚点）

    // 设置 canvas 尺寸
    this.canvas.width = renderSize;
    this.canvas.height = renderSize;

    // 动画状态
    this.currentAnimation = 'idle';
    this.currentFrame = 0;
    this.frameAccumulator = 0; // 帧时间累加器
    this.flipX = false;
    this.isPlaying = true;

    // 渲染循环
    this._lastTime = 0;
    this._animFrameId = null;
    this._fallbackTimer = null; // rAF 停滞时的保底定时器

    // overlay 绘制回调（用于叠加动画，如喂食特效）
    this.overlayDrawFn = null;   // 兼容旧 API
    this._overlays = [];         // 多 overlay 数组

    // 额外 spritesheet 映射：animationName → SpriteSheet
    this._extraSheets = new Map();

    // idle 变体随机轮换：['idle', 'idle_2', 'idle_3', ...]
    this._idleVariants = ['idle'];
    this._idleVariantTimer = null;

    // 复合动画（enter→loop→exit）：stateName → { enter, loop, exit? }
    this._compoundAnims = new Map();

    // 正在播放 exit 动画时，暂存目标动画名
    this._exitTarget = null;

    // 高清素材：启用平滑缩放
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    // 脏标记：只在视觉状态变化时重绘，避免每帧都 clear+draw
    this._dirty = true;
  }

  /**
   * 注册额外的 spritesheet（用于特定动画）
   * @param {string} animationName - 动画名（需与 JSON 中定义的一致）
   * @param {import('./SpriteSheet').SpriteSheet} sheet
   */
  registerSheet(animationName, sheet) {
    this._extraSheets.set(animationName, sheet);
  }

  /**
   * 注册复合动画（enter→loop→exit 自动衔接）
   * @param {string} stateName - 状态名（如 'sleep'）
   * @param {string} enterAnim - 进入动画名（如 'sleep_enter'）
   * @param {string} loopAnim - 循环动画名（如 'sleep_loop'）
   * @param {string} [exitAnim] - 退出动画名（如 'sleep_exit'，可选）
   */
  registerCompound(stateName, enterAnim, loopAnim, exitAnim) {
    this._compoundAnims.set(stateName, { enter: enterAnim, loop: loopAnim, exit: exitAnim || null });
  }

  /**
   * 注册 idle 变体（如 idle_2, idle_3），自动随机轮换
   * @param {string} name - 变体名（如 'idle_2'）
   * @param {import('./SpriteSheet').SpriteSheet} sheet
   */
  registerIdleVariant(name, sheet) {
    this._extraSheets.set(name, sheet);
    if (!this._idleVariants.includes(name)) {
      this._idleVariants.push(name);
    }
  }

  _pickRandomIdleVariant() {
    const loaded = this._idleVariants.filter(v => {
      if (v === 'idle') return this._getDefaultSheet()?.loaded;
      return this._extraSheets.get(v)?.loaded;
    });
    if (loaded.length <= 1) return loaded[0] || 'idle';
    return loaded[Math.floor(Math.random() * loaded.length)];
  }

  _startIdleVariantRotation() {
    this._stopIdleVariantRotation();
    if (this._idleVariants.length <= 1) return;
    const rotate = () => {
      if (!this._idleVariants.includes(this.currentAnimation)) return;
      const next = this._pickRandomIdleVariant();
      if (next !== this.currentAnimation) {
        this.currentAnimation = next;
        this.currentFrame = 0;
        this.frameAccumulator = 0;
        this._dirty = true;
      }
      this._idleVariantTimer = setTimeout(rotate, 8000 + Math.random() * 7000);
    };
    this._idleVariantTimer = setTimeout(rotate, 8000 + Math.random() * 7000);
  }

  _stopIdleVariantRotation() {
    if (this._idleVariantTimer) {
      clearTimeout(this._idleVariantTimer);
      this._idleVariantTimer = null;
    }
  }

  /**
   * 设置成长阶段（影响使用的 spritesheet 和滤镜）
   * @param {number} stage 0-3
   */
  setGrowthStage(stage) {
    if (this._growthStage !== stage) {
      this._growthStage = stage;
      this._dirty = true;
    }
  }

  /** 添加 overlay 绘制回调 */
  addOverlay(fn) { this._overlays.push(fn); }

  /** 移除 overlay 绘制回调 */
  removeOverlay(fn) { this._overlays = this._overlays.filter(f => f !== fn); }

  /**
   * 设置当前动画
   * @param {string} animationName
   * @param {boolean} resetFrame - 是否重置到第0帧
   */
  setAnimation(animationName, resetFrame = true) {
    // 状态→动画名映射（某些状态复用已有动画）
    const animMap = { edge_idle: 'sit' };
    const resolved = animMap[animationName] || animationName;

    // 正在播放 exit 动画 → 忽略（等 exit 播完再切）
    if (this._exitTarget !== null) return;

    // 检查是否正在离开一个有 exit 动画的复合状态
    const leavingCompound = this._getActiveCompound();
    if (leavingCompound && leavingCompound.exit && resolved !== leavingCompound.exit) {
      // 当前正处于该复合状态的 enter/loop 阶段，且目标不是 exit 本身
      this._playCompoundExit(leavingCompound, resolved);
      return;
    }

    // 复合动画：自动播放 enter 部分
    const compound = this._compoundAnims.get(resolved);
    if (compound && this.currentAnimation !== compound.enter && this.currentAnimation !== compound.loop) {
      this._playCompoundEnter(compound);
      return;
    }

    // 离开 idle 变体 → 停止轮换定时器
    if (this._idleVariants.includes(this.currentAnimation) && !this._idleVariants.includes(resolved)) {
      this._stopIdleVariantRotation();
    }

    // 进入 idle 状态 → 随机选择变体并启动轮换
    if (resolved === 'idle') {
      const variant = this._pickRandomIdleVariant();
      if (this.currentAnimation === variant && !resetFrame) return;
      const variantSheet = this._getSheetForAnimation(variant);
      const variantAnim = variantSheet?.getAnimation(variant);
      if (!variantAnim) {
        console.warn(`Idle variant "${variant}" not found, keeping current`);
        return;
      }
      this.currentAnimation = variant;
      this._dirty = true;
      if (resetFrame) {
        this.currentFrame = 0;
        this.frameAccumulator = 0;
      }
      this._startIdleVariantRotation();
      return;
    }

    if (this.currentAnimation === resolved && !resetFrame) return;

    const sheet = this._getSheetForAnimation(resolved);
    const anim = sheet?.getAnimation(resolved);
    if (!anim) {
      console.warn(`Animation "${animationName}" not found, keeping current`);
      return;
    }

    this.currentAnimation = resolved;
    this._dirty = true;
    if (resetFrame) {
      this.currentFrame = 0;
      this.frameAccumulator = 0;
    }
  }

  /**
   * 播放复合动画的 enter 部分，结束后自动切换到 loop
   */
  _playCompoundEnter(compound) {
    const sheet = this._getSheetForAnimation(compound.enter);
    const anim = sheet.getAnimation(compound.enter);
    if (!anim) {
      this.currentAnimation = compound.loop;
      this.currentFrame = 0;
      this.frameAccumulator = 0;
      this._dirty = true;
      return;
    }

    this.currentAnimation = compound.enter;
    this.currentFrame = 0;
    this.frameAccumulator = 0;
    this._dirty = true;

    const prevCallback = this.onAnimationEnd;
    this.onAnimationEnd = (animName) => {
      if (animName === compound.enter) {
        this.currentAnimation = compound.loop;
        this.currentFrame = 0;
        this.frameAccumulator = 0;
        this._dirty = true;
        this.onAnimationEnd = prevCallback;
      }
    };
  }

  /**
   * 获取当前正在播放的复合动画（如果有的话）
   * @returns {{ enter: string, loop: string, exit: string|null } | null}
   */
  _getActiveCompound() {
    for (const [, compound] of this._compoundAnims) {
      if (this.currentAnimation === compound.enter || this.currentAnimation === compound.loop) {
        return compound;
      }
    }
    return null;
  }

  /**
   * 播放复合动画的 exit 部分，结束后切换到目标动画
   * @param {{ enter: string, loop: string, exit: string }} compound
   * @param {string} targetAnimation - exit 播完后要切到的动画
   */
  _playCompoundExit(compound, targetAnimation) {
    const sheet = this._getSheetForAnimation(compound.exit);
    const anim = sheet.getAnimation(compound.exit);
    if (!anim) {
      this.currentAnimation = targetAnimation;
      this.currentFrame = 0;
      this.frameAccumulator = 0;
      this._dirty = true;
      return;
    }

    this._exitTarget = targetAnimation;
    this.currentAnimation = compound.exit;
    this.currentFrame = 0;
    this.frameAccumulator = 0;
    this._dirty = true;

    const prevCallback = this.onAnimationEnd;
    this.onAnimationEnd = (animName) => {
      if (animName === compound.exit) {
        this._exitTarget = null;
        this.currentAnimation = targetAnimation;
        this.currentFrame = 0;
        this.frameAccumulator = 0;
        this._dirty = true;
        this.onAnimationEnd = prevCallback;
      }
    };
  }

  /** 根据动画名获取对应的 spritesheet */
  _getSheetForAnimation(animName) {
    const extra = this._extraSheets.get(animName);
    if (extra?.loaded) return extra;
    return this._getDefaultSheet();
  }

  /** 根据成长阶段选择默认 spritesheet */
  _getDefaultSheet() {
    if (this._growthStage === 0 && this.spriteSheetKitten?.loaded) {
      return this.spriteSheetKitten;
    }
    return this._extraSheets.get('idle') || null;
  }

  /** 获取当前动画使用的 spritesheet */
  _getActiveSheet() {
    return this._getSheetForAnimation(this.currentAnimation);
  }

  /**
   * 设置水平翻转
   */
  setFlipX(flip) {
    if (this.flipX !== flip) {
      this.flipX = flip;
      this._dirty = true;
    }
  }

  /**
   * 启动渲染循环
   */
  start() {
    this.isPlaying = true;
    this._lastTime = performance.now();
    this._dirty = true;
    this._loop(this._lastTime);

    // 保底定时器：Windows 上拖拽窗口时 rAF 会停滞，用 setInterval 兜底
    // 200ms 间隔足以保证拖拽时动画不停，同时减少空闲开销
    this._fallbackTimer = setInterval(() => {
      const now = performance.now();
      const sinceLastRender = now - this._lastTime;
      if (sinceLastRender > 150) { // rAF 停滞超过 150ms
        this._lastTime = now;
        this._updateFrame(sinceLastRender);
        if (this._dirty) {
          this._render();
          this._dirty = false;
        }
      }
    }, 200);

    // 页面可见性：隐藏时暂停 rAF，可见时恢复
    this._onVisibilityChange = () => {
      if (document.hidden) {
        if (this._animFrameId) {
          cancelAnimationFrame(this._animFrameId);
          this._animFrameId = null;
        }
      } else if (this.isPlaying && !this._animFrameId) {
        this._lastTime = performance.now();
        this._dirty = true;
        this._loop(this._lastTime);
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /**
   * 停止渲染循环
   */
  stop() {
    this.isPlaying = false;
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    if (this._fallbackTimer) {
      clearInterval(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  /**
   * 渲染循环 — 只在帧变化或脏标记时重绘
   */
  _loop(timestamp) {
    if (!this.isPlaying) return;

    const deltaMs = timestamp - this._lastTime;
    this._lastTime = timestamp;

    this._updateFrame(deltaMs);

    // 只在视觉状态变化时重绘（帧变化、overlay 激活等）
    if (this._dirty || this._overlays.length > 0 || this.overlayDrawFn) {
      this._render();
      this._dirty = false;
    }

    this._animFrameId = requestAnimationFrame((t) => this._loop(t));
  }

  /**
   * 更新帧 — 帧变化时设置 _dirty 标记
   */
  _updateFrame(deltaMs) {
    const sheet = this._getActiveSheet();
    const fps = sheet.getFPS(this.currentAnimation);
    const frameDuration = 1000 / fps;
    const anim = sheet.getAnimation(this.currentAnimation);
    if (!anim) return;

    this.frameAccumulator += deltaMs;
    const prevFrame = this.currentFrame;

    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      this.currentFrame++;

      if (this.currentFrame >= anim.frames.length) {
        if (anim.loop) {
          this.currentFrame = 0;
        } else {
          this.currentFrame = anim.frames.length - 1;
          if (this.onAnimationEnd) {
            this.onAnimationEnd(this.currentAnimation);
          }
        }
      }
    }

    if (this.currentFrame !== prevFrame) {
      this._dirty = true;
    }
  }

  /**
   * 渲染当前帧
   */
  _render() {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 清除画布（透明）
    this.ctx.clearRect(0, 0, w, h);

    // 根据成长阶段选择 spritesheet 和 CSS filter
    const sheet = this._getActiveSheet();
    const stageFilters = [
      null,                               // 0: 幼猫 sprite 自带特征
      'brightness(1.12) saturate(0.8)',  // 1: 少年猫，偏亮淡
      null,                               // 2: 成年默认
      'saturate(1.25) brightness(0.92)', // 3: 更饱和
    ];
    const stageFilter = stageFilters[this._growthStage] || null;

    this.ctx.save();
    // filter 在 save 之后设置，restore 时自动归位，无需手动重置
    if (stageFilter) {
      this.ctx.filter = stageFilter;
    }
    this.ctx.translate(w / 2, h);          // 锚点移到底部中心

    // 角色放大（以底部中心为锚点）
    const baseScale = this._growthStage === 0 ? 0.85 : 1.0;
    const totalScale = baseScale * this.characterScale;
    this.ctx.scale(totalScale, totalScale);

    this.ctx.translate(-w / 2, -h);        // 还原

    // 绘制当前帧
    sheet.drawFrame(
      this.ctx,
      this.currentAnimation,
      this.currentFrame,
      0, 0,
      this.renderSize, this.renderSize,
      this.flipX
    );

    this.ctx.restore(); // 同时还原 filter、transform 等所有状态

    // overlay 绘制（叠加在猫咪之上）
    if (this.overlayDrawFn) {
      this.overlayDrawFn(this.ctx, w, h);
    }
    for (const fn of this._overlays) {
      fn(this.ctx, w, h);
    }
  }

  /**
   * 手动渲染单帧（用于暂停状态下的更新）
   */
  renderOnce() {
    this._dirty = true;
    this._render();
  }

  /**
   * 获取当前动画名
   */
  getCurrentAnimation() {
    return this.currentAnimation;
  }

  /**
   * 获取当前帧号
   */
  getCurrentFrame() {
    return this.currentFrame;
  }

  /**
   * 设置动画结束回调
   */
  setOnAnimationEnd(callback) {
    this.onAnimationEnd = callback;
  }

  /**
   * 销毁
   */
  destroy() {
    this.stop();
    this.onAnimationEnd = null;
  }
}
