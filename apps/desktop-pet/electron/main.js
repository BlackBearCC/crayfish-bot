/**
 * main.js — Electron 主进程
 *
 * 一体化打包架构：
 * - 透明无框窗口承载桌面宠物
 * - 内部管理 OpenClaw Gateway 生命周期（自动启动/关闭）
 * - 通过 WebSocket RPC 与 OpenClaw Gateway 全能力通信
 * - 用户只需启动一个 exe，一切自动搞定
 */

const { app, BrowserWindow, ipcMain, Menu, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { LLMService, AI_PROVIDERS } = require('./llm-service');
const { Win32Monitor } = require('./win32-monitor');

// ===== 单实例锁 =====
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 这是第二个实例：通知第一个实例重启，然后退出
  app.quit();
}

// 第一个实例收到"有第二个实例想启动"的通知 → 重启自身
app.on('second-instance', () => {
  app.relaunch();
  app.quit();
});

let mainWindow = null;
let llmService = null;
let win32Monitor = null;
let clipboardInterval = null;
let lastClipboardText = '';

// ===== 剪贴板内容类型检测 =====
function detectClipboardType(text) {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return 'url';
  if (/error|exception|traceback|at line \d|syntax error|undefined is not/i.test(t)) return 'error';
  if (/[\{\}]|import |function |class |=>|const |let |var |def |public |private |async |await |#include|SELECT |FROM /.test(t)) return 'code';
  if (t.length > 200) return 'longtext';
  return 'text';
}

// ===== 窗口尺寸（固定大小，不再动态 resize）=====
const PET_SIZE = { width: 620, height: 580 };

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    x: screenWidth - PET_SIZE.width - 50,
    y: screenHeight - PET_SIZE.height - 20,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // ===== IPC: 鼠标穿透 =====
  ipcMain.on('set-ignore-mouse', (event, ignore) => {
    if (mainWindow) mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  // ===== IPC: 窗口拖拽 =====
  ipcMain.on('start-drag', () => {});

  ipcMain.on('move-window', (event, dx, dy) => {
    if (mainWindow) {
      const [wx, wy] = mainWindow.getPosition();
      mainWindow.setPosition(wx + dx, wy + dy);
    }
  });

  ipcMain.handle('get-window-position', () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      return { x, y };
    }
    return { x: 0, y: 0 };
  });

  ipcMain.handle('get-screen-size', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { width, height };
  });

  // ===== IPC: 绝对窗口定位 =====
  ipcMain.on('set-window-position', (e, x, y) => {
    if (mainWindow) mainWindow.setPosition(Math.round(x), Math.round(y));
  });

  // ===== IPC: 获取前台窗口矩形 =====
  ipcMain.handle('get-foreground-window-rect', () => {
    if (!win32Monitor?.available) return null;
    const info = win32Monitor.getForegroundInfo();
    if (!info) return null;
    const rect = win32Monitor.getWindowRect(info.hwnd);
    return rect;
  });

  // ===== IPC: 停靠追踪 =====
  ipcMain.on('start-dock-tracking', () => {
    if (!win32Monitor?.available) return;
    win32Monitor.startDockTracking((update) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dock-target-update', update);
      }
    });
  });

  ipcMain.on('stop-dock-tracking', () => {
    if (win32Monitor) win32Monitor.stopDockTracking();
  });

  // ===== IPC: 窗口展开/收缩（no-op，窗口固定大小）=====
  ipcMain.on('expand-window', () => {});

  // ===== IPC: LLM 对话（兼容旧接口） =====
  ipcMain.handle('chat-with-ai', async (event, message) => {
    return await llmService.chat(message);
  });

  // ===== IPC: 流式聊天 =====
  ipcMain.handle('chat-send', async (event, message, sessionKey) => {
    return await llmService.chatSend(message, sessionKey);
  });

  ipcMain.handle('chat-abort', async (event, sessionKey, runId) => {
    return await llmService.chatAbort(sessionKey, runId);
  });

  ipcMain.handle('chat-history', async (event, sessionKey, limit) => {
    return await llmService.chatHistory(sessionKey, limit);
  });

  // ===== IPC: 会话管理 =====
  ipcMain.handle('sessions-list', async () => {
    return await llmService.sessionsList();
  });

  ipcMain.handle('sessions-reset', async (event, sessionKey, reason) => {
    return await llmService.sessionsReset(sessionKey, reason);
  });

  // ===== IPC: 模型和工具 =====
  ipcMain.handle('models-list', async () => {
    return await llmService.modelsList();
  });

  ipcMain.handle('tools-catalog', async (event, agentId) => {
    return await llmService.toolsCatalog(agentId);
  });

  ipcMain.handle('agents-list', async () => {
    return await llmService.agentsList();
  });

  ipcMain.handle('agent-get', async (event, agentId) => {
    return await llmService.agentGet(agentId);
  });

  // ===== IPC: 配置 =====
  ipcMain.handle('get-config', () => {
    return llmService.getConfig();
  });

  ipcMain.handle('save-config', (event, newConfig) => {
    return llmService.saveConfig(newConfig);
  });

  ipcMain.handle('save-and-apply', async (event, newConfig) => {
    return await llmService.saveAndApply(newConfig);
  });

  ipcMain.handle('write-openclaw-config', (event, aiConfig) => {
    return llmService.writeOpenClawConfig(aiConfig);
  });

  ipcMain.handle('get-gateway-health', () => {
    return llmService.getGatewayHealth();
  });

  ipcMain.handle('get-ai-providers', () => {
    return AI_PROVIDERS;
  });

  ipcMain.handle('clear-chat-history', () => {
    llmService.clearHistory();
    return true;
  });

  // ===== IPC: PetAI — 宠物内心 LLM 直接调用（不过 gateway）=====
  ipcMain.handle('pet-ai-complete', async (event, prompt) => {
    const cfg = llmService.config;
    if (!cfg.aiBaseUrl || !cfg.aiApiKey || !cfg.aiModel) {
      console.warn('[pet-ai] No LLM config available');
      return null;
    }
    try {
      const res = await fetch(`${cfg.aiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.aiApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.aiModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
          temperature: 0.85,
          stream: false,
          enable_thinking: false,
        }),
      });
      if (!res.ok) { console.warn('[pet-ai] LLM error:', res.status); return null; }
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      console.warn('[pet-ai] fetch failed:', e.message);
      return null;
    }
  });

  // ===== IPC: 写入技能文件到 OpenClaw workspace =====
  ipcMain.handle('write-skill-file', (event, skillName, content) => {
    try {
      const skillDir = path.join(os.homedir(), '.openclaw', 'workspace', 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
      console.log(`[pet-ai] Skill written: ${skillName}`);
      return true;
    } catch (e) {
      console.warn('[pet-ai] write-skill-file failed:', e.message);
      return false;
    }
  });

  // ===== IPC: 追加事件到当前 Agent session =====
  ipcMain.handle('append-agent-session', (event, text) => {
    try {
      const sessionsJson = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
      if (!fs.existsSync(sessionsJson)) return false;
      const sessions = JSON.parse(fs.readFileSync(sessionsJson, 'utf-8'));
      // main agent 下可能有多个 session（如用户清空后开了新的），取最近活跃的
      const mainEntries = Object.entries(sessions)
        .filter(([k, s]) => k.startsWith('agent:main:') && s?.sessionFile && fs.existsSync(s.sessionFile));
      if (mainEntries.length === 0) return false;
      mainEntries.sort(([, a], [, b]) => fs.statSync(b.sessionFile).mtimeMs - fs.statSync(a.sessionFile).mtimeMs);
      const sessionFile = mainEntries[0][1].sessionFile;

      // 读取最后一行获取 parentId
      const content = fs.readFileSync(sessionFile, 'utf-8').trimEnd();
      const lines = content.split('\n');
      let parentId = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { parentId = JSON.parse(lines[i]).id; break; } catch {}
      }

      const entry = JSON.stringify({
        type: 'message',
        id: `pet-${Date.now().toString(36)}`,
        parentId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
        },
      });
      fs.appendFileSync(sessionFile, '\n' + entry, 'utf-8');
      console.log('[pet-ai] Session event appended');
      return true;
    } catch (e) {
      console.warn('[pet-ai] append-agent-session failed:', e.message);
      return false;
    }
  });

  // ===== IPC: 追加事件到当日 Agent 记忆 =====
  ipcMain.handle('append-agent-memory', (event, text) => {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const memoryDir = path.join(os.homedir(), '.openclaw', 'workspace', 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const memoryFile = path.join(memoryDir, `${today}.md`);
      const line = `\n- [pet-event] ${text}`;
      fs.appendFileSync(memoryFile, line, 'utf-8');
      console.log('[pet-ai] Memory appended');
      return true;
    } catch (e) {
      console.warn('[pet-ai] append-agent-memory failed:', e.message);
      return false;
    }
  });

  // ===== IPC: 应用控制（自定义右键菜单调用） =====
  ipcMain.on('app-quit', () => app.quit());
  ipcMain.on('open-devtools', () => mainWindow.webContents.openDevTools({ mode: 'detach' }));
  ipcMain.handle('toggle-always-on-top', () => {
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next);
    return next;
  });

  // 渲染进程日志转发
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const prefix = ['[renderer]', '[renderer:WARN]', '[renderer:ERR]'][level] || '[renderer]';
    console.log(`${prefix} ${message}`);
  });

  // 开发模式
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== 启动 =====
app.whenReady().then(async () => {
  llmService = new LLMService();
  await llmService.init();

  win32Monitor = new Win32Monitor();

  createWindow();

  // 注册流式聊天事件转发到渲染进程
  llmService.onChatEvent((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat-stream', payload);
    }
  });

  llmService.onAgentEvent((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-event', payload);
    }
  });

  // Win32 前台窗口轮询
  if (win32Monitor.available) {
    win32Monitor.startForegroundPolling((info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('foreground-app-changed', {
          title: info.title.slice(0, 200),
          processName: info.processName,
          category: info.category,
        });
      }
    }, 4000);
  }

  // Gateway 就绪后通知渲染进程
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('gateway-status', {
        ready: llmService.gatewayReady,
        wsConnected: llmService.wsConnected,
      });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // ===== 剪贴板监控 =====
  clipboardInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const text = clipboard.readText();
      if (text && text !== lastClipboardText && text.trim().length >= 10) {
        lastClipboardText = text;
        const type = detectClipboardType(text);
        mainWindow.webContents.send('clipboard-changed', {
          text: text.substring(0, 600),
          type,
        });
      }
    } catch {}
  }, 2000);
});

app.on('before-quit', () => {
  if (llmService) llmService.destroy();
  if (win32Monitor) win32Monitor.destroy();
  if (clipboardInterval) clearInterval(clipboardInterval);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
