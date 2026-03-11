/**
 * NurturingPanel.js
 * 养成面板 — 背包 / 每日任务 / 养护 / 商城
 *
 * 通过 characterRPC 调用服务端:
 *   character.inventory.list / character.inventory.use
 *   character.daily.tasks / character.daily.claim / character.daily.streak
 *   character.care.feed / character.care.play / character.care.heal / character.care.rest
 *   character.level.info / character.wallet.info
 *   character.shop.list / character.shop.buy
 */

const ICON_BASE = '../assets/icons';

/** 道具图标映射（itemId → 图片路径） */
const ITEM_ICONS = {
  // 中文 ID (后端实际使用)
  '42号口粮':      `${ICON_BASE}/food/ration_42.png`,
  '巴别鱼罐头':    `${ICON_BASE}/food/babel_fish_can.png`,
  '泛银河爆破饮':  `${ICON_BASE}/food/gargle_blaster.png`,
  '不要恐慌胶囊':  `${ICON_BASE}/food/dont_panic.png`,
  '马文牌退烧贴':  `${ICON_BASE}/medicine/marvin_patch.png`,
  '深思重启针':    `${ICON_BASE}/medicine/deep_thought.png`,
  '无限非概率逗猫器': `${ICON_BASE}/toy/improbability.png`,
  // 英文 ID (兼容旧版)
  ration_42:      `${ICON_BASE}/food/ration_42.png`,
  babel_fish_can: `${ICON_BASE}/food/babel_fish_can.png`,
  gargle_blaster: `${ICON_BASE}/food/gargle_blaster.png`,
  dont_panic:     `${ICON_BASE}/food/dont_panic.png`,
  marvin_patch:   `${ICON_BASE}/medicine/marvin_patch.png`,
  deep_thought:   `${ICON_BASE}/medicine/deep_thought.png`,
  improbability:  `${ICON_BASE}/toy/improbability.png`,
};

/** 任务难度图标 */
const TASK_ICONS = {
  easy:   `${ICON_BASE}/task/task_easy.png`,
  medium: `${ICON_BASE}/task/task_medium.png`,
  hard:   `${ICON_BASE}/task/task_hard.png`,
};

/** 养护动作图标 */
const ACTION_ICONS = {
  feed: `${ICON_BASE}/action/action_feed.png`,
  play: `${ICON_BASE}/action/action_play.png`,
  heal: `${ICON_BASE}/action/action_heal.png`,
  rest: `${ICON_BASE}/action/action_rest.png`,
};

export class NurturingPanel {
  /**
   * @param {Function} characterRPC - (method, params) => Promise (character.* gateway RPC)
   * @param {object} opts
   * @param {Function} [opts.isConnected] - () => boolean, 检查服务端是否在线
   */
  constructor(characterRPC, { onBubble, onAnimation, isConnected } = {}) {
    /** @type {(method: string, params?: object) => Promise<any>} */
    this._rawRpc = characterRPC;
    this._onBubble = onBubble || (() => {});
    this._onAnimation = onAnimation || (() => {});
    this._isConnected = isConnected || (() => true);
    this.isOpen = false;
    this._activeTab = 'inventory';
    this._createDOM();
  }

  /** RPC with 8s timeout to avoid hanging */
  async _rpc(method, params) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`RPC timeout: ${method}`)), 8000));
    try {
      const result = await Promise.race([this._rawRpc(method, params || {}), timeout]);
      if (result?._error) throw new Error(result._error);
      return result;
    } catch (err) {
      console.warn(`[nurturing] ${method} failed:`, err?.message || err);
      throw err;
    }
  }

  // ───────────────── DOM ─────────────────

  _createDOM() {
    this.element = document.createElement('div');
    this.element.id = 'nurturing-panel';
    this.element.innerHTML = `
      <div class="nur-header">
        <span>🐾 养成</span>
        <button class="nur-close">✕</button>
      </div>
      <div class="nur-level-bar"></div>
      <div class="nur-tabs">
        <button class="nur-tab active" data-tab="inventory">🎒 背包</button>
        <button class="nur-tab" data-tab="tasks">📋 任务</button>
        <button class="nur-tab" data-tab="care">💗 养护</button>
        <button class="nur-tab" data-tab="shop">🪙 商城</button>
      </div>
      <div class="nur-body">
        <div class="nur-loading">加载中...</div>
      </div>
    `;
    this.element.querySelector('.nur-close').onclick = () => this.close();
    this.element.querySelectorAll('.nur-tab').forEach(btn => {
      btn.onclick = () => this._switchTab(btn.dataset.tab);
    });
    document.body.appendChild(this.element);
  }

  // ───────────────── Open / Close ─────────────────

  async open() {
    this.isOpen = true;
    this.element.classList.add('open');
    this.onStateChange?.();
    await this._refresh();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.element.classList.remove('open');
    this.onStateChange?.();
  }

  closeQuiet() {
    this.isOpen = false;
    this.element.classList.remove('open');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  async _switchTab(tab) {
    this._activeTab = tab;
    this.element.querySelectorAll('.nur-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    await this._refresh();
  }

  async _refresh() {
    const body = this.element.querySelector('.nur-body');
    const bar = this.element.querySelector('.nur-level-bar');

    if (!this._isConnected()) {
      bar.innerHTML = '';
      body.innerHTML = '<div class="nur-empty">🔌 Gateway 未连接<br><br>请确保 PetClaw Gateway 已启动后重试</div>';
      return;
    }

    // Level bar 不阻塞主体渲染
    this._renderLevelBar().catch(() => {});
    body.innerHTML = '<div class="nur-loading">加载中...</div>';
    try {
      if (this._activeTab === 'inventory') await this._renderInventory(body);
      else if (this._activeTab === 'tasks') await this._renderTasks(body);
      else if (this._activeTab === 'care') await this._renderCare(body);
      else if (this._activeTab === 'shop') await this._renderShop(body);
    } catch (err) {
      console.error('[nurturing] render error:', err);
      body.innerHTML = `<div class="nur-empty">加载失败: ${this._esc(String(err?.message || err))}</div>`;
    }
  }

  // ───────────────── Level Bar ─────────────────

  async _renderLevelBar() {
    const bar = this.element.querySelector('.nur-level-bar');
    try {
      const [levelInfo, streakInfo] = await Promise.all([
        this._rpc('character.level.info'),
        this._rpc('character.daily.streak'),
      ]);
      const pct = levelInfo.expToNext > 0
        ? Math.round(((levelInfo.exp - levelInfo.currentLevelExp) / (levelInfo.expToNext - levelInfo.currentLevelExp)) * 100)
        : 100;
      bar.innerHTML = `
        <div class="nur-level-info">
          <span class="nur-level-badge">Lv.${levelInfo.level}</span>
          <span class="nur-level-title">${this._esc(levelInfo.title || '')}</span>
          <span class="nur-streak">🔥 ${streakInfo.streak || 0}天</span>
        </div>
        <div class="nur-exp-track">
          <div class="nur-exp-fill" style="width:${pct}%"></div>
        </div>
        <div class="nur-exp-text">${levelInfo.exp} / ${levelInfo.expToNext} EXP</div>
      `;
    } catch (err) {
      console.warn('[nurturing] level bar error:', err);
      bar.innerHTML = '<div class="nur-exp-text">等级信息加载失败</div>';
    }
  }

  // ───────────────── Inventory Tab ─────────────────

  async _renderInventory(body) {
    try {
      const data = await this._rpc('character.inventory.list');
      const items = data?.items || [];
      if (!items.length) {
        body.innerHTML = '<div class="nur-empty">背包空空如也~<br>完成每日任务获取道具吧！</div>';
        return;
      }

      const cards = items.map(item => {
        const icon = ITEM_ICONS[item.itemId] || '';
        const cdLeft = this._cooldownLeft(item);
        const disabled = !item.canUse;
        const def = item.def || {};
        return `
          <div class="nur-item-card ${disabled ? 'nur-disabled' : ''}" data-item-id="${item.itemId}">
            <div class="nur-item-icon">
              ${icon ? `<img src="${icon}" alt="${this._esc(def.name)}">` : `<span>${def.icon || '📦'}</span>`}
            </div>
            <div class="nur-item-info">
              <div class="nur-item-name">${this._esc(def.name || item.itemId)}</div>
              <div class="nur-item-desc">${this._esc(def.description || '')}</div>
              ${cdLeft ? `<div class="nur-item-cd">⏳ ${cdLeft}</div>` : ''}
            </div>
            <div class="nur-item-qty">${def.permanent ? '∞' : `×${item.quantity}`}</div>
          </div>
        `;
      }).join('');

      body.innerHTML = `
        <div class="nur-inv-summary">${items.length} / ${data.capacity || '?'} 格</div>
        <div class="nur-item-list">${cards}</div>
      `;

      // 点击使用道具
      body.querySelectorAll('.nur-item-card:not(.nur-disabled)').forEach(el => {
        el.onclick = () => this._useItem(el.dataset.itemId);
      });
    } catch (err) {
      console.error('[nurturing] inventory error:', err);
      body.innerHTML = `<div class="nur-empty">背包加载失败<br><small>${this._esc(String(err?.message || err))}</small></div>`;
    }
  }

  async _useItem(itemId) {
    try {
      const result = await this._rpc('character.inventory.use', { itemId });
      if (result?.ok) {
        const itemName = ITEM_ICONS[itemId] ? itemId : '道具';
        this._onBubble(['用了好东西~', '感觉不错！', '谢谢主人！'][Math.floor(Math.random() * 3)]);
      } else {
        this._onBubble(result?.reason || '现在用不了...');
      }
      await this._refresh();
    } catch {
      this._onBubble('出了点问题...');
    }
  }

  _cooldownLeft(item) {
    const remain = item.cooldownRemaining || 0;
    if (remain <= 0) return '';
    if (remain < 60000) return `${Math.ceil(remain / 1000)}秒`;
    if (remain < 3600000) return `${Math.ceil(remain / 60000)}分钟`;
    return `${(remain / 3600000).toFixed(1)}小时`;
  }

  // ───────────────── Tasks Tab ─────────────────

  async _renderTasks(body) {
    try {
      const [data, streakData] = await Promise.all([
        this._rpc('character.daily.tasks'),
        this._rpc('character.daily.streak'),
      ]);
      const tasks = data?.tasks || [];
      const counters = data?.counters || {};

      if (!tasks.length) {
        body.innerHTML = '<div class="nur-empty">今日任务尚未生成</div>';
        return;
      }

      const cards = tasks.map(t => {
        const icon = TASK_ICONS[t.difficulty] || TASK_ICONS.easy;
        const isDone = t.status === 'completed' || t.status === 'claimed';
        const canClaim = t.status === 'completed';
        const progressPct = t.progress != null ? Math.min(100, Math.round(t.progress * 100)) : (isDone ? 100 : 0);
        const rewardStr = this._formatReward(t.reward);

        return `
          <div class="nur-task-card ${isDone ? 'nur-task-done' : ''}">
            <div class="nur-task-icon"><img src="${icon}" alt="${t.difficulty}"></div>
            <div class="nur-task-body">
              <div class="nur-task-name">${this._esc(t.name)}</div>
              <div class="nur-task-desc">${this._esc(t.description || '')}</div>
              <div class="nur-task-progress-track">
                <div class="nur-task-progress-fill" style="width:${progressPct}%"></div>
              </div>
              <div class="nur-task-meta">
                <span class="nur-task-reward">${rewardStr}</span>
                ${t.status === 'claimed' ? '<span class="nur-task-claimed">✅ 已领取</span>' : ''}
              </div>
            </div>
            ${canClaim ? `<button class="nur-task-claim" data-task-id="${t.id}">领取</button>` : ''}
          </div>
        `;
      }).join('');

      const onlineMin = streakData?.todayOnlineMinutes || 0;
      body.innerHTML = `
        <div class="nur-task-header">
          <span>今日在线 ${onlineMin} 分钟</span>
        </div>
        <div class="nur-task-list">${cards}</div>
      `;

      body.querySelectorAll('.nur-task-claim').forEach(btn => {
        btn.onclick = () => this._claimTask(btn.dataset.taskId);
      });
    } catch (err) {
      console.error('[nurturing] tasks error:', err);
      body.innerHTML = `<div class="nur-empty">任务加载失败<br><small>${this._esc(String(err?.message || err))}</small></div>`;
    }
  }

  async _claimTask(taskId) {
    try {
      const result = await this._rpc('character.daily.claim', { taskId });
      if (result?.ok) {
        const rewardStr = this._formatReward(result.reward);
        this._onBubble(`任务完成！获得 ${rewardStr}`);
      } else {
        this._onBubble(result?.reason || '还没完成呢~');
      }
      await this._refresh();
    } catch {
      this._onBubble('领取失败...');
    }
  }

  _formatReward(reward) {
    if (!reward) return '';
    const parts = [];
    if (reward.exp) parts.push(`+${reward.exp} EXP`);
    if (reward.coins) parts.push(`+${reward.coins} 🪙`);
    if (reward.items?.length) {
      for (const ri of reward.items) {
        parts.push(`${ri.id} ×${ri.qty}`);
      }
    }
    return parts.join(' · ');
  }

  // ───────────────── Care Tab ─────────────────

  async _renderCare(body) {
    const careActions = [
      { id: 'feed',  label: '喂食',   icon: ACTION_ICONS.feed, method: 'character.care.feed', desc: '恢复饱食度',
        needsItem: true, itemCategory: 'food',
      },
      { id: 'play',  label: '玩耍',   icon: ACTION_ICONS.play, method: 'character.care.play', desc: '提升心情',
        options: [
          { id: 'pet_stroke', label: '抚摸' },
          { id: 'hide_seek', label: '捉迷藏' },
          { id: 'sunbathe', label: '晒太阳' },
        ]
      },
      { id: 'heal',  label: '治疗',   icon: ACTION_ICONS.heal, method: 'character.care.heal', desc: '恢复健康',
        needsItem: true, itemCategory: 'medicine',
      },
      { id: 'rest',  label: '休息',   icon: ACTION_ICONS.rest, method: 'character.care.rest', desc: '恢复健康与心情',
        options: [
          { id: 'nap', label: '小憩 (15分钟)' },
          { id: 'deep_sleep', label: '深度睡眠 (1小时)' },
        ]
      },
    ];

    // 获取背包道具用于喂食/治疗选择
    let foodItems = [];
    let medicineItems = [];
    try {
      const inv = await this._rpc('character.inventory.list');
      console.log('[nurturing] inventory loaded:', inv?.items?.length, 'items');
      for (const item of (inv?.items || [])) {
        const cat = item.def?.category;
        // 包含 canUse=false 的物品，但显示冷却状态
        if (cat === 'food') foodItems.push(item);
        if (cat === 'medicine') medicineItems.push(item);
      }
      console.log('[nurturing] foodItems:', foodItems.length, 'medicineItems:', medicineItems.length);
    } catch (e) {
      console.warn('[nurturing] inventory load failed:', e);
    }

    const cards = careActions.map(a => {
      let optionsHtml = '';
      if (a.options) {
        optionsHtml = `<div class="nur-care-options">${a.options.map(o =>
          `<button class="nur-care-opt" data-method="${a.method}" data-param="${o.id}">${o.label}</button>`
        ).join('')}</div>`;
      } else if (a.needsItem) {
        // 根据类型选择物品列表
        const itemList = a.itemCategory === 'food' ? foodItems : medicineItems;
        const availableItems = itemList.filter(i => i.canUse);
        const cooldownItems = itemList.filter(i => !i.canUse);
        
        if (availableItems.length > 0) {
          optionsHtml = `<div class="nur-care-options">${availableItems.map(i => {
            const icon = ITEM_ICONS[i.itemId] || '';
            return `<button class="nur-care-opt nur-care-item-opt" data-method="${a.method}" data-param="${i.itemId}">
              ${icon ? `<img src="${icon}" class="nur-opt-icon">` : ''} ${this._esc(i.def?.name || i.itemId)}
            </button>`;
          }).join('')}</div>`;
        } else {
          optionsHtml = `<div class="nur-care-no-items">没有可用${a.itemCategory === 'food' ? '食物' : '药品'}</div>`;
        }
        
        // 显示冷却中的物品
        if (cooldownItems.length > 0) {
          const cdHtml = cooldownItems.map(i => {
            const cdLeft = this._cooldownLeft(i);
            return `<span class="nur-care-cd-item">${this._esc(i.def?.name || i.itemId)} ${cdLeft ? `(${cdLeft})` : ''}</span>`;
          }).join(' ');
          optionsHtml += `<div class="nur-care-cd-list">冷却中: ${cdHtml}</div>`;
        }
      } else {
        optionsHtml = `<button class="nur-care-go" data-method="${a.method}">执行</button>`;
      }

      return `
        <div class="nur-care-card">
          <div class="nur-care-icon"><img src="${a.icon}" alt="${a.label}"></div>
          <div class="nur-care-info">
            <div class="nur-care-label">${a.label}</div>
            <div class="nur-care-desc">${a.desc}</div>
            ${optionsHtml}
          </div>
        </div>
      `;
    }).join('');

    body.innerHTML = `<div class="nur-care-list">${cards}</div>`;

    // 绑定按钮事件
    body.querySelectorAll('.nur-care-opt, .nur-care-go').forEach(btn => {
      btn.onclick = () => this._doCare(btn.dataset.method, btn.dataset.param);
    });
  }

  async _doCare(method, param) {
    try {
      const params = {};
      if (method === 'character.care.feed') params.itemId = param || '42号口粮';
      else if (method === 'character.care.play') params.actionId = param || 'pet_stroke';
      else if (method === 'character.care.heal') params.itemId = param;
      else if (method === 'character.care.rest') params.typeId = param || 'nap';

      const result = await this._rpc(method, params);
      if (result?.ok) {
        const msgs = {
          'character.care.feed': ['好吃！~ 😋', '满足~', '还想要！'],
          'character.care.play': ['好好玩！', '开心！', '再来！'],
          'character.care.heal': ['感觉好多了~', '谢谢照顾！', '舒服~'],
          'character.care.rest': ['困了...zzZ', '晚安~', '让我眯一会儿...'],
        };
        const pool = msgs[method] || ['好的~'];
        this._onBubble(pool[Math.floor(Math.random() * pool.length)]);

        if (method === 'character.care.play') this._onAnimation('happy');
        if (method === 'character.care.rest') this._onAnimation('sleep');
      } else {
        this._onBubble(result?.reason || '现在不行...');
      }
      await this._refresh();
    } catch {
      this._onBubble('出了点问题...');
    }
  }

  // ───────────────── Shop Tab ─────────────────

  async _renderShop(body) {
    try {
      const data = await this._rpc('character.shop.list');
      const items = data?.items || [];
      const wallet = data?.wallet || { coins: 0 };

      const cards = items.map(item => {
        const icon = ITEM_ICONS[item.id] || '';
        const disabled = !item.canBuy;
        const limitStr = this._shopLimitStr(item);

        return `
          <div class="nur-shop-card ${disabled ? 'nur-disabled' : ''}" data-item-id="${item.id}">
            <div class="nur-shop-icon">
              ${icon ? `<img src="${icon}" alt="${this._esc(item.id)}">` : '<span>📦</span>'}
            </div>
            <div class="nur-shop-info">
              <div class="nur-shop-name">${this._esc(item.id)}</div>
              <div class="nur-shop-limit">${limitStr}</div>
              ${disabled && item.reason ? `<div class="nur-shop-reason">${this._esc(item.reason)}</div>` : ''}
            </div>
            <div class="nur-shop-price">
              <span class="nur-coin-icon">🪙</span> ${item.price}
            </div>
            ${!disabled ? `<button class="nur-shop-buy" data-item-id="${item.id}">购买</button>` : ''}
          </div>
        `;
      }).join('');

      body.innerHTML = `
        <div class="nur-shop-wallet">
          <span class="nur-coin-icon">🪙</span>
          <span class="nur-coin-balance">${wallet.coins}</span>
          <span class="nur-coin-label">星币</span>
        </div>
        <div class="nur-shop-list">${cards}</div>
      `;

      body.querySelectorAll('.nur-shop-buy').forEach(btn => {
        btn.onclick = () => this._buyItem(btn.dataset.itemId);
      });
    } catch (err) {
      console.error('[nurturing] shop error:', err);
      body.innerHTML = `<div class="nur-empty">商城加载失败<br><small>${this._esc(String(err?.message || err))}</small></div>`;
    }
  }

  async _buyItem(itemId) {
    try {
      const result = await this._rpc('character.shop.buy', { itemId, qty: 1 });
      if (result?.ok) {
        const bal = result.wallet?.coins ?? '?';
        this._onBubble(`买到了！剩余 ${bal} 🪙`);
      } else {
        this._onBubble(result?.reason || '买不了...');
      }
      await this._refresh();
    } catch {
      this._onBubble('购买失败...');
    }
  }

  _shopLimitStr(item) {
    const parts = [];
    if (item.dailyLimit > 0) {
      parts.push(`今日 ${item.todayBought}/${item.dailyLimit}`);
    }
    if (item.weeklyLimit) {
      parts.push(`本周 ${item.weekBought}/${item.weeklyLimit}`);
    }
    return parts.join(' · ') || '不限购';
  }

  // ───────────────── Util ─────────────────

  _esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  destroy() {
    this.element?.remove();
  }
}
