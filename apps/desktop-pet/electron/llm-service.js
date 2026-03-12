/**
 * llm-service.js — PetClaw 内嵌网关管理 + WebSocket RPC 全能力客户端
 *
 * 架构：
 *   Electron 主进程启动 → 内部拉起 PetClaw Gateway 子进程 → 等待就绪
 *   → 通过 WebSocket (ws://127.0.0.1:18789) 全 RPC 通信
 *   → 支持流式聊天（chat.send + chat 事件）、会话管理、配置管理
 *   → Electron 退出时自动杀掉 Gateway
 *
 * 用户角度：点一个 exe，一切自动。
 */

const { spawn } = require('child_process');
const http = require('http');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = crypto;
const WebSocket = require('ws');
const os = require('os');
const { logger } = require('./logger');

// ===== Device Identity Helpers =====
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function _base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function _derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function _fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(_derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function _publicKeyRawBase64Url(publicKeyPem) {
  return _base64UrlEncode(_derivePublicKeyRaw(publicKeyPem));
}

function _signDevicePayload(privateKeyPem, payload) {
  return _base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)));
}

function _buildDeviceAuthPayload(params) {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  return ['v2', params.deviceId, params.clientId, params.clientMode, params.role,
          scopes, String(params.signedAtMs), token, params.nonce].join('|');
}

function _loadOrCreateDeviceIdentity() {
  const stateDir = path.join(os.homedir(), '.petclaw');
  const identityFile = path.join(stateDir, 'identity', 'device.json');

  try {
    if (fs.existsSync(identityFile)) {
      const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (parsed?.version === 1 && parsed.publicKeyPem && parsed.privateKeyPem) {
        const derivedId = _fingerprintPublicKey(parsed.publicKeyPem);
        return { deviceId: derivedId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
      }
    }
  } catch {}

  // Generate new identity
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = _fingerprintPublicKey(publicKeyPem);

  const dir = path.dirname(identityFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(identityFile, JSON.stringify({ version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() }, null, 2) + '\n');

  return { deviceId, publicKeyPem, privateKeyPem };
}

// ===== AI Provider 预设 =====
const AI_PROVIDERS = {
  openai:     { label: 'OpenAI',        baseUrl: 'https://api.openai.com/v1',                       defaultModel: 'gpt-4o',                       api: 'openai-completions' },
  bailian:    { label: '百炼 (Bailian)', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',           defaultModel: 'glm-5',                        api: 'openai-completions' },
  doubao:     { label: '豆包 (Doubao)',  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',        defaultModel: 'doubao-1-5-pro-32k-250115',    api: 'openai-completions' },
  deepseek:   { label: 'DeepSeek',      baseUrl: 'https://api.deepseek.com/v1',                     defaultModel: 'deepseek-chat',                api: 'openai-completions' },
  moonshot:   { label: 'Moonshot',      baseUrl: 'https://api.moonshot.cn/v1',                      defaultModel: 'moonshot-v1-8k',               api: 'openai-completions' },
  qwen:       { label: '通义千问',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus',                    api: 'openai-completions' },
  custom:     { label: '自定义',         baseUrl: '',                                                  defaultModel: '',                             api: 'openai-completions' },
};

class LLMService {
  constructor() {
    this.gatewayProcess = null;
    this.gatewayReady = false;
    this.gatewayPort = 18789;
    this.gatewayUrl = `http://127.0.0.1:${this.gatewayPort}`;
    this.wsUrl = `ws://127.0.0.1:${this.gatewayPort}`;

    // Device identity
    this.deviceIdentity = null;

    // WebSocket 状态
    this.ws = null;
    this.wsConnected = false;
    this.wsReconnecting = false;
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.helloOk = null;

    // 聊天流式事件回调
    this._onChatEvent = null;
    this._onAgentEvent = null;
    this._onCharacterEvent = null;

    // 当前活跃 run
    this.activeRunId = null;
    this.activeSessionKey = null;

    // 配置
    this.config = {
      agentId: 'main',
      systemPrompt: `你是一只可爱的桌面宠物猫助手。你的性格活泼、亲切、有点调皮。
回复要简短可爱（一般不超过两句话），偶尔加个颜文字。
你住在主人的桌面上，会关心主人的状态。
如果主人问你问题，简洁地回答，保持角色人设。`,
      aiProvider: '',
      aiBaseUrl: '',
      aiApiKey: '',
      aiModel: '',
    };

    this.conversationHistory = [];
    this.configPath = '';
  }

  // ===== 初始化 =====

  async init() {
    this.configPath = path.join(app.getPath('userData'), 'petclaw-character-config.json');
    this._loadConfig();
    // 自动同步 AI 配置到 PetClaw Gateway 配置
    if (this.config.aiProvider && this.config.aiApiKey) {
      this.writePetClawConfig(this.config);
      console.log('[llm] Auto-synced AI config to PetClaw Gateway');
    }
    try { this.deviceIdentity = _loadOrCreateDeviceIdentity(); } catch (e) {
      console.warn('[llm] Failed to load device identity:', e.message);
    }
    this._ensureExecApprovals();
    await this._startGateway();
    if (this.gatewayReady) {
      await this._connectWebSocket();
    }
  }

  // ===== Gateway 生命周期 =====

  async _startGateway() {
    // Character Engine 拥有 Gateway 生命周期：启动前无条件清理端口残留进程（包括僵尸态）
    this._killPortSync(this.gatewayPort);
    await this._sleep(500);

    const gateway = this._resolveGateway();
    if (!gateway) {
      console.warn('[llm] petclaw gateway not found');
      return;
    }

    // 开发模式：如果 dist 不存在，先 build
    if (!app.isPackaged) await this._ensureBuilt();

    logger.gateway(`Starting via: ${gateway.cmd} ${gateway.args.join(' ')} (packaged=${app.isPackaged})`);
    console.log(`[llm] Starting Gateway via: ${gateway.cmd} ${gateway.args.join(' ')}`);

    const gatewayArgs = [
      ...gateway.args,
      'gateway',
      '--port', String(this.gatewayPort),
      '--bind', 'loopback',
      '--allow-unconfigured',
      ...(process.env.PETCLAW_VERBOSE ? ['--verbose'] : []),
    ];

    // cwd 必须指向 petclaw 项目根目录，Gateway dist 用 import.meta.url 相对路径查找 docs/reference/templates/
    const gatewayCwd = app.isPackaged
      ? path.join(process.resourcesPath, 'gateway')
      : path.resolve(__dirname, '..', 'node_modules', 'petclaw');

    this.gatewayProcess = spawn(gateway.cmd, gatewayArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      cwd: gatewayCwd,
      env: { ...process.env, PETCLAW_STATE_DIR: path.join(os.homedir(), '.petclaw') },
      shell: gateway.shell,
    });

    this.gatewayProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[gateway] ${msg}`);
    });

    this.gatewayProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.warn(`[gateway:err] ${msg}`);
    });

    this.gatewayProcess.on('error', (err) => {
      console.error('[gateway] process error:', err.message);
    });

    this.gatewayProcess.on('exit', (code) => {
      logger.gateway(`exited with code ${code}`);
      console.log(`[gateway] exited with code ${code}`);
      this.gatewayReady = false;
      this.gatewayProcess = null;
    });

    await this._waitForGateway(15000);
  }

  /**
   * 解析 Gateway 启动方式，返回 { cmd, args, shell }。
   * 打包模式：用 node 直接跑 resources/gateway/petclaw.mjs（上游文件名保持不变）
   * 开发模式：用 node_modules/.bin/ 下的 CLI shim
   */
  _resolveGateway() {
    // 1. 打包后：resources/gateway/petclaw.mjs（extraResources 复制）
    if (app.isPackaged) {
      const mjs = path.join(process.resourcesPath, 'gateway', 'petclaw.mjs');
      if (fs.existsSync(mjs)) {
        return { cmd: process.execPath, args: [mjs], shell: false };
      }
    }

    // 2. 开发模式：node_modules/.bin/ 下的 CLI shim
    const isWin = process.platform === 'win32';
    const ext = isWin ? '.cmd' : '';
    const names = [`petclaw${ext}`];

    for (const binName of names) {
      const localBin = path.join(app.getAppPath(), 'node_modules', '.bin', binName);
      if (fs.existsSync(localBin)) return { cmd: localBin, args: [], shell: isWin };

      const relativeBin = path.join(__dirname, '..', 'node_modules', '.bin', binName);
      if (fs.existsSync(relativeBin)) return { cmd: relativeBin, args: [], shell: isWin };

      // pnpm workspace：向上查找根 node_modules/.bin/
      let dir = path.resolve(__dirname, '..');
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'node_modules', '.bin', binName);
        if (fs.existsSync(candidate)) return { cmd: candidate, args: [], shell: isWin };
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    return null;
  }

  async _waitForGateway(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this._isGatewayAlive()) {
        this.gatewayReady = true;
        console.log('[llm] Gateway is ready');
        return true;
      }
      await this._sleep(500);
    }
    console.warn('[llm] Gateway did not become ready in time');
    return false;
  }

  _isGatewayAlive() {
    return new Promise((resolve) => {
      const req = http.get(`${this.gatewayUrl}/`, (res) => {
        // 任何响应都说明 Gateway 在运行（包括 503 Control UI 缺失）
        resolve(res.statusCode < 600);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  }

  stopGateway() {
    if (this.gatewayProcess) {
      console.log('[llm] Stopping Gateway...');
      const pid = this.gatewayProcess.pid;
      // Windows + shell:true 时 kill('SIGTERM') 只杀 cmd.exe 壳，
      // 必须用 taskkill /T 杀整棵进程树，否则 node.exe 成孤儿
      if (process.platform === 'win32' && pid) {
        try {
          require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 });
          console.log(`[llm] Killed Gateway process tree (PID ${pid})`);
        } catch (e) {
          console.warn('[llm] taskkill failed, trying SIGTERM:', e.message);
          this.gatewayProcess.kill('SIGTERM');
        }
      } else {
        this.gatewayProcess.kill('SIGTERM');
      }
      this.gatewayProcess = null;
      this.gatewayReady = false;
    }
    // 兜底：同步杀端口上残留的进程
    this._killPortSync(this.gatewayPort);
  }

  /**
   * 同步杀端口上的残留进程（用于 destroy/退出时确保清理完成）
   */
  _killPortSync(port) {
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        // 1. 杀端口上的监听进程（含整棵进程树）
        try {
          const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8', timeout: 5000 }).trim();
          const pids = [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
          for (const pid of pids) {
            console.log(`[llm] Killing PID ${pid} on port ${port}`);
            try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 }); } catch {}
          }
        } catch {}
        // 2. 兜底：杀所有 petclaw gateway 相关的孤儿 node 进程
        try {
          const wmicOut = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /FORMAT:CSV', { encoding: 'utf-8', timeout: 5000 });
          const lines = wmicOut.split('\n').filter(l => l.includes('petclaw') && l.includes('gateway'));
          for (const line of lines) {
            const match = line.match(/,(\d+)\s*$/);
            if (match) {
              const pid = match[1];
              console.log(`[llm] Killing orphan gateway node PID ${pid}`);
              try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 }); } catch {}
            }
          }
        } catch {}
      } else {
        try { execSync(`fuser -k ${port}/tcp`, { timeout: 5000 }); } catch {}
      }
    } catch {}
  }

  async _killPort(port) {
    this._killPortSync(port);
  }

  // ===== WebSocket RPC =====

  _connectWebSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.wsConnected = false;

    return new Promise((resolve) => {
      console.log(`[ws] Connecting to ${this.wsUrl}...`);
      let resolved = false;
      const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

      this.ws = new WebSocket(this.wsUrl, { maxPayload: 25 * 1024 * 1024 });

      this.ws.on('open', () => {
        console.log('[ws] Open, waiting for challenge...');
      });

      this.ws.on('message', (data) => {
        this._handleWsMessage(data.toString(), done);
      });

      this.ws.on('close', (code, reason) => {
        const reasonText = reason?.toString() || '';
        logger.ws(`Closed (${code}): ${reasonText}`);
        console.log(`[ws] Closed (${code}): ${reasonText}`);
        this.wsConnected = false;
        this.ws = null;
        // 保留 helloOk 用于 fallback session key，重连成功后会刷新
        this._flushPendingErrors(new Error(`WebSocket closed (${code})`));

        if (!this.wsReconnecting && (this._wsRetries || 0) < 5) {
          this.wsReconnecting = true;
          this._wsRetries = (this._wsRetries || 0) + 1;
          const delay = Math.min(2000 * this._wsRetries, 10000);
          setTimeout(async () => {
            this.wsReconnecting = false;
            try { await this._ensureConnected(); } catch (e) {
              console.warn('[ws] Auto-reconnect failed:', e.message);
            }
          }, delay);
        }
        done(false);
      });

      this.ws.on('error', (err) => {
        logger.wsErr(err.message);
        console.error('[ws] Error:', err.message);
      });

      setTimeout(() => done(false), 10000);
    });
  }

  _handleWsMessage(raw, connectResolve) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }

    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        logger.ws('received connect.challenge');
        this._sendConnectRequest(frame.payload?.nonce);
        return;
      }
      if (frame.event === 'chat') {
        this._onChatEvent?.(frame.payload);
        return;
      }
      if (frame.event === 'agent') {
        this._onAgentEvent?.(frame.payload);
        return;
      }
      if (frame.event === 'character') {
        this._onCharacterEvent?.(frame.payload);
        return;
      }
      // 未知事件也记录
      logger.ws(`unknown event: ${frame.event}`);
      return;
    }

    if (frame.type === 'res') {
      const pending = this.pendingRequests.get(frame.id);
      if (!pending) return;
      this.pendingRequests.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);

      if (frame.ok) {
        if (pending.method === 'connect') {
          this.helloOk = frame.payload;
          this.wsConnected = true;
          this._wsRetries = 0;
          logger.ws(`Connected! Protocol: ${frame.payload?.protocol}, server: ${frame.payload?.server?.version}`);
          console.log('[ws] Connected! Protocol:', frame.payload?.protocol);
          connectResolve?.(true);
        }
        pending.resolve(frame.payload);
      } else {
        const err = frame.error || { message: 'Unknown error', code: 'UNKNOWN' };
        logger.rpcErr(pending.method, `[${err.code}] ${err.message}`);
        pending.reject(new Error(`[${err.code}] ${err.message}`));
      }
    }
  }

  _sendConnectRequest(nonce) {
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.read', 'operator.write'];
    const clientId = 'gateway-client';
    const clientMode = 'ui';
    const signedAtMs = Date.now();

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        displayName: 'PetClaw Character',
        version: app.getVersion?.() || '0.2.0',
        platform: process.platform,
        mode: clientMode,
        instanceId: randomUUID(),
      },
      caps: ['tool-events'],
      role,
      scopes,
    };

    // Character token 认证
    const token = this.gatewayToken || undefined;
    if (token) {
      params.auth = { token };
    }

    // 设备签名（v2 格式，与 Gateway 一致）—— 必须有才能获得 scope 权限
    if (this.deviceIdentity && nonce) {
      const payload = _buildDeviceAuthPayload({
        deviceId: this.deviceIdentity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: token ?? null,
        nonce,
      });
      const signature = _signDevicePayload(this.deviceIdentity.privateKeyPem, payload);
      params.device = {
        id: this.deviceIdentity.deviceId,
        publicKey: _publicKeyRawBase64Url(this.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    this._sendRequest('connect', params).catch((err) => {
      console.error('[ws] Connect failed:', err.message);
    });
  }

  _sendRequest(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (method !== 'connect') {
          reject(new Error('WebSocket not connected'));
          return;
        }
      }

      const id = String(++this.requestIdCounter);
      const frame = { type: 'req', id, method, params };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer, method });

      try {
        this.ws.send(JSON.stringify(frame));
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _flushPendingErrors(error) {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  // ===== Gateway 自动恢复 =====

  async _ensureConnected() {
    if (this.wsConnected) return;

    // Gateway 进程不在了 → 重新拉起
    if (!this.gatewayReady) {
      console.log('[llm] Gateway down, restarting...');
      await this._startGateway();
    }

    // Gateway 活了但 WS 没连 → 重连
    if (this.gatewayReady && !this.wsConnected) {
      await this._connectWebSocket();
    }

    if (!this.wsConnected) {
      throw new Error('Gateway 重启失败喵，请检查网络或重启应用');
    }
  }

  // ===== 通用 RPC（覆盖所有 character.* / 其他 gateway 方法） =====

  async characterRPC(method, params = {}) {
    await this._ensureConnected();
    return await this._sendRequest(method, params);
  }

  // ===== Chat API =====

  async chatSend(userMessage, sessionKey, clientRunId) {
    await this._ensureConnected();

    const resolvedKey = sessionKey || this._getDefaultSessionKey();
    const runId = clientRunId || randomUUID();
    this.activeRunId = runId;
    this.activeSessionKey = resolvedKey;

    logger.chat('send', userMessage, { sessionKey: resolvedKey, runId });

    await this._sendRequest('chat.send', {
      sessionKey: resolvedKey,
      message: userMessage,
      idempotencyKey: runId,
    });

    return { runId, sessionKey: resolvedKey };
  }

  async chatAbort(sessionKey, runId) {
    if (!this.wsConnected) return;
    const key = sessionKey || this.activeSessionKey;
    if (!key) return;
    await this._sendRequest('chat.abort', {
      sessionKey: key,
      runId: runId || this.activeRunId,
    });
  }

  async chatHistory(sessionKey, limit = 50) {
    try { await this._ensureConnected(); } catch { return { entries: [] }; }
    return await this._sendRequest('chat.history', {
      sessionKey: sessionKey || this._getDefaultSessionKey(),
      limit,
    });
  }

  onChatEvent(callback) { this._onChatEvent = callback; }
  onAgentEvent(callback) { this._onAgentEvent = callback; }
  onCharacterEvent(callback) { this._onCharacterEvent = callback; }

  // ===== Session management =====

  async sessionsList(opts = {}) {
    if (!this.wsConnected) return { sessions: [] };
    return await this._sendRequest('sessions.list', {
      limit: opts.limit || 20,
      activeMinutes: opts.activeMinutes,
      includeGlobal: opts.includeGlobal ?? true,
      includeDerivedTitles: opts.includeDerivedTitles ?? true,
      includeLastMessage: opts.includeLastMessage ?? true,
      agentId: opts.agentId || this.config.agentId,
    });
  }

  async sessionsReset(sessionKey, reason) {
    if (!this.wsConnected) return;
    return await this._sendRequest('sessions.reset', {
      key: sessionKey,
      ...(reason ? { reason } : {}),
    });
  }

  // ===== Models & tools =====

  async modelsList() {
    if (!this.wsConnected) return { models: [] };
    return await this._sendRequest('models.list', {});
  }

  async toolsCatalog(agentId) {
    if (!this.wsConnected) return { tools: [] };
    return await this._sendRequest('tools.catalog', {
      agentId: agentId || this.config.agentId,
      includePlugins: true,
    });
  }

  async agentsList() {
    if (!this.wsConnected) return { agents: [] };
    try {
      return await this._sendRequest('agents.list', {});
    } catch {
      return { agents: [] };
    }
  }

  async agentGet(agentId) {
    if (!this.wsConnected) return null;
    try {
      return await this._sendRequest('agent.get', { agentId: agentId || this.config.agentId });
    } catch {
      return null;
    }
  }

  // ===== Legacy sync chat (fallback) =====

  async chat(userMessage) {
    if (!this.wsConnected) return this._chatHttp(userMessage);

    try {
      const sessionKey = this._getDefaultSessionKey();
      const runId = randomUUID();

      const resultPromise = new Promise((resolve, reject) => {
        let accumulatedText = '';
        const timeout = setTimeout(() => {
          this._onChatEvent = prevHandler;
          reject(new Error('聊天超时'));
        }, 60000);

        const prevHandler = this._onChatEvent;
        this._onChatEvent = (payload) => {
          if (payload.runId !== runId) { prevHandler?.(payload); return; }

          if (payload.state === 'delta') {
            const text = this._extractText(payload.message);
            if (text) accumulatedText = text;
          }
          if (payload.state === 'final') {
            clearTimeout(timeout);
            this._onChatEvent = prevHandler;
            const finalText = this._extractText(payload.message) || accumulatedText || '喵？';
            resolve({ text: finalText, sentiment: this._detectSentiment(finalText) });
          }
          if (payload.state === 'error') {
            clearTimeout(timeout);
            this._onChatEvent = prevHandler;
            reject(new Error(payload.errorMessage || 'Chat error'));
          }
          if (payload.state === 'aborted') {
            clearTimeout(timeout);
            this._onChatEvent = prevHandler;
            resolve({ text: '（被中止了喵）', sentiment: 'neutral' });
          }
        };
      });

      await this._sendRequest('chat.send', {
        sessionKey,
        message: userMessage,
        idempotencyKey: runId,
      });

      return await resultPromise;
    } catch (e) {
      return { text: `出错了喵: ${e.message.substring(0, 80)}`, sentiment: 'negative' };
    }
  }

  async _chatHttp(userMessage) {
    if (!this.gatewayReady) {
      return { text: 'Gateway 还没准备好喵~ 稍等一下？', sentiment: 'neutral' };
    }

    this.conversationHistory.push({ role: 'user', content: userMessage });
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }

    try {
      const headers = {
        'Content-Type': 'application/json',
        'x-petclaw-agent-id': this.config.agentId,
      };
      if (this.gatewayToken) {
        headers['Authorization'] = `Bearer ${this.gatewayToken}`;
      }
      const body = JSON.stringify({
        model: 'petclaw',
        messages: [
          { role: 'system', content: this.config.systemPrompt },
          ...this.conversationHistory,
        ],
      });

      const data = await this._httpPost(`${this.gatewayUrl}/v1/chat/completions`, headers, body);
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));

      const reply = parsed.choices?.[0]?.message?.content?.trim() || '喵？';
      this.conversationHistory.push({ role: 'assistant', content: reply });
      return { text: reply, sentiment: this._detectSentiment(reply) };
    } catch (e) {
      if (e.message.includes('ECONNREFUSED')) {
        this.gatewayReady = false;
        this._startGateway().then(() => this._connectWebSocket()).catch(() => {});
        return { text: 'Gateway 断开了，正在重连喵...', sentiment: 'negative' };
      }
      return { text: `出错了喵: ${e.message.substring(0, 80)}`, sentiment: 'negative' };
    }
  }

  // ===== Config management =====

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        Object.assign(this.config, saved);
        console.log('[llm] Config loaded');
      }
    } catch (e) {
      console.warn('[llm] Failed to load config:', e.message);
    }

    // Character 主场：确保 gateway token 由 character engine 控制
    this.gatewayToken = this._ensureCharacterToken();

    // 每次启动都从 ~/.petclaw/petclaw.json 同步最新 primary model 配置
    this._autoPopulateFromPetClaw();

    // SOUL.md 作为人设唯一来源 — 启动时同步到 systemPrompt
    const soul = this._loadSoulFile();
    if (soul) {
      this.config.systemPrompt = soul;
      console.log('[llm] systemPrompt loaded from SOUL.md');
    }
  }

  /**
   * 从 ~/.petclaw/petclaw.json 读取已有的 AI 配置，自动填充到本地配置
   */
  _autoPopulateFromPetClaw() {
    const ocConfig = this._readPetClawConfig();
    if (!ocConfig) return;

    try {
      // 读取 primary model 来确定 provider 和 model
      const primaryModel = ocConfig.agents?.defaults?.model?.primary;
      const providers = ocConfig.models?.providers;

      if (primaryModel && providers) {
        // primaryModel 格式: "providerKey/modelName"
        const slashIdx = primaryModel.indexOf('/');
        if (slashIdx > 0) {
          const providerKey = primaryModel.substring(0, slashIdx);
          const modelName = primaryModel.substring(slashIdx + 1);
          const providerConfig = providers[providerKey];

          if (providerConfig) {
            this.config.aiProvider = providerKey;
            this.config.aiModel = modelName;
            if (providerConfig.baseUrl) this.config.aiBaseUrl = providerConfig.baseUrl;
            if (providerConfig.apiKey) this.config.aiApiKey = providerConfig.apiKey;

            console.log(`[llm] Auto-populated AI config from petclaw: ${providerKey}/${modelName}`);

            // 保存到本地配置文件，下次不用再读
            try {
              fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
              console.log('[llm] Auto-populated config saved');
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn('[llm] Failed to auto-populate from petclaw config:', e.message);
    }
  }

  saveConfig(newConfig) {
    Object.assign(this.config, newConfig);
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[llm] Failed to save config:', e.message);
      return false;
    }
  }

  getConfig() {
    return {
      ...this.config,
      gatewayToken: this.gatewayToken ? '****' : '',
      aiApiKey: this.config.aiApiKey ? '****' : '',
      hasToken: !!this.gatewayToken,
      hasApiKey: !!this.config.aiApiKey,
      gatewayReady: this.gatewayReady,
      wsConnected: this.wsConnected,
      gatewayUrl: this.gatewayUrl,
      // Classifier model
      classifierProvider: this.config.classifierProvider || '',
      classifierBaseUrl: this.config.classifierBaseUrl || '',
      classifierModel: this.config.classifierModel || '',
      classifierApiKey: this.config.classifierApiKey ? '****' : '',
      hasClassifierApiKey: !!this.config.classifierApiKey,
    };
  }

  getGatewayHealth() {
    return {
      gatewayReady: this.gatewayReady,
      wsConnected: this.wsConnected,
      gatewayUrl: this.gatewayUrl,
      wsUrl: this.wsUrl,
      protocol: this.helloOk?.protocol || null,
      serverVersion: this.helloOk?.server?.version || null,
      features: this.helloOk?.features || null,
      sessionDefaults: this.helloOk?.snapshot?.sessionDefaults || null,
      configPath: this.helloOk?.snapshot?.configPath || null,
    };
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  // ===== Exec approvals (auto-allow all commands) =====

  _ensureExecApprovals() {
    const approvalsFile = path.join(os.homedir(), '.petclaw', 'exec-approvals.json');
    try {
      if (fs.existsSync(approvalsFile)) return; // 已有配置则不覆盖
      const approvals = {
        version: 1,
        socket: {},
        defaults: {},
        agents: {
          '*': {
            allowlist: [{ pattern: '**', lastUsedAt: Date.now() }],
          },
        },
      };
      const dir = path.join(os.homedir(), '.petclaw');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(approvalsFile, JSON.stringify(approvals, null, 2), 'utf-8');
      console.log('[llm] Created exec-approvals.json with full permissions');
    } catch (e) {
      console.warn('[llm] Failed to write exec-approvals:', e.message);
    }
  }

  // ===== Character Token =====

  _ensureCharacterToken() {
    const configDir = path.join(os.homedir(), '.petclaw');
    const configFile = path.join(configDir, 'petclaw.json');
    const tokenFile = path.join(configDir, 'character-token');

    // 读取或生成 character token（兼容旧 pet-token 文件）
    let charToken;
    try {
      if (fs.existsSync(tokenFile)) {
        charToken = fs.readFileSync(tokenFile, 'utf-8').trim();
      } else {
        const legacyTokenFile = path.join(configDir, 'pet-token');
        if (fs.existsSync(legacyTokenFile)) {
          charToken = fs.readFileSync(legacyTokenFile, 'utf-8').trim();
          fs.writeFileSync(tokenFile, charToken, 'utf-8');
        }
      }
    } catch {}
    if (!charToken) {
      charToken = 'char-' + crypto.randomBytes(24).toString('hex');
      try {
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(tokenFile, charToken, 'utf-8');
        console.log('[llm] Generated new character token');
      } catch (e) { console.warn('[llm] Failed to save character token:', e.message); }
    }

    // 写入 petclaw.json（上游配置文件名保持不变），Gateway 启动时读取
    try {
      let config = {};
      if (fs.existsSync(configFile)) {
        try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}
      }
      if (!config.gateway) config.gateway = {};
      if (!config.gateway.auth) config.gateway.auth = {};
      if (config.gateway.auth.token !== charToken) {
        config.gateway.auth.mode = 'token';
        config.gateway.auth.token = charToken;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
        console.log('[llm] Synced character token to petclaw config');
      }
    } catch (e) { console.warn('[llm] Failed to sync character token:', e.message); }

    console.log('[llm] Character token ready');
    return charToken;
  }

  // ===== PetClaw config file (~/.petclaw/petclaw.json) =====

  _readPetClawConfig() {
    const configFile = path.join(os.homedir(), '.petclaw', 'petclaw.json');
    try {
      if (fs.existsSync(configFile)) return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    } catch (e) {
      console.warn('[llm] Failed to read petclaw config:', e.message);
    }
    return null;
  }

  writePetClawConfig(aiConfig) {
    const configDir = path.join(os.homedir(), '.petclaw');
    const configFile = path.join(configDir, 'petclaw.json');

    try {
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

      let config = {};
      if (fs.existsSync(configFile)) {
        try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch { config = {}; }
      }

      if (!config.gateway) config.gateway = {};
      config.gateway.mode = 'local';

      if (aiConfig.aiProvider && aiConfig.aiApiKey) {
        if (!config.models) config.models = {};
        if (!config.models.providers) config.models.providers = {};

        const providerKey = aiConfig.aiProvider === 'custom' ? 'custom' : aiConfig.aiProvider;
        const providerInfo = AI_PROVIDERS[aiConfig.aiProvider] || {};
        const modelName = aiConfig.aiModel || providerInfo.defaultModel || '';
        const apiType = providerInfo.api || 'openai-completions';

        config.models.providers[providerKey] = {
          baseUrl: aiConfig.aiBaseUrl || providerInfo.baseUrl || '',
          api: apiType,
          apiKey: aiConfig.aiApiKey,
          models: modelName ? [{
            id: modelName,
            name: modelName,
            contextWindow: 131072,
            maxTokens: 8192,
          }] : [],
        };

        if (modelName) {
          if (!config.agents) config.agents = {};
          if (!config.agents.defaults) config.agents.defaults = {};
          if (!config.agents.defaults.model) config.agents.defaults.model = {};
          config.agents.defaults.model.primary = `${providerKey}/${modelName}`;
        }
      }

      // ── Classifier model config (for smart queue router) ──
      // Resolve effective classifier config: explicit fields → fallback to main AI
      const clfProvider = aiConfig.classifierProvider || aiConfig.aiProvider;
      const clfProviderInfo = AI_PROVIDERS[clfProvider] || {};
      const clfBaseUrl = aiConfig.classifierBaseUrl || clfProviderInfo.baseUrl || aiConfig.aiBaseUrl || '';
      const clfApiKey = aiConfig.classifierApiKey || aiConfig.aiApiKey || '';
      const clfModel = aiConfig.classifierModel || clfProviderInfo.defaultModel || 'qwen-plus';

      if (!config.character) config.character = {};
      config.character.classifier = {
        baseUrl: clfBaseUrl,
        apiKey: clfApiKey,
        model: clfModel,
      };

      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
      console.log('[llm] PetClaw config written to', configFile);
      return { ok: true, path: configFile };
    } catch (e) {
      console.error('[llm] Failed to write petclaw config:', e.message);
      return { ok: false, error: e.message };
    }
  }

  async saveAndApply(newConfig) {
    this.saveConfig(newConfig);

    if (newConfig.aiProvider && newConfig.aiApiKey) {
      const result = this.writePetClawConfig(newConfig);
      if (!result.ok) return { ok: false, error: result.error };
    }

    // Sync systemPrompt → SOUL.md so gateway uses the same persona
    if (newConfig.systemPrompt) {
      this._syncSoulFile(newConfig.systemPrompt);
    }

    // Reconnect to pick up new config
    if (this.wsConnected) {
      try { await this._connectWebSocket(); } catch {}
    } else if (this.gatewayReady) {
      this.stopGateway();
      await this._sleep(1000);
      await this._startGateway();
      if (this.gatewayReady) await this._connectWebSocket();
    }

    return { ok: true };
  }

  // ===== Auto-build =====

  /**
   * 确保 petclaw dist 已构建。新设备 clone 后首次运行时自动触发。
   * clawBin 是 workspace 链接的路径，从它推导项目根目录。
   */
  async _ensureBuilt() {
    try {
      const { execSync } = require('child_process');

      // node_modules/petclaw 是唯一来源
      const projectRoot = path.join(app.getAppPath(), 'node_modules', 'petclaw');
      if (!fs.existsSync(projectRoot)) return;

      const distIndex = path.join(projectRoot, 'dist', 'index.js');
      if (fs.existsSync(distIndex)) return; // 已构建，跳过

      console.log('[llm] dist not found, building petclaw (first run)...');
      execSync('pnpm build', {
        cwd: projectRoot,
        stdio: 'inherit',
        timeout: 120000,
      });
      console.log('[llm] Build complete.');
    } catch (e) {
      console.warn('[llm] Auto-build failed:', e.message);
    }
  }

  // ===== SOUL.md sync =====

  _getSoulPath() {
    const ocConfig = this._readPetClawConfig();
    const workspace = ocConfig?.agents?.defaults?.workspace || path.join(os.homedir(), 'clawd');
    return path.join(workspace, 'SOUL.md');
  }

  _syncSoulFile(systemPrompt) {
    const soulPath = this._getSoulPath();
    try {
      const dir = path.dirname(soulPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(soulPath, systemPrompt, 'utf-8');
      console.log('[llm] SOUL.md synced:', soulPath);
    } catch (e) {
      console.warn('[llm] Failed to sync SOUL.md:', e.message);
    }
  }

  _loadSoulFile() {
    const soulPath = this._getSoulPath();
    try {
      if (fs.existsSync(soulPath)) {
        const content = fs.readFileSync(soulPath, 'utf-8').trim();
        if (content) return content;
      }
    } catch (e) {
      console.warn('[llm] Failed to read SOUL.md:', e.message);
    }
    return null;
  }

  // ===== Helpers =====

  _getDefaultSessionKey() {
    const defaults = this.helloOk?.snapshot?.sessionDefaults;
    if (defaults?.mainSessionKey) return defaults.mainSessionKey;
    return `agent:${this.config.agentId}:main`;
  }

  _extractText(message) {
    if (!message) return '';
    let content = message;
    if (typeof message === 'object' && message.content !== undefined) content = message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();
    }
    return '';
  }

  _detectSentiment(text) {
    if (/[❤️😊🎉✨😄开心高兴棒好赞喜欢]/.test(text)) return 'positive';
    if (/[😢😭💔难过伤心抱歉对不起错误失败呜]/.test(text)) return 'negative';
    return 'neutral';
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _httpPost(url, headers, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(url), { method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            try { reject(new Error(JSON.parse(data).error?.message || `HTTP ${res.statusCode}`)); }
            catch { reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`)); }
          } else resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时 (30s)')); });
      if (body) req.write(body);
      req.end();
    });
  }

  static getAIProviders() { return AI_PROVIDERS; }

  destroy() {
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
    this.stopGateway();
  }
}

module.exports = { LLMService, AI_PROVIDERS };
