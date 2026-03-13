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
  constructor(characterRPC, { onBubble, onAnimation, isConnected, onNavigate } = {}) {
    /** @type {(method: string, params?: object) => Promise<any>} */
    this._rawRpc = characterRPC;
    this._onBubble = onBubble || (() => {});
    this._onAnimation = onAnimation || (() => {});
    this._isConnected = isConnected || (() => true);
    /** @type {{ skillPanel?: Function, memoryGraph?: Function }} */
    this._onNavigate = onNavigate || {};
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
        <div class="nur-header-actions">
          <button class="nur-nav-btn" data-nav="skillPanel" title="图鉴">📖</button>
          <button class="nur-nav-btn" data-nav="memoryGraph" title="记忆图谱">🧠</button>
          <button class="nur-close">✕</button>
        </div>
      </div>
      <div class="nur-level-bar"></div>
      <div class="nur-tabs">
        <button class="nur-tab active" data-tab="inventory">🎒 背包</button>
        <button class="nur-tab" data-tab="tasks">📋 任务</button>
        <button class="nur-tab" data-tab="care">💗 养护</button>
        <button class="nur-tab" data-tab="adventure">🗺️ 探险</button>
        <button class="nur-tab" data-tab="horror">👻 怪谈</button>
        <button class="nur-tab" data-tab="shop">🪙 商城</button>
      </div>
      <div class="nur-body">
        <div class="nur-loading">加载中...</div>
      </div>
    `;
    this.element.querySelector('.nur-close').onclick = () => this.close();
    this.element.querySelectorAll('.nur-nav-btn').forEach(btn => {
      btn.onclick = () => { this.close(); this._onNavigate[btn.dataset.nav]?.(); };
    });
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
      else if (this._activeTab === 'adventure') await this._renderAdventure(body);
      else if (this._activeTab === 'horror') await this._renderHorror(body);
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

  // ───────────────── Adventure (v2: Rumor Card + Encounter) ─────────────────

  /** Theme → emoji mapping for rumor cards */
  _themeEmoji(theme) {
    const map = { forest: '🌲', ruin: '🏚️', water: '🌊', cave: '🕳️', town: '🏘️', sky: '☁️' };
    return map[theme] || '🗺️';
  }

  /** Risk → star string */
  _stars(risk) {
    return '★'.repeat(risk) + '☆'.repeat(3 - risk);
  }

  async _renderAdventure(body) {
    body.innerHTML = '<div class="nur-loading">加载中...</div>';
    try {
      const [activeData, historyData] = await Promise.all([
        this._rpc('character.adventure.active'),
        this._rpc('character.adventure.history'),
      ]);

      const active = activeData?.adventure;
      const stats = activeData?.stats || {};
      const history = historyData?.history || [];

      if (active && active.status === 'exploring') {
        await this._renderActiveAdventure(body, active);
      } else if (active && active.status === 'completed' && active.result) {
        this._renderSettlement(body, active);
      } else {
        await this._renderRumorBoard(body, stats, history);
      }
    } catch (err) {
      console.error('[nurturing] adventure error:', err);
      body.innerHTML = `<div class="nur-empty">探险加载失败<br><small>${this._esc(String(err?.message || err))}</small></div>`;
    }
  }

  // ── Rumor Board (no active adventure) ──

  async _renderRumorBoard(body, stats, history) {
    // Show skeleton while loading rumors
    body.innerHTML = `
      <div class="nur-adv-rumor-board">
        <div class="nur-adv-board-header">
          <span class="nur-adv-board-title">线索板</span>
          <span class="nur-adv-board-count">${stats.total || 0} 次探险</span>
        </div>
        <div class="nur-adv-cards">
          <div class="nur-adv-card nur-adv-card-skeleton"><div class="nur-shimmer"></div></div>
          <div class="nur-adv-card nur-adv-card-skeleton"><div class="nur-shimmer"></div></div>
          <div class="nur-adv-card nur-adv-card-skeleton"><div class="nur-shimmer"></div></div>
        </div>
      </div>
    `;

    // Fetch rumor cards (longer timeout for LLM generation)
    let rumors = [];
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000));
      const result = await Promise.race([this._rawRpc('character.adventure.rumors', {}), timeout]);
      rumors = result?.rumors || [];
    } catch {
      rumors = [];
    }

    // Build cards HTML
    const cardsHtml = rumors.length >= 3
      ? rumors.map((card, i) => `
          <div class="nur-adv-card nur-adv-card-theme-${this._esc(card.theme)} nur-adv-card-risk-${card.risk}"
               data-card-id="${card.id}" style="animation-delay: ${i * 0.15}s">
            <div class="nur-adv-card-hook">
              <span class="nur-adv-card-emoji">${this._themeEmoji(card.theme)}</span>
              ${this._esc(card.hook)}
            </div>
            <div class="nur-adv-card-meta">
              <span class="nur-adv-card-stars">${this._stars(card.risk)}</span>
              <span class="nur-adv-card-sep">&middot;</span>
              <span class="nur-adv-card-duration">~${card.duration}分钟</span>
            </div>
          </div>
        `).join('')
      : '<div class="nur-empty">线索卡生成失败，请点击刷新重试</div>';

    body.innerHTML = `
      <div class="nur-adv-rumor-board">
        <div class="nur-adv-board-header">
          <span class="nur-adv-board-title">线索板</span>
          <span class="nur-adv-board-count">${stats.total || 0} 次探险</span>
        </div>
        <div class="nur-adv-cards">${cardsHtml}</div>
        <button class="nur-adv-refresh-btn">🔄 换一批</button>
        ${history.length > 0 ? `
          <div class="nur-adv-history">
            <div class="nur-adv-history-title">── 最近探险 ──</div>
            ${history.slice(0, 5).map(h => `
              <div class="nur-adv-history-item ${h.result?.success ? 'success' : 'fail'}">
                <span class="nur-adv-hist-loc">${this._esc(h.card?.location || '未知')}</span>
                <span class="nur-adv-hist-reward">${h.result?.success ? `+${h.result.rewards?.exp || 0} EXP` : ''}</span>
                <span class="nur-adv-hist-result">${h.result?.success ? '✓' : '✗'}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;

    // Bind card clicks → start adventure
    body.querySelectorAll('.nur-adv-card[data-card-id]').forEach(el => {
      el.onclick = () => this._startFromCard(el.dataset.cardId, body);
    });

    // Bind refresh button
    const refreshBtn = body.querySelector('.nur-adv-refresh-btn');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '🔄 加载中...';
        await this._refresh();
      };
    }
  }

  async _startFromCard(cardId, body) {
    // Show loading state on the clicked card
    const card = body.querySelector(`[data-card-id="${cardId}"]`);
    if (card) {
      card.classList.add('nur-adv-card-loading');
      card.innerHTML = '<div class="nur-shimmer"></div><div class="nur-adv-card-loading-text">生成探险故事中...</div>';
    }

    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000));
      const result = await Promise.race([this._rawRpc('character.adventure.start', { cardId }), timeout]);

      if (result?.ok) {
        this._onBubble(`出发探险啦！`);
        await this._refresh();
      } else {
        this._onBubble(result?.error || '出发失败...');
        await this._refresh();
      }
    } catch {
      this._onBubble('出发失败...');
      await this._refresh();
    }
  }

  // ── Active Adventure (timeline view) ──

  async _renderActiveAdventure(body, adventure) {
    const card = adventure.card || {};
    const elapsed = Math.floor((Date.now() - adventure.startedAt) / 1000);
    const durationSec = (card.duration || 5) * 60;
    const remaining = Math.max(0, durationSec - elapsed);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const progressPct = Math.min(100, Math.round((elapsed / durationSec) * 100));

    // Build encounter timeline
    const encounterNodes = (adventure.encounters || []).map((enc, i) => {
      const isTriggered = !!enc.triggeredAt;
      const isCurrent = isTriggered && enc.type === 'choice' && !enc.selectedChoice;
      const isResolved = !!enc.resolvedAt || (enc.type !== 'choice' && isTriggered);

      if (!isTriggered) {
        // Not yet triggered
        return `
          <div class="nur-adv-tl-node nur-adv-tl-pending">
            <div class="nur-adv-tl-dot nur-adv-tl-dot-empty"></div>
            <div class="nur-adv-tl-card nur-adv-tl-card-pending">???</div>
          </div>
        `;
      }

      let nodeClass = 'nur-adv-tl-narration';
      let dotClass = 'nur-adv-tl-dot-gray';
      let cardContent = `<div class="nur-adv-tl-text">${this._esc(enc.text)}</div>`;

      if (enc.type === 'discovery') {
        nodeClass = 'nur-adv-tl-discovery';
        dotClass = 'nur-adv-tl-dot-gold';
        const rewardText = enc.reward?.coins ? `+${enc.reward.coins} 🪙` : '';
        const itemText = enc.reward?.item ? ` 🎁 ${this._esc(enc.reward.item)}` : '';
        cardContent = `
          <div class="nur-adv-tl-text">${this._esc(enc.text)}</div>
          ${rewardText || itemText ? `<div class="nur-adv-tl-reward">${rewardText}${itemText}</div>` : ''}
        `;
      } else if (enc.type === 'choice') {
        if (isCurrent) {
          // Awaiting player choice
          nodeClass = 'nur-adv-tl-choice-pending';
          dotClass = 'nur-adv-tl-dot-pulse';
          const choiceTimeLeft = enc.triggeredAt ? Math.max(0, 60 - Math.floor((Date.now() - enc.triggeredAt) / 1000)) : 60;
          cardContent = `
            <div class="nur-adv-tl-text">${this._esc(enc.text)}</div>
            <div class="nur-adv-tl-countdown">${choiceTimeLeft}s</div>
            <div class="nur-adv-tl-choices">
              <button class="nur-adv-tl-choice-btn" data-enc-id="${enc.id}" data-choice="a">${this._esc(enc.choices?.a || 'A')}</button>
              <button class="nur-adv-tl-choice-btn" data-enc-id="${enc.id}" data-choice="b">${this._esc(enc.choices?.b || 'B')}</button>
            </div>
          `;
        } else {
          // Already chosen
          nodeClass = 'nur-adv-tl-choice-done';
          dotClass = 'nur-adv-tl-dot-green';
          const selA = enc.selectedChoice === 'a';
          cardContent = `
            <div class="nur-adv-tl-text">${this._esc(enc.text)}</div>
            <div class="nur-adv-tl-choices-done">
              <span class="nur-adv-tl-opt ${selA ? 'nur-adv-tl-opt-sel' : 'nur-adv-tl-opt-dim'}">${this._esc(enc.choices?.a || 'A')}</span>
              <span class="nur-adv-tl-opt ${!selA ? 'nur-adv-tl-opt-sel' : 'nur-adv-tl-opt-dim'}">${this._esc(enc.choices?.b || 'B')}</span>
            </div>
            ${enc.petDecided ? '<div class="nur-adv-tl-pet-decided">宠物自己选的</div>' : ''}
          `;
        }
      }

      return `
        <div class="nur-adv-tl-node ${nodeClass}">
          <div class="nur-adv-tl-dot ${dotClass}"></div>
          <div class="nur-adv-tl-card">${cardContent}</div>
        </div>
      `;
    }).join('');

    body.innerHTML = `
      <div class="nur-adv-active">
        <div class="nur-adv-active-header">
          <div class="nur-adv-active-title">
            <span>${this._themeEmoji(card.theme)} ${this._esc(card.location || '未知地点')}</span>
            <span class="nur-adv-active-stars">${this._stars(card.risk || 1)}</span>
          </div>
          <div class="nur-adv-active-timer">${mins}:${secs.toString().padStart(2, '0')}</div>
          <div class="nur-adv-progress-track">
            <div class="nur-adv-progress-fill" style="width:${progressPct}%"></div>
          </div>
        </div>

        <div class="nur-adv-timeline">
          ${adventure.story ? `
            <div class="nur-adv-tl-node nur-adv-tl-start">
              <div class="nur-adv-tl-dot nur-adv-tl-dot-gray"></div>
              <div class="nur-adv-tl-card nur-adv-tl-card-story">${this._esc(adventure.story)}</div>
            </div>
          ` : ''}
          ${encounterNodes}
          <div class="nur-adv-tl-node nur-adv-tl-end">
            <div class="nur-adv-tl-dot nur-adv-tl-dot-end"></div>
            <div class="nur-adv-tl-card nur-adv-tl-card-pending">结算</div>
          </div>
        </div>

        <button class="nur-adv-cancel-btn" data-id="${adventure.id}">取消探险</button>
      </div>
    `;

    // Bind choice buttons
    body.querySelectorAll('.nur-adv-tl-choice-btn').forEach(btn => {
      btn.onclick = async () => {
        try {
          const result = await this._rpc('character.adventure.choice', {
            adventureId: adventure.id,
            encounterId: btn.dataset.encId,
            choice: btn.dataset.choice,
          });
          if (result?.ok) {
            this._onBubble('做出了选择！');
            await this._refresh();
          }
        } catch {
          this._onBubble('选择失败...');
        }
      };
    });

    // Bind cancel button
    const cancelBtn = body.querySelector('.nur-adv-cancel-btn');
    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        try {
          await this._rpc('character.adventure.cancel', { adventureId: adventure.id });
          this._onBubble('取消了探险...');
          await this._refresh();
        } catch {
          this._onBubble('取消失败...');
        }
      };
    }

    // Auto-refresh (1s for countdown, 1.5s delay after completion for tick to settle)
    this._advRefreshTimer = setTimeout(() => {
      if (this._activeTab === 'adventure' && this.isOpen) {
        this._refresh();
      }
    }, remaining > 0 ? 1000 : 1500);
  }

  // ── Settlement View ──

  _renderSettlement(body, adventure) {
    const result = adventure.result;
    const card = adventure.card || {};
    const rewardParts = [];
    if (result.rewards?.exp) rewardParts.push(`+${result.rewards.exp} EXP`);
    if (result.rewards?.coins) rewardParts.push(`+${result.rewards.coins} 🪙`);
    if (result.rewards?.items?.length) {
      for (const item of result.rewards.items) rewardParts.push(`🎁 ${this._esc(item)}`);
    }

    body.innerHTML = `
      <div class="nur-adv-active">
        <div class="nur-adv-active-header">
          <div class="nur-adv-active-title">
            <span>${this._themeEmoji(card.theme)} ${this._esc(card.location || '未知地点')}</span>
            <span class="nur-adv-active-stars">${this._stars(card.risk || 1)}</span>
          </div>
        </div>

        <div class="nur-adv-timeline">
          ${adventure.story ? `
            <div class="nur-adv-tl-node nur-adv-tl-start">
              <div class="nur-adv-tl-dot nur-adv-tl-dot-gray"></div>
              <div class="nur-adv-tl-card nur-adv-tl-card-story">${this._esc(adventure.story)}</div>
            </div>
          ` : ''}
          ${(adventure.encounters || []).filter(e => e.triggeredAt).map(enc => {
            let dotClass = 'nur-adv-tl-dot-gray';
            if (enc.type === 'discovery') dotClass = 'nur-adv-tl-dot-gold';
            else if (enc.type === 'choice') dotClass = 'nur-adv-tl-dot-green';
            return `
              <div class="nur-adv-tl-node">
                <div class="nur-adv-tl-dot ${dotClass}"></div>
                <div class="nur-adv-tl-card"><div class="nur-adv-tl-text">${this._esc(enc.text)}</div></div>
              </div>
            `;
          }).join('')}
          <div class="nur-adv-tl-node nur-adv-tl-settlement">
            <div class="nur-adv-tl-dot nur-adv-tl-dot-diamond"></div>
            <div class="nur-adv-tl-card nur-adv-tl-card-settlement">
              <div class="nur-adv-settle-title">${result.success ? '🎉 探险成功！' : '💫 探险结束'}</div>
              <div class="nur-adv-settle-narrative">${this._esc(result.narrative)}</div>
              ${rewardParts.length ? `<div class="nur-adv-settle-rewards">${rewardParts.join(' &middot; ')}</div>` : ''}
            </div>
          </div>
        </div>

        <button class="nur-adv-back-btn">返回线索板</button>
      </div>
    `;

    body.querySelector('.nur-adv-back-btn').onclick = async () => {
      await this._refresh();
    };
  }

  // ───────────────── Horror Tab ─────────────────

  /** Difficulty → star string */
  _horrorStars(d) {
    return '⭐'.repeat(d);
  }

  async _renderHorror(body) {
    body.innerHTML = '<div class="nur-loading">加载中...</div>';
    try {
      const [activeData, scenariosData, historyData] = await Promise.all([
        this._rpc('character.horror.active'),
        this._rpc('character.horror.scenarios'),
        this._rpc('character.horror.history'),
      ]);

      const active = activeData?.session;
      if (active && active.status === 'active') {
        this._renderHorrorActive(body, active, activeData.scenario);
      } else {
        this._renderHorrorLobby(body, scenariosData?.scenarios || [], historyData);
      }
    } catch (err) {
      console.error('[nurturing] horror error:', err);
      body.innerHTML = `<div class="nur-empty">怪谈加载失败<br><small>${this._esc(String(err?.message || err))}</small></div>`;
    }
  }

  // ── Horror Lobby (scenario selection) ──

  _renderHorrorLobby(body, scenarios, historyData) {
    const history = historyData?.history || [];
    const stats = historyData?.stats || {};

    const cards = scenarios.map(s => `
      <div class="nur-horror-card" data-scenario-id="${this._esc(s.id)}">
        <div class="nur-horror-card-header">
          <span class="nur-horror-card-title">${this._esc(s.title)}</span>
          <span class="nur-horror-card-diff">${this._horrorStars(s.difficulty)}</span>
        </div>
        <div class="nur-horror-card-hook">${this._esc(s.hook)}</div>
        <div class="nur-horror-card-meta">
          <span>~${s.estimatedTurns} 轮</span>
          <span class="nur-horror-card-themes">${(s.themes || []).map(t => this._esc(t)).join(' · ')}</span>
        </div>
      </div>
    `).join('');

    const statsHtml = stats.total ? `
      <div class="nur-horror-stats">
        <span>挑战 ${stats.total} 次</span>
        <span>· 胜利 ${stats.won || 0}</span>
        <span>· 失败 ${stats.lost || 0}</span>
      </div>
    ` : '';

    const historyHtml = history.length > 0 ? `
      <div class="nur-horror-history">
        <div class="nur-horror-history-title">── 最近记录 ──</div>
        ${history.slice(0, 5).map(h => {
          const won = h.outcome?.won;
          const statusIcon = h.status === 'won' ? '✓' : h.status === 'lost' ? '✗' : '—';
          const statusClass = h.status === 'won' ? 'success' : h.status === 'lost' ? 'fail' : '';
          return `
            <div class="nur-horror-history-item ${statusClass}">
              <span class="nur-horror-hist-name">${this._esc(h.scenarioId)}</span>
              <span class="nur-horror-hist-result">${statusIcon}</span>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    body.innerHTML = `
      <div class="nur-horror-lobby">
        <div class="nur-horror-lobby-header">
          <span class="nur-horror-lobby-title">👻 怪谈副本</span>
          ${statsHtml}
        </div>
        <div class="nur-horror-lobby-desc">选择一个剧本，指挥宠物穿越进怪谈世界</div>
        <div class="nur-horror-cards">${cards}</div>
        ${historyHtml}
      </div>
    `;

    body.querySelectorAll('.nur-horror-card').forEach(el => {
      el.onclick = () => this._startHorror(el.dataset.scenarioId);
    });
  }

  async _startHorror(scenarioId) {
    try {
      const result = await this._rpc('character.horror.start', { scenarioId });
      if (result?.ok) {
        this._onBubble('穿越进入怪谈世界...');
        this._onAnimation('surprised');
        await this._refresh();
      } else {
        this._onBubble(result?.error || '无法进入副本...');
      }
    } catch (err) {
      this._onBubble(err?.message?.includes('hunger') ? '太饿了，无法进入副本...' : '进入失败...');
    }
  }

  // ── Horror Active Session ──

  _renderHorrorActive(body, session, scenario) {
    const sanityPct = Math.max(0, Math.min(100, session.sanity));
    const turnPct = session.maxTurns > 0 ? Math.round((session.turnCount / session.maxTurns) * 100) : 0;
    const sanityClass = sanityPct <= 30 ? 'nur-horror-sanity-low' : sanityPct <= 60 ? 'nur-horror-sanity-mid' : '';

    const cluesHtml = session.cluesFound?.length ? `
      <div class="nur-horror-clues">
        <div class="nur-horror-clues-title">发现的线索</div>
        ${session.cluesFound.map(c => `<div class="nur-horror-clue-item">🔍 ${this._esc(c)}</div>`).join('')}
      </div>
    ` : '';

    const checksHtml = session.checksPerformed?.length ? `
      <div class="nur-horror-checks">
        <div class="nur-horror-checks-title">判定记录</div>
        ${session.checksPerformed.slice(-5).map(ck => `
          <div class="nur-horror-check-item ${ck.success ? 'success' : 'fail'}">
            <span>${this._esc(ck.attribute)}</span>
            <span>DC${ck.dc}</span>
            <span>${ck.success ? '✓ 成功' : '✗ 失败'}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    body.innerHTML = `
      <div class="nur-horror-active">
        <div class="nur-horror-active-header">
          <div class="nur-horror-active-title">
            <span>👻 ${this._esc(scenario?.title || session.scenarioId)}</span>
            <span class="nur-horror-active-diff">${this._horrorStars(scenario?.difficulty || 1)}</span>
          </div>
        </div>

        <div class="nur-horror-bars">
          <div class="nur-horror-bar-group">
            <div class="nur-horror-bar-label">🧠 理智 ${session.sanity}/100</div>
            <div class="nur-horror-bar-track ${sanityClass}">
              <div class="nur-horror-bar-fill" style="width:${sanityPct}%"></div>
            </div>
          </div>
          <div class="nur-horror-bar-group">
            <div class="nur-horror-bar-label">⏳ 轮次 ${session.turnCount}/${session.maxTurns}</div>
            <div class="nur-horror-bar-track">
              <div class="nur-horror-bar-fill nur-horror-turn-fill" style="width:${turnPct}%"></div>
            </div>
          </div>
        </div>

        ${cluesHtml}
        ${checksHtml}

        <div class="nur-horror-hint">在聊天窗口中发送消息来指挥宠物行动</div>

        <button class="nur-horror-abandon-btn" data-id="${this._esc(session.id)}">放弃副本</button>
      </div>
    `;

    const abandonBtn = body.querySelector('.nur-horror-abandon-btn');
    if (abandonBtn) {
      abandonBtn.onclick = async () => {
        try {
          await this._rpc('character.horror.abandon', { sessionId: session.id });
          this._onBubble('逃出了怪谈世界...');
          await this._refresh();
        } catch {
          this._onBubble('放弃失败...');
        }
      };
    }

    // Auto-refresh every 3s to update state during active session
    this._horrorRefreshTimer = setTimeout(() => {
      if (this._activeTab === 'horror' && this.isOpen) {
        this._refresh();
      }
    }, 3000);
  }

  // ───────────────── Util ─────────────────

  _esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  destroy() {
    this.element?.remove();
  }
}
