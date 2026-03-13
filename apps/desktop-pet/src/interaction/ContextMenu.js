/**
 * ContextMenu.js
 * 自定义右键菜单 — 手绘线条风格，与整体 UI 一致
 *
 * items 格式:
 *   { icon, label, action }          普通项
 *   { icon, label, action, checked } 可勾选项（checked 为 boolean 或 () => boolean）
 *   { type: 'separator' }            分割线
 */

export class ContextMenu {
  /**
   * @param {HTMLElement} trigger - 触发右键的元素
   * @param {Array} items - 菜单项列表
   * @param {() => {hunger:number, mood:number, health:number}} [getStats] - 可选，返回当前养成数值
   */
  constructor(trigger, items, getStats, { onOpen, onClose } = {}) {
    this.trigger = trigger;
    this.items = items;
    this.getStats = getStats || null;
    this._onOpen = onOpen || null;
    this._onClose = onClose || null;
    this._menu = null;

    this._onContextMenu = this._onContextMenu.bind(this);
    this._dismiss = this._dismiss.bind(this);
    this.trigger.addEventListener('contextmenu', this._onContextMenu);
  }

  _onContextMenu(e) {
    e.preventDefault();
    this._show(e.clientX, e.clientY);
  }

  _show(x, y) {
    this._dismiss();

    const menu = document.createElement('div');
    menu.className = 'custom-context-menu';

    // 角色状态卡（顶部）
    if (this.getStats) {
      const s = this.getStats();
      const iconBase = '../assets/icons';
      const lv = s.level || {};
      const lvNum = lv.level ?? 1;
      const lvTitle = lv.title ?? '';
      const stageName = s.growthStageName || '';
      const expPct = lv.nextLevelExp > lv.currentLevelExp
        ? Math.min(100, Math.round(((lv.exp - lv.currentLevelExp) / (lv.nextLevelExp - lv.currentLevelExp)) * 100))
        : 100;

      // — 等级头部 —
      const header = document.createElement('div');
      header.className = 'ctx-level-header';
      header.innerHTML = `
        <div class="ctx-level-top">
          <span class="ctx-level-badge">Lv.${lvNum}</span>
          <span class="ctx-level-title">${lvTitle}</span>
          <span class="ctx-level-stage">${stageName}</span>
        </div>
        <div class="ctx-level-exp">
          <div class="ctx-level-exp-track"><div class="ctx-level-exp-fill" style="width:${expPct}%"></div></div>
          <span class="ctx-level-exp-text">${lv.expToNext > 0 ? `${lv.expToNext} EXP` : 'MAX'}</span>
        </div>`;
      menu.appendChild(header);

      // — 属性进度条 —
      const statInfo = [
        { key: 'hunger', maxKey: 'hungerMax', fallbackMax: 300, icon: `${iconBase}/attribute/attr_hunger.png`, label: '饱食度', desc: '角色的饱腹程度，低于30会变得饥饿' },
        { key: 'mood', maxKey: 'moodMax', fallbackMax: 100, icon: `${iconBase}/attribute/attr_mood.png`, label: '心情', desc: '角色的心情好坏，低于30会变得沮丧' },
        { key: 'health', maxKey: 'healthMax', fallbackMax: 100, icon: `${iconBase}/attribute/attr_health.png`, label: '健康', desc: '角色的身体健康，低于40会生病' },
      ];
      const block = document.createElement('div');
      block.className = 'ctx-stats';
      block.innerHTML = statInfo.map(st => {
        const max = s[st.maxKey] || st.fallbackMax;
        const pct = Math.min(100, Math.round((s[st.key] / max) * 100));
        return `
        <div class="ctx-stat-row" title="${st.label} — ${st.desc}">
          <span class="ctx-stat-icon"><img src="${st.icon}" alt="${st.label}"></span>
          <div class="ctx-stat-track"><div class="ctx-stat-fill ctx-stat--${st.key}" style="width:${pct}%"></div></div>
          <span class="ctx-stat-value">${Math.round(s[st.key])}</span>
        </div>`;
      }).join('');
      menu.appendChild(block);

      const sep = document.createElement('div');
      sep.className = 'ctx-separator';
      menu.appendChild(sep);
    }

    for (const item of this.items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'ctx-separator';
        menu.appendChild(sep);
        continue;
      }

      const btn = document.createElement('button');
      btn.className = 'ctx-item';
      const checked = typeof item.checked === 'function' ? item.checked() : item.checked;
      if (checked) btn.classList.add('checked');

      btn.innerHTML = `
        <span class="ctx-icon">${item.icon || ''}</span>
        <span class="ctx-label">${item.label}</span>
        ${checked !== undefined ? `<span class="ctx-check">${checked ? '✓' : ''}</span>` : ''}
      `;

      btn.addEventListener('click', () => {
        this._dismiss();
        item.action?.();
      });

      menu.appendChild(btn);
    }

    // 先挂载再定位（需要 getBoundingClientRect）
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);
    this._menu = menu;

    // 防止超出屏幕
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)  menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

    // 入场动画
    requestAnimationFrame(() => menu.classList.add('visible'));

    // 菜单展开：禁用鼠标穿透，确保点击任何位置都能被捕获
    this._onOpen?.();

    // 点击外部、右键别处或按 Esc 关闭
    setTimeout(() => {
      document.addEventListener('click', this._dismiss, { once: true });
      document.addEventListener('contextmenu', this._dismiss, { once: true });
    }, 0);
    document.addEventListener('keydown', this._onKeyDown = (e) => {
      if (e.key === 'Escape') this._dismiss();
    }, { once: true });
  }

  _dismiss() {
    if (!this._menu) return;
    this._menu.remove();
    this._menu = null;
    document.removeEventListener('click', this._dismiss);
    document.removeEventListener('contextmenu', this._dismiss);
    // 菜单关闭：恢复正常鼠标穿透逻辑
    this._onClose?.();
  }

  destroy() {
    this._dismiss();
    this.trigger.removeEventListener('contextmenu', this._onContextMenu);
  }
}
