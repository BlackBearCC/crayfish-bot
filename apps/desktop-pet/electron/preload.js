/**
 * preload.js — Electron 预加载脚本
 *
 * 安全地暴露所有 API 给渲染进程，包括 OpenClaw 全能力通道
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // === 鼠标穿透 ===
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),

  // === 窗口拖拽 ===
  startDrag: () => ipcRenderer.send('start-drag'),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),

  // === 屏幕信息 ===
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),

  // === 窗口展开/收缩 ===
  expandWindow: (expand, customSize) => ipcRenderer.send('expand-window', expand, customSize),

  // === 应用控制 ===
  appQuit: () => ipcRenderer.send('app-quit'),
  openDevTools: () => ipcRenderer.send('open-devtools'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),

  // === AI 对话（兼容旧接口） ===
  chatWithAI: (message) => ipcRenderer.invoke('chat-with-ai', message),
  clearChatHistory: () => ipcRenderer.invoke('clear-chat-history'),

  // === 流式聊天（WebSocket RPC） ===
  chatSend: (message, sessionKey) => ipcRenderer.invoke('chat-send', message, sessionKey),
  chatAbort: (sessionKey, runId) => ipcRenderer.invoke('chat-abort', sessionKey, runId),
  chatHistory: (sessionKey, limit) => ipcRenderer.invoke('chat-history', sessionKey, limit),

  // === 会话管理 ===
  getSessionsList: () => ipcRenderer.invoke('sessions-list'),
  sessionsReset: (sessionKey, reason) => ipcRenderer.invoke('sessions-reset', sessionKey, reason),

  // === 模型和工具 ===
  modelsList: () => ipcRenderer.invoke('models-list'),
  toolsCatalog: (agentId) => ipcRenderer.invoke('tools-catalog', agentId),
  agentsList: () => ipcRenderer.invoke('agents-list'),
  agentGet: (agentId) => ipcRenderer.invoke('agent-get', agentId),

  // === 配置 ===
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  saveAndApply: (config) => ipcRenderer.invoke('save-and-apply', config),
  writeOpenClawConfig: (aiConfig) => ipcRenderer.invoke('write-openclaw-config', aiConfig),
  getGatewayHealth: () => ipcRenderer.invoke('get-gateway-health'),
  getAIProviders: () => ipcRenderer.invoke('get-ai-providers'),

  // === 绝对窗口定位 ===
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),

  // === Win32 窗口感知 ===
  getForegroundWindowRect: () => ipcRenderer.invoke('get-foreground-window-rect'),
  startDockTracking: () => ipcRenderer.send('start-dock-tracking'),
  stopDockTracking: () => ipcRenderer.send('stop-dock-tracking'),

  // === 监听主进程事件 ===
  onToggleChat: (callback) => ipcRenderer.on('toggle-chat', () => callback()),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', () => callback()),
  onOpenSkills: (callback) => ipcRenderer.on('open-skills', () => callback()),
  onResizePet: (callback) => ipcRenderer.on('resize-pet', (e, size) => callback(size)),
  onChatCleared: (callback) => ipcRenderer.on('chat-cleared', () => callback()),
  onGatewayStatus: (callback) => ipcRenderer.on('gateway-status', (e, status) => callback(status)),

  // === 流式回复事件 ===
  onChatStream: (callback) => ipcRenderer.on('chat-stream', (e, payload) => callback(payload)),
  onAgentEvent: (callback) => ipcRenderer.on('agent-event', (e, payload) => callback(payload)),

  // === 情感互动事件 ===
  onFeedPet: (callback) => ipcRenderer.on('feed-pet', () => callback()),
  onClipboardChange: (callback) => ipcRenderer.on('clipboard-changed', (e, data) => callback(data)),

  // === Win32 窗口感知事件 ===
  onForegroundAppChanged: (callback) => ipcRenderer.on('foreground-app-changed', (e, data) => callback(data)),
  onDockTargetUpdate: (callback) => ipcRenderer.on('dock-target-update', (e, data) => callback(data)),
  onToggleDocking: (callback) => ipcRenderer.on('toggle-docking', (e, enabled) => callback(enabled)),

  // === PetAI — 宠物内心活动，直接调 LLM，不过 gateway ===
  petAIComplete: (prompt) => ipcRenderer.invoke('pet-ai-complete', prompt),

  // === Agent 记忆写入 ===
  writeSkillFile: (skillName, content) => ipcRenderer.invoke('write-skill-file', skillName, content),
  appendAgentSession: (text) => ipcRenderer.invoke('append-agent-session', text),
  appendAgentMemory: (text) => ipcRenderer.invoke('append-agent-memory', text),
});
