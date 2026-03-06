/**
 * ChatPanel.js
 * 迷你聊天面板 — 双击宠物弹出，直接和 AI 对话
 *
 * 支持：流式回复 · 时间戳 · 复制按钮 · Markdown 渲染 · 滚动到底部按钮
 */

export class ChatPanel {
  /**
   * @param {object} electronAPI - preload 暴露的 API
   * @param {import('../pet/StateMachine').StateMachine} stateMachine
   * @param {import('./Bubble').Bubble} bubble
   */
  constructor(electronAPI, stateMachine, bubble) {
    this.electronAPI = electronAPI;
    this.sm = stateMachine;
    this.bubble = bubble;
    this.isOpen = false;
    this.element = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.isSending = false;

    // 流式状态
    this.activeRunId = null;
    this.activeTypingId = null;
    this.streamedText = '';

    // 消息 raw text 映射（供复制用）
    this._rawTextMap = {};

    this._lastUserMessage = '';
    this._memoryGraph = null;

    this._createDOM();
    this._setupStreamListener();
  }

  /** 注入 MemoryGraph 引用，用于对话上下文注入 */
  setMemoryGraph(mg) { this._memoryGraph = mg; }

  /** 返回最后一条用户消息文本 */
  getLastUserMessage() { return this._lastUserMessage; }

  _createDOM() {
    this.element = document.createElement('div');
    this.element.id = 'chat-panel';
    this.element.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">🐾 OpenClaw Chat</span>
        <div class="chat-header-actions">
          <button class="chat-abort" title="中止回复" style="display:none">■</button>
          <button class="chat-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="chat-messages">
        <button class="scroll-to-bottom" title="滚动到底部">↓</button>
      </div>
      <div class="chat-input-area">
        <input type="text" class="chat-input" placeholder="跟我说点什么喵~" />
        <button class="chat-send" title="发送">➤</button>
      </div>
    `;

    this.messagesEl = this.element.querySelector('.chat-messages');
    this.inputEl = this.element.querySelector('.chat-input');
    this.sendBtn = this.element.querySelector('.chat-send');
    this.abortBtn = this.element.querySelector('.chat-abort');
    this.scrollBtn = this.element.querySelector('.scroll-to-bottom');
    const closeBtn = this.element.querySelector('.chat-close');

    this.sendBtn.addEventListener('click', () => this._send());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    this.abortBtn.addEventListener('click', () => this._abort());
    closeBtn.addEventListener('click', () => this.close());

    // 滚动到底部按钮
    this.scrollBtn.addEventListener('click', () => {
      this._scrollToBottom(true);
    });

    // 监听滚动，控制按钮显隐
    this.messagesEl.addEventListener('scroll', () => this._onScroll());

    document.body.appendChild(this.element);
  }

  /**
   * 监听来自主进程的流式聊天事件
   */
  _setupStreamListener() {
    if (!this.electronAPI?.onChatStream) return;

    this.electronAPI.onChatStream((payload) => {
      if (!payload) return;

      // 必须等 chatSend 返回设置 activeRunId 后才处理事件，
      // 否则会误捕获上一轮的迟到事件导致回复错位
      if (!this.isSending) return;
      if (!this.activeRunId) return;
      if (payload.runId !== this.activeRunId) return;

      if (payload.state === 'delta') {
        const text = this._extractText(payload.message);
        if (text) {
          this.streamedText = text;
          // 流式中间状态用 plain text
          this._replaceMessage(this.activeTypingId, text, false);
          this.sm.transition('talk', { force: true, duration: 500 });
        }
      }

      if (payload.state === 'final') {
        const finalText = this._extractText(payload.message) || this.streamedText || '喵？';
        // final 时切换为 markdown
        this._replaceMessage(this.activeTypingId, finalText, true);
        this._finishSending(finalText);
      }

      if (payload.state === 'error') {
        const errMsg = payload.errorMessage || '出错了喵~';
        this._replaceMessage(this.activeTypingId, errMsg, true);
        this._finishSending(errMsg, 'negative');
      }

      if (payload.state === 'aborted') {
        this._replaceMessage(this.activeTypingId, '（已中止）', false);
        this._finishSending('（已中止）', 'neutral');
      }
    });
  }

  async _send() {
    const text = this.inputEl.value.trim();
    if (!text || this.isSending) return;

    this.inputEl.value = '';
    this._lastUserMessage = text;
    this._addMessage('user', text);

    this.isSending = true;
    this.sendBtn.style.display = 'none';
    this.abortBtn.style.display = 'flex';
    this.sm.transition('talk', { force: true, duration: 2000 });

    // 显示打字指示
    this.activeTypingId = this._addMessage('assistant', '...', false);
    this.streamedText = '';

    // 记忆图谱上下文注入：将相关记忆拼入发送文本
    let sendText = text;
    if (this._memoryGraph) {
      const prefix = this._memoryGraph.buildContextPrefix(text);
      if (prefix) sendText = prefix + text;
    }

    // 尝试使用流式聊天，fallback 到旧接口
    if (this.electronAPI.chatSend) {
      try {
        const result = await this.electronAPI.chatSend(sendText);
        this.activeRunId = result.runId;
        // 流式事件将通过 _setupStreamListener 处理
      } catch (e) {
        console.warn('Stream send failed, falling back:', e.message);
        await this._sendLegacy(sendText);
      }
    } else {
      await this._sendLegacy(sendText);
    }
  }

  /**
   * 旧接口 fallback
   */
  async _sendLegacy(text) {
    try {
      const response = await this.electronAPI.chatWithAI(text);
      this._replaceMessage(this.activeTypingId, response.text, true);
      this._finishSending(response.text, response.sentiment);
    } catch (e) {
      this._replaceMessage(this.activeTypingId, `出错了喵: ${e.message}`, false);
      this._finishSending(null, 'negative');
    }
  }

  _finishSending(text, sentiment) {
    this.isSending = false;
    this.activeRunId = null;
    this.sendBtn.style.display = 'flex';
    this.abortBtn.style.display = 'none';

    if (sentiment === 'positive') {
      this.sm.transition('happy', { force: true, duration: 3000 });
    } else if (sentiment === 'negative') {
      this.sm.transition('sad', { force: true, duration: 1500 });
    } else if (text) {
      const s = this._detectSentiment(text);
      if (s === 'positive') this.sm.transition('happy', { force: true, duration: 3000 });
      else if (s === 'negative') this.sm.transition('sad', { force: true, duration: 1500 });
      else this.sm.transition('idle', { force: true });
    } else {
      this.sm.transition('idle', { force: true });
    }

    // 气泡简短显示
    if (text && text.length > 0) {
      const shortText = text.length > 30 ? text.substring(0, 30) + '...' : text;
      this.bubble.show(shortText, 3000);
    }
  }

  async _abort() {
    if (!this.electronAPI.chatAbort) return;
    try {
      await this.electronAPI.chatAbort();
    } catch (e) {
      console.warn('Abort failed:', e.message);
    }
  }

  /**
   * 添加消息气泡
   * @param {string} role - 'user' | 'assistant'
   * @param {string} text
   * @param {boolean} [renderMarkdown=true]
   * @returns {string} id
   */
  _addMessage(role, text, renderMarkdown = true) {
    const id = 'msg-' + Date.now() + Math.random().toString(36).slice(2, 6);
    this._rawTextMap[id] = text;

    const div = document.createElement('div');
    div.className = `chat-msg chat-msg-${role}`;
    div.id = id;

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = '复制';
    copyBtn.textContent = '\u{1F4CB}';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = this._rawTextMap[id] || text;
      navigator.clipboard.writeText(raw).then(() => {
        copyBtn.textContent = '\u2713';
        setTimeout(() => { copyBtn.textContent = '\u{1F4CB}'; }, 1500);
      });
    });

    // 内容区
    const contentEl = document.createElement('div');
    contentEl.className = 'msg-content';
    if (renderMarkdown && role === 'assistant') {
      contentEl.innerHTML = this._renderMarkdown(text);
      contentEl.classList.add('markdown-body');
    } else {
      contentEl.textContent = text;
    }

    // 时间戳
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = this._formatTime();

    div.appendChild(copyBtn);
    div.appendChild(contentEl);
    div.appendChild(timeEl);

    // 插入到 scrollBtn 之前，保持 scrollBtn 在末尾
    this.messagesEl.insertBefore(div, this.scrollBtn);
    this._scrollToBottom();
    return id;
  }

  /**
   * 替换消息内容
   * @param {string} id
   * @param {string} newText
   * @param {boolean} [renderMarkdown=false]
   */
  _replaceMessage(id, newText, renderMarkdown = false) {
    const el = document.getElementById(id);
    if (!el) {
      delete this._rawTextMap[id]; // 元素已不在 DOM，清理过期条目
      return;
    }
    this._rawTextMap[id] = newText;

    const contentEl = el.querySelector('.msg-content');
    if (!contentEl) return;

    if (renderMarkdown) {
      contentEl.innerHTML = this._renderMarkdown(newText);
      contentEl.classList.add('markdown-body');
    } else {
      contentEl.textContent = newText;
      contentEl.classList.remove('markdown-body');
    }
    this._scrollToBottom();
  }

  /**
   * 渲染 Markdown（若 marked.js 可用）
   */
  _renderMarkdown(text) {
    if (window.marked) {
      try {
        return window.marked.parse(text);
      } catch (e) {
        // fallback to plain text
      }
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  /**
   * 从 chat 事件 message 中提取文本
   */
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

  _formatTime() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  _scrollToBottom(force = false) {
    const el = this.messagesEl;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (force || isNearBottom) {
      el.scrollTop = el.scrollHeight;
      this.scrollBtn.classList.remove('visible');
    }
  }

  _onScroll() {
    const el = this.messagesEl;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 80) {
      this.scrollBtn.classList.add('visible');
    } else {
      this.scrollBtn.classList.remove('visible');
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.element.classList.add('open');
    setTimeout(() => this.inputEl.focus(), 100);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.element.classList.remove('open');
  }

  closeQuiet() {
    this.close();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /**
   * 以编程方式发送消息（供文件拖拽分析等外部调用）
   * @param {string} text
   */
  sendMessage(text) {
    if (!this.isOpen) this.open();
    this.inputEl.value = text;
    this._send();
  }

  destroy() {
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
