/**
 * OpenClawBridge.js
 *
 * [已废弃] — 当前架构为单进程一体化：
 * - LLM 调用在 Electron 主进程 (electron/llm-service.js)
 * - 渲染进程通过 IPC (electronAPI.chatWithAI) 直接调用
 *
 * 保留此文件供后续如需对接外部 OpenClaw Gateway 时恢复使用。
 */

export class OpenClawBridge {
  constructor() {
    console.log('OpenClawBridge is deprecated. Using embedded LLM Service via IPC.');
  }
}
