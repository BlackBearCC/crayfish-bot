/**
 * SpriteSheet.js
 * Spritesheet 加载与解析
 *
 * 加载 spritesheet.png + spritesheet.json，提供按动画名+帧号获取帧数据的接口
 */

export class SpriteSheet {
  constructor() {
    this.image = null;
    this.meta = null;
    this.loaded = false;
  }

  /**
   * 加载 spritesheet 图片和元数据
   * @param {string} imagePath - spritesheet.png 路径
   * @param {string} metaPath - spritesheet.json 路径
   */
  async load(imagePath, metaPath) {
    const [image, metaResponse] = await Promise.all([
      this._loadImage(imagePath),
      fetch(metaPath).then(r => r.json())
    ]);

    this.image = image;
    this.meta = metaResponse;
    this.loaded = true;
  }

  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = async () => {
        // Chroma key: remove green background and make it transparent
        const processed = this._removeGreenBackground(img);
        // 转为 ImageBitmap 释放大 canvas 内存，GPU 友好
        const bitmap = await createImageBitmap(processed);
        resolve(bitmap);
      };
      img.onerror = (e) => reject(new Error(`Failed to load spritesheet: ${src}`));
      img.src = src;
    });
  }

  /**
   * Remove green (chroma key) background from spritesheet image
   * @param {HTMLImageElement} img
   * @returns {HTMLCanvasElement} processed canvas with transparent background
   */
  _removeGreenBackground(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Detect green-screen pixels: high green, low red & blue
      if (g > 120 && g > r * 1.4 && g > b * 1.4) {
        data[i + 3] = 0; // make transparent
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * 获取动画配置
   * @param {string} animationName
   * @returns {{ frames: Array, fps: number, loop: boolean }}
   */
  getAnimation(animationName) {
    if (!this.meta) return null;
    if (this.meta.animations[animationName]) return this.meta.animations[animationName];
    // Fallback to 'idle' frames when this sheet doesn't have the requested animation
    if (animationName !== 'idle' && this.meta.animations['idle']) {
      return this.meta.animations['idle'];
    }
    console.warn(`Animation "${animationName}" not found in spritesheet`);
    return null;
  }

  /**
   * 获取指定动画的指定帧
   * @param {string} animationName
   * @param {number} frameIndex
   * @returns {{ x, y, w, h } | null}
   */
  getFrame(animationName, frameIndex) {
    const anim = this.getAnimation(animationName);
    if (!anim) return null;
    const idx = frameIndex % anim.frames.length;
    return anim.frames[idx];
  }

  /**
   * 在 Canvas 上绘制指定帧
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} animationName
   * @param {number} frameIndex
   * @param {number} dx - 目标 x
   * @param {number} dy - 目标 y
   * @param {number} dw - 目标宽度
   * @param {number} dh - 目标高度
   * @param {boolean} flipX - 是否水平翻转
   */
  drawFrame(ctx, animationName, frameIndex, dx, dy, dw, dh, flipX = false) {
    if (!this.loaded) return;

    const frame = this.getFrame(animationName, frameIndex);
    if (!frame) return;

    ctx.save();

    if (flipX) {
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(
        this.image,
        frame.x, frame.y, frame.w, frame.h,
        0, 0, dw, dh
      );
    } else {
      ctx.drawImage(
        this.image,
        frame.x, frame.y, frame.w, frame.h,
        dx, dy, dw, dh
      );
    }

    ctx.restore();
  }

  /**
   * 获取动画帧数
   */
  getFrameCount(animationName) {
    const anim = this.getAnimation(animationName);
    return anim ? anim.frames.length : 0;
  }

  /**
   * 获取动画帧率
   */
  getFPS(animationName) {
    const anim = this.getAnimation(animationName);
    return anim ? anim.fps : 8;
  }

  /**
   * 获取所有动画名
   */
  getAnimationNames() {
    return this.meta ? Object.keys(this.meta.animations) : [];
  }
}
