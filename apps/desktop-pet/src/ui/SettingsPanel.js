/**
 * SettingsPanel.js
 * 设置面板 — 配置 AI 服务、PetClaw Gateway 连接、文件权限和宠物人设
 */

// AI Provider 预设（与 llm-service.js 保持一致）
const PROVIDER_PRESETS = {
  openai:   { label: 'OpenAI',        baseUrl: 'https://api.openai.com/v1',                           defaultModel: 'gpt-4o',
              models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini', 'o3-mini'] },
  bailian:  { label: '百炼 (Bailian)', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',             defaultModel: 'MiniMax-M2.5',
              models: ['MiniMax-M2.5', 'kimi-k2.5', 'glm-5', 'glm-4-plus', 'qwen-plus', 'qwen3.5-plus', 'qwen-turbo', 'qwen-max'] },
  doubao:   { label: '豆包 (Doubao)',  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',            defaultModel: 'doubao-1-5-pro-32k-250115',
              models: ['doubao-1-5-pro-32k-250115', 'doubao-1-5-lite-32k-250115', 'doubao-pro-32k', 'doubao-lite-32k'] },
  deepseek: { label: 'DeepSeek',      baseUrl: 'https://api.deepseek.com/v1',                         defaultModel: 'deepseek-chat',
              models: ['deepseek-chat', 'deepseek-reasoner'] },
  moonshot: { label: 'Moonshot',      baseUrl: 'https://api.moonshot.cn/v1',                          defaultModel: 'moonshot-v1-8k',
              models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  qwen:     { label: '通义千问',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',   defaultModel: 'qwen3.5-plus',
              models: ['qwen3.5-plus', 'qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'] },
  custom:   { label: '自定义',         baseUrl: '',                                                      defaultModel: '',
              models: [] },
};

export class SettingsPanel {
  constructor(electronAPI) {
    this.electronAPI = electronAPI;
    this.isOpen = false;
    this.element = null;
    this._createDOM();
  }

  _createDOM() {
    this.element = document.createElement('div');
    this.element.id = 'settings-panel';
    this.element.innerHTML = `
      <div class="settings-header">
        <span>⚙️ 设置</span>
        <button class="settings-close">✕</button>
      </div>
      <div class="settings-body">

        <!-- Gateway 状态 -->
        <div class="settings-section-title">Gateway 状态</div>
        <div class="settings-group">
          <div id="set-gateway-status" class="gateway-status">检测中...</div>
          <div id="set-gateway-detail" class="gateway-detail"></div>
        </div>

        <!-- AI 服务配置 -->
        <div class="settings-section-title">AI 服务</div>
        <div class="settings-group">
          <label>Provider</label>
          <select id="set-ai-provider">
            <option value="">-- 请选择 --</option>
            <option value="openai">OpenAI</option>
            <option value="bailian">百炼 (Bailian)</option>
            <option value="doubao">豆包 (Doubao)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="moonshot">Moonshot</option>
            <option value="qwen">通义千问</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div class="settings-group">
          <label>API Base URL</label>
          <input type="text" id="set-ai-base-url" placeholder="自动根据 Provider 填充" />
          <div class="settings-hint">选择 Provider 后自动填充，可自定义修改</div>
        </div>
        <div class="settings-group">
          <label>API Key</label>
          <input type="password" id="set-ai-api-key" placeholder="输入 API Key" />
        </div>
        <div class="settings-group">
          <label>主模型（对话）</label>
          <select id="set-ai-model"></select>
        </div>
        <div class="settings-group">
          <label>辅助模型（探险/记忆/评估）</label>
          <select id="set-ai-aux-model"></select>
          <div class="settings-hint">角色子系统用的轻量模型，默认 kimi-k2.5</div>
        </div>

        <!-- PetClaw 设置 -->
        <div class="settings-section-title">PetClaw</div>
        <div class="settings-group">
          <label>Agent ID</label>
          <input type="text" id="set-agent-id" placeholder="main" />
          <div class="settings-hint">PetClaw 的 agent 名称，默认 main</div>
        </div>
        <div class="settings-group">
          <label>Gateway Token (可选)</label>
          <input type="password" id="set-token" placeholder="如果 Gateway 设了密码" />
        </div>

        <!-- 权限设置 -->
        <div class="settings-section-title">权限</div>
        <div class="settings-group">
          <div class="settings-toggle-row">
            <label>文件全局访问</label>
            <label class="toggle-switch">
              <input type="checkbox" id="set-fs-full-access" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-toggle-detail">
            <span id="set-fs-status">开启后可读写电脑上的所有文件</span>
          </div>
          <div class="settings-toggle-detail">
            工作目录: <span class="fs-path" id="set-fs-workdir" title="">--</span>
          </div>
        </div>

        <!-- 宠物人设 -->
        <div class="settings-section-title">宠物人设</div>
        <div class="settings-group">
          <textarea id="set-system" rows="3" placeholder="你是一只可爱的桌面小猫..."></textarea>
        </div>

        <div class="settings-actions">
          <button class="btn-save">保存</button>
          <button class="btn-cancel">取消</button>
        </div>
        <div class="settings-status" id="settings-status"></div>
      </div>
    `;

    // Events
    this.element.querySelector('.settings-close').addEventListener('click', () => this.close());
    this.element.querySelector('.btn-cancel').addEventListener('click', () => this.close());
    this.element.querySelector('.btn-save').addEventListener('click', () => this._save());

    // Provider 切换时自动填充 URL + 刷新模型下拉列表
    this.element.querySelector('#set-ai-provider').addEventListener('change', (e) => {
      const key = e.target.value;
      const preset = PROVIDER_PRESETS[key];
      if (preset) {
        document.getElementById('set-ai-base-url').value = preset.baseUrl;
        this._populateModelDropdown('set-ai-model', preset.models, preset.defaultModel);
        this._populateModelDropdown('set-ai-aux-model', preset.models, 'kimi-k2.5');
      }
    });

    // 文件访问开关 — 即时生效，不需要点保存
    this.element.querySelector('#set-fs-full-access').addEventListener('change', (e) => {
      this._toggleFsAccess(e.target.checked);
    });

    document.body.appendChild(this.element);
  }

  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.element.classList.add('open');
    this.onStateChange?.();

    if (this.electronAPI?.getConfig) {
      try {
        const config = await this.electronAPI.getConfig();

        // Gateway 状态
        const statusEl = document.getElementById('set-gateway-status');
        const detailEl = document.getElementById('set-gateway-detail');

        if (config.wsConnected) {
          statusEl.textContent = '🟢 WebSocket 已连接';
          statusEl.className = 'gateway-status gw-connected';
        } else if (config.gatewayReady) {
          statusEl.textContent = '🟡 Gateway 运行中（WebSocket 未连接）';
          statusEl.className = 'gateway-status gw-partial';
        } else {
          statusEl.textContent = '🔴 未连接';
          statusEl.className = 'gateway-status gw-disconnected';
        }

        // 详情
        if (this.electronAPI.getGatewayHealth) {
          try {
            const health = await this.electronAPI.getGatewayHealth();
            const parts = [];
            if (health.gatewayUrl) parts.push(health.gatewayUrl);
            if (health.serverVersion) parts.push(`v${health.serverVersion}`);
            if (health.protocol) parts.push(`协议 v${health.protocol}`);
            detailEl.textContent = parts.join(' | ');
          } catch { /* ignore */ }
        }

        // AI 服务字段
        const providerKey = config.aiProvider || '';
        document.getElementById('set-ai-provider').value = providerKey;
        document.getElementById('set-ai-base-url').value = config.aiBaseUrl || '';
        document.getElementById('set-ai-api-key').value = '';
        document.getElementById('set-ai-api-key').placeholder = config.hasApiKey ? '已设置 (****)' : '输入 API Key';

        // 填充模型下拉
        const preset = PROVIDER_PRESETS[providerKey];
        const models = preset?.models || [];
        this._populateModelDropdown('set-ai-model', models, config.aiModel || '');
        this._populateModelDropdown('set-ai-aux-model', models, config.aiAuxModel || 'kimi-k2.5');

        // PetClaw 字段
        document.getElementById('set-agent-id').value = config.agentId || 'main';
        document.getElementById('set-token').value = '';
        document.getElementById('set-token').placeholder = config.hasToken ? '已设置 (****)' : '未设置';
        document.getElementById('set-system').value = config.systemPrompt || '';
      } catch (e) {
        console.warn('Failed to load config:', e);
      }
    }

    // 加载文件访问设置（通过 gateway character.config.get）
    this._loadFsAccessSettings();
  }

  async _loadFsAccessSettings() {
    const toggle = document.getElementById('set-fs-full-access');
    const statusEl = document.getElementById('set-fs-status');
    const workdirEl = document.getElementById('set-fs-workdir');

    if (!this.electronAPI?.characterConfigGet) {
      toggle.checked = true;
      statusEl.textContent = 'Gateway 未连接，无法读取';
      return;
    }

    try {
      const result = await this.electronAPI.characterConfigGet();
      const fsAccess = result?.settings?.fsAccess;
      if (fsAccess) {
        toggle.checked = fsAccess.fullAccess !== false;
        statusEl.textContent = toggle.checked ? '可读写电脑上的所有文件' : '仅限工作目录';
        if (fsAccess.workDir) {
          workdirEl.textContent = fsAccess.workDir;
          workdirEl.title = fsAccess.workDir;
        }
      }
    } catch (e) {
      console.warn('Failed to load fs access settings:', e);
      statusEl.textContent = '读取失败';
    }
  }

  async _toggleFsAccess(fullAccess) {
    const statusEl = document.getElementById('set-fs-status');

    if (!this.electronAPI?.characterConfigSet) {
      statusEl.textContent = 'Gateway 未连接，无法修改';
      return;
    }

    statusEl.textContent = '保存中...';
    try {
      await this.electronAPI.characterConfigSet({
        settings: { fsAccess: { fullAccess } },
      });
      statusEl.textContent = fullAccess ? '可读写电脑上的所有文件' : '仅限工作目录';
    } catch (e) {
      console.warn('Failed to toggle fs access:', e);
      statusEl.textContent = '保存失败: ' + e.message;
      // 回滚 toggle 状态
      document.getElementById('set-fs-full-access').checked = !fullAccess;
    }
  }

  async _save() {
    const statusEl = document.getElementById('settings-status');
    statusEl.textContent = '保存中...';
    statusEl.style.color = '#999';

    const config = {
      agentId: document.getElementById('set-agent-id').value.trim() || 'main',
      systemPrompt: document.getElementById('set-system').value,
      aiProvider: document.getElementById('set-ai-provider').value,
      aiBaseUrl: document.getElementById('set-ai-base-url').value.trim(),
      aiModel: document.getElementById('set-ai-model').value,
      aiAuxModel: document.getElementById('set-ai-aux-model').value,
    };

    // 只在有输入时更新敏感字段
    const newToken = document.getElementById('set-token').value.trim();
    if (newToken) config.gatewayToken = newToken;

    const newApiKey = document.getElementById('set-ai-api-key').value.trim();
    if (newApiKey) config.aiApiKey = newApiKey;

    try {
      // 使用 saveAndApply 写入本地配置 + PetClaw 主配置 + 重连
      let result;
      if (this.electronAPI.saveAndApply) {
        result = await this.electronAPI.saveAndApply(config);
      } else {
        result = await this.electronAPI.saveConfig(config);
        result = { ok: !!result };
      }

      if (result.ok !== false) {
        statusEl.textContent = '已保存！';
        statusEl.style.color = '#4CAF50';
        setTimeout(() => this.close(), 800);
      } else {
        statusEl.textContent = '保存失败: ' + (result.error || '');
        statusEl.style.color = '#f44336';
      }
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.style.color = '#f44336';
    }
  }

  /** 填充模型下拉列表 */
  _populateModelDropdown(selectId, models, selectedValue) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === selectedValue) opt.selected = true;
      sel.appendChild(opt);
    }
    // 如果当前值不在列表中，追加一个选项
    if (selectedValue && !models.includes(selectedValue)) {
      const opt = document.createElement('option');
      opt.value = selectedValue;
      opt.textContent = selectedValue;
      opt.selected = true;
      sel.insertBefore(opt, sel.firstChild);
    }
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

  destroy() {
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
