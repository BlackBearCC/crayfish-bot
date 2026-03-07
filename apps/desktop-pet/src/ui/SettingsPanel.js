/**
 * SettingsPanel.js
 * 设置面板 — 配置 AI 服务、OpenClaw Gateway 连接、文件权限和宠物人设
 */

// AI Provider 预设（与 llm-service.js 保持一致）
const PROVIDER_PRESETS = {
  openai:   { label: 'OpenAI',        baseUrl: 'https://api.openai.com/v1',                           defaultModel: 'gpt-4o' },
  bailian:  { label: '百炼 (Bailian)', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',             defaultModel: 'glm-5' },
  doubao:   { label: '豆包 (Doubao)',  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',            defaultModel: 'doubao-1-5-pro-32k-250115' },
  deepseek: { label: 'DeepSeek',      baseUrl: 'https://api.deepseek.com/v1',                         defaultModel: 'deepseek-chat' },
  moonshot: { label: 'Moonshot',      baseUrl: 'https://api.moonshot.cn/v1',                          defaultModel: 'moonshot-v1-8k' },
  qwen:     { label: '通义千问',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',   defaultModel: 'qwen-plus' },
  custom:   { label: '自定义',         baseUrl: '',                                                      defaultModel: '' },
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
          <label>Model</label>
          <input type="text" id="set-ai-model" placeholder="模型名称" />
          <div class="settings-hint">选择 Provider 后自动填充默认模型</div>
        </div>

        <!-- OpenClaw 设置 -->
        <div class="settings-section-title">OpenClaw</div>
        <div class="settings-group">
          <label>Agent ID</label>
          <input type="text" id="set-agent-id" placeholder="main" />
          <div class="settings-hint">OpenClaw 的 agent 名称，默认 main</div>
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

    // Provider 切换时自动填充 URL 和 Model
    this.element.querySelector('#set-ai-provider').addEventListener('change', (e) => {
      const key = e.target.value;
      const preset = PROVIDER_PRESETS[key];
      if (preset) {
        document.getElementById('set-ai-base-url').value = preset.baseUrl;
        document.getElementById('set-ai-model').value = preset.defaultModel;
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
        document.getElementById('set-ai-provider').value = config.aiProvider || '';
        document.getElementById('set-ai-base-url').value = config.aiBaseUrl || '';
        document.getElementById('set-ai-model').value = config.aiModel || '';
        document.getElementById('set-ai-api-key').value = '';
        document.getElementById('set-ai-api-key').placeholder = config.hasApiKey ? '已设置 (****)' : '输入 API Key';

        // OpenClaw 字段
        document.getElementById('set-agent-id').value = config.agentId || 'main';
        document.getElementById('set-token').value = '';
        document.getElementById('set-token').placeholder = config.hasToken ? '已设置 (****)' : '未设置';
        document.getElementById('set-system').value = config.systemPrompt || '';
      } catch (e) {
        console.warn('Failed to load config:', e);
      }
    }

    // 加载文件访问设置（通过 gateway pet.config.get）
    this._loadFsAccessSettings();
  }

  async _loadFsAccessSettings() {
    const toggle = document.getElementById('set-fs-full-access');
    const statusEl = document.getElementById('set-fs-status');
    const workdirEl = document.getElementById('set-fs-workdir');

    if (!this.electronAPI?.petConfigGet) {
      toggle.checked = true;
      statusEl.textContent = 'Gateway 未连接，无法读取';
      return;
    }

    try {
      const result = await this.electronAPI.petConfigGet();
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

    if (!this.electronAPI?.petConfigSet) {
      statusEl.textContent = 'Gateway 未连接，无法修改';
      return;
    }

    statusEl.textContent = '保存中...';
    try {
      await this.electronAPI.petConfigSet({
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
      aiModel: document.getElementById('set-ai-model').value.trim(),
    };

    // 只在有输入时更新敏感字段
    const newToken = document.getElementById('set-token').value.trim();
    if (newToken) config.gatewayToken = newToken;

    const newApiKey = document.getElementById('set-ai-api-key').value.trim();
    if (newApiKey) config.aiApiKey = newApiKey;

    try {
      // 使用 saveAndApply 写入本地配置 + OpenClaw 主配置 + 重连
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

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.element.classList.remove('open');
  }

  closeQuiet() {
    this.close();
  }

  destroy() {
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
