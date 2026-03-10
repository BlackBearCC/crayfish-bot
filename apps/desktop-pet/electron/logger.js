/**
 * logger.js — 文件日志系统
 *
 * 日志写入 ~/.petclaw/logs/YYYY-MM-DD.log，按天轮转。
 * 覆盖消息流全链路：Gateway 生命周期、WS 连接、聊天消息、事件、记忆图谱、RPC 调用。
 *
 * 用法：
 *   const { logger, installGlobalLogger } = require('./logger');
 *   installGlobalLogger();        // 劫持 console.log/warn/error → 同时写文件
 *   logger.chat('user', text);    // 结构化日志
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.petclaw', 'logs');
const MAX_LOG_DAYS = 7; // 保留最近 7 天日志

// ===== 核心写入 =====

let _currentDate = '';
let _stream = null;

function _ensureStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === _currentDate && _stream) return _stream;

  // 关闭旧 stream
  if (_stream) { try { _stream.end(); } catch {} }

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  _currentDate = today;
  const logFile = path.join(LOG_DIR, `${today}.log`);
  _stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf-8' });

  // 启动时清理过期日志
  _cleanOldLogs();

  return _stream;
}

function _cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    while (files.length > MAX_LOG_DAYS) {
      const old = files.shift();
      fs.unlinkSync(path.join(LOG_DIR, old));
    }
  } catch {}
}

function _timestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function _write(level, tag, message) {
  const line = `${_timestamp()} [${level}][${tag}] ${message}\n`;
  try {
    const stream = _ensureStream();
    stream.write(line);
  } catch {}
}

// ===== 清理 emoji（防止写入时出现乱码） =====
function _clean(text) {
  if (typeof text !== 'string') {
    try { text = JSON.stringify(text); } catch { text = String(text); }
  }
  return text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '');
}

// ===== 结构化日志 API =====

const logger = {
  // --- Gateway 生命周期 ---
  gateway(message) { _write('INFO', 'gateway', _clean(message)); },
  gatewayErr(message) { _write('ERROR', 'gateway', _clean(message)); },

  // --- WebSocket ---
  ws(message) { _write('INFO', 'ws', _clean(message)); },
  wsErr(message) { _write('ERROR', 'ws', _clean(message)); },

  // --- 聊天消息流（完整记录） ---
  chat(direction, content, meta = {}) {
    const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
    _write('INFO', 'chat', `[${direction}] ${_clean(content)}${metaStr}`);
  },

  // --- 聊天流式事件 ---
  chatStream(state, payload) {
    if (state === 'delta') {
      // delta 只记文本片段，不记完整 payload（太多）
      const text = _extractText(payload?.message);
      if (text) _write('DEBUG', 'chat-stream', `delta: ${_clean(text).slice(0, 200)}`);
      return;
    }
    if (state === 'final') {
      const text = _extractText(payload?.message);
      _write('INFO', 'chat-stream', `final: ${_clean(text).slice(0, 1000)}`);
      return;
    }
    // error / aborted / other
    _write('INFO', 'chat-stream', `${state}: ${_clean(JSON.stringify(payload)).slice(0, 500)}`);
  },

  // --- Agent 事件 ---
  agent(payload) {
    _write('INFO', 'agent-event', _clean(JSON.stringify(payload)).slice(0, 1000));
  },

  // --- Character 事件（chat-eval、状态变化等） ---
  character(payload) {
    const kind = payload?.kind || 'unknown';
    _write('INFO', 'char-event', `[${kind}] ${_clean(JSON.stringify(payload)).slice(0, 1000)}`);
  },

  // --- RPC 调用 ---
  rpc(method, params, direction = 'req') {
    const paramsStr = params ? _clean(JSON.stringify(params)).slice(0, 500) : '';
    _write('DEBUG', 'rpc', `${direction} ${method} ${paramsStr}`);
  },
  rpcResult(method, result) {
    const resultStr = result ? _clean(JSON.stringify(result)).slice(0, 500) : '';
    _write('DEBUG', 'rpc', `res ${method} ${resultStr}`);
  },
  rpcErr(method, error) {
    _write('ERROR', 'rpc', `err ${method} ${_clean(error)}`);
  },

  // --- 记忆图谱 ---
  memory(action, detail) {
    _write('INFO', 'memory', `[${action}] ${_clean(detail)}`);
  },

  // --- 通用 ---
  info(tag, message) { _write('INFO', tag, _clean(message)); },
  warn(tag, message) { _write('WARN', tag, _clean(message)); },
  error(tag, message) { _write('ERROR', tag, _clean(message)); },
};

// ===== 文本提取辅助 =====
function _extractText(message) {
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

// ===== 劫持全局 console → 同时写文件 =====

function installGlobalLogger() {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args) => {
    origLog.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    _write('INFO', 'console', _clean(msg));
  };

  console.warn = (...args) => {
    origWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    _write('WARN', 'console', _clean(msg));
  };

  console.error = (...args) => {
    origError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    _write('ERROR', 'console', _clean(msg));
  };

  // 启动标记
  _write('INFO', 'app', '========== Pet-Claw Desktop started ==========');
}

module.exports = { logger, installGlobalLogger };
