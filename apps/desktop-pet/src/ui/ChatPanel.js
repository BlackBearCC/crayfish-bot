/**
 * ChatPanel.js
 * 迷你聊天面板 — 双击宠物弹出，直接和 AI 对话
 *
 * 支持：流式回复 · 时间戳 · 复制按钮 · Markdown 渲染 · 滚动到底部按钮
 */

export class ChatPanel {
  /**
   * @param {object} electronAPI - preload 暴露的 API
   * @param {import('../character/StateMachine').StateMachine} stateMachine
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

    // 流式状态 — 支持多条并发消息
    this.activeRunId = null;
    this.activeTypingId = null;
    this.streamedText = '';
    /** @type {Map<string, {typingId: string, streamedText: string}>} */
    this._activeStreams = new Map();
    /** 连击计数 + 定时器 */
    this._comboCount = 0;
    this._comboTimer = null;

    // 消息 raw text 映射（供复制用）
    this._rawTextMap = {};

    this._lastUserMessage = '';

    // 历史加载状态：脏标记 + 防并发锁
    this._historyStale = true;
    this._historyLoading = false;

    this._createDOM();
    this._setupStreamListener();
  }

  /** 返回最后一条用户消息文本 */
  getLastUserMessage() { return this._lastUserMessage; }

  _createDOM() {
    this.element = document.createElement('div');
    this.element.id = 'chat-panel';
    this.element.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">🐾 PetClaw Chat</span>
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
        <div class="chat-send-wrap">
          <button class="chat-send" title="发送">➤</button>
          <span class="chat-combo-badge" style="display:none"></span>
        </div>
      </div>
    `;

    this.messagesEl = this.element.querySelector('.chat-messages');
    this.inputEl = this.element.querySelector('.chat-input');
    this.sendBtn = this.element.querySelector('.chat-send');
    this.abortBtn = this.element.querySelector('.chat-abort');
    this.scrollBtn = this.element.querySelector('.scroll-to-bottom');
    this.comboBadge = this.element.querySelector('.chat-combo-badge');
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
      if (!payload || !payload.runId) return;

      const streamKey = payload.runId;
      const stream = this._activeStreams.get(streamKey);
      if (!stream) return;

      if (payload.state === 'delta') {
        const text = this._extractText(payload.message);
        if (text) {
          stream.streamedText = text;
          this._replaceMessage(stream.typingId, text, false);
          this.sm.transition('talk', { force: true, duration: 500 });
        }
      }

      if (payload.state === 'final') {
        const finalText = this._extractText(payload.message) || stream.streamedText;
        if (!finalText) {
          // Empty final — message was likely queued/deferred. Keep stream alive.
          return;
        }
        this._replaceMessage(stream.typingId, finalText, true);
        this._activeStreams.delete(streamKey);
        this._onStreamFinish(finalText);
      }

      if (payload.state === 'error') {
        const errMsg = payload.errorMessage || '出错了喵~';
        this._replaceMessage(stream.typingId, errMsg, true);
        this._activeStreams.delete(streamKey);
        this._onStreamFinish(errMsg, 'negative');
      }

      if (payload.state === 'aborted') {
        this._replaceMessage(stream.typingId, '（已中止）', false);
        this._activeStreams.delete(streamKey);
        this._onStreamFinish('（已中止）', 'neutral');
      }
    });
  }

  async _send() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = '';
    this._lastUserMessage = text;
    this._addMessage('user', text);

    this.isSending = true;
    this.abortBtn.style.display = 'flex';
    this.sm.transition('talk', { force: true, duration: 2000 });

    // 连击计数
    this._comboCount++;
    this._updateCombo();

    // 显示打字指示
    const typingId = this._addMessage('assistant', '...', false);

    // 尝试使用流式聊天，fallback 到旧接口
    if (this.electronAPI.chatSend) {
      try {
        const runId = crypto.randomUUID();
        // 注册到并发流跟踪
        this._activeStreams.set(runId, { typingId, streamedText: '' });
        // 兼容：保持最新的 activeRunId（用于 abort）
        this.activeRunId = runId;
        this.activeTypingId = typingId;
        this.streamedText = '';
        await this.electronAPI.chatSend(text, undefined, runId);
      } catch (e) {
        console.warn('Stream send failed, falling back:', e.message);
        await this._sendLegacy(text);
      }
    } else {
      this.activeTypingId = typingId;
      await this._sendLegacy(text);
    }
  }

  /**
   * 旧接口 fallback
   */
  async _sendLegacy(text) {
    try {
      const response = await this.electronAPI.chatWithAI(text);
      this._replaceMessage(this.activeTypingId, response.text, true);
      this._onStreamFinish(response.text, response.sentiment);
    } catch (e) {
      this._replaceMessage(this.activeTypingId, `出错了喵: ${e.message}`, false);
      this._onStreamFinish(null, 'negative');
    }
  }

  /**
   * 单条流完成时调用（支持多条并发）
   */
  _onStreamFinish(text, sentiment) {
    // 所有流都结束时才恢复发送按钮状态
    if (this._activeStreams.size === 0) {
      this.isSending = false;
      this.activeRunId = null;
      this.abortBtn.style.display = 'none';
    }

    if (sentiment === 'positive') {
      this.sm.transition('happy', { force: true, duration: 3000 });
    } else if (sentiment === 'negative') {
      this.sm.transition('sad', { force: true, duration: 1500 });
    } else if (text) {
      const s = this._detectSentiment(text);
      if (s === 'positive') this.sm.transition('happy', { force: true, duration: 3000 });
      else if (s === 'negative') this.sm.transition('sad', { force: true, duration: 1500 });
      else if (this._activeStreams.size === 0) this.sm.transition('idle', { force: true });
    } else if (this._activeStreams.size === 0) {
      this.sm.transition('idle', { force: true });
    }

    // 气泡简短显示
    if (text && text.length > 0) {
      const shortText = text.length > 30 ? text.substring(0, 30) + '...' : text;
      this.bubble.show(shortText, 3000);
    }
  }

  /** 更新连击徽章 */
  _updateCombo() {
    if (this._comboCount >= 2) {
      this.comboBadge.textContent = `×${this._comboCount}`;
      this.comboBadge.style.display = '';
      this.comboBadge.classList.add('pop');
      setTimeout(() => this.comboBadge.classList.remove('pop'), 300);
    }
    // 3 秒无新消息 → 重置连击
    clearTimeout(this._comboTimer);
    this._comboTimer = setTimeout(() => {
      this._comboCount = 0;
      this.comboBadge.style.display = 'none';
    }, 3000);
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
   * @param {number} [timestamp] - 历史消息时间戳（ms），不传则取当前时间
   * @returns {string} id
   */
  _addMessage(role, text, renderMarkdown = true, timestamp) {
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
    timeEl.textContent = this._formatTime(timestamp);

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
   * 支持: string | { text } | { content: string } | { content: [{type:'text',text}] }
   * text 字段优先（与服务端 extractAssistantText 行为一致）
   */
  _extractText(message) {
    if (!message) return '';
    if (typeof message === 'string') return message.trim();
    if (typeof message === 'object') {
      // text 字段优先（历史消息可能同时有 text 和 content）
      if (typeof message.text === 'string') {
        const t = message.text.trim();
        if (t) return t;
      }
      const content = message.content;
      if (content === undefined) return '';
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('\n')
          .trim();
      }
    }
    return '';
  }

  /**
   * 清空消息区域（保留 scrollBtn）
   */
  _clearMessages() {
    const msgs = this.messagesEl.querySelectorAll('.chat-msg');
    msgs.forEach(el => el.remove());
    this._rawTextMap = {};
  }

  /**
   * 从服务端加载聊天历史并渲染（仅在脏标记时触发，防并发）
   */
  async _loadHistory() {
    if (!this.electronAPI?.chatHistory) return;
    if (!this._historyStale) return;
    if (this._historyLoading) return;
    // 正在发送时不重新加载，避免丢掉流式占位符
    if (this.isSending) return;

    this._historyLoading = true;
    try {
      const res = await this.electronAPI.chatHistory(undefined, 50);
      const messages = res?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        this._historyStale = false;
        return;
      }

      this._clearMessages();

      // debug: 首次加载时输出消息格式，便于排查角色/内容问题
      if (messages.length > 0) {
        const sample = messages.slice(0, 3).map(m => ({
          role: m?.role, hasContent: m?.content !== undefined, hasText: typeof m?.text === 'string',
        }));
        console.log('[ChatPanel] History sample:', sample);
      }

      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        // 跳过 system/tool/unknown 角色
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;
        let text = this._extractText(msg);
        if (!text) continue;

        // 内部事件/角色反应 → 小型系统通知
        const eventMatch = text.match(/^\[(event|character):[^\]]*\]\s*([\s\S]*)/);
        if (eventMatch) {
          const label = eventMatch[2].trim();
          if (label) this._addSystemMessage(label, msg.timestamp);
          continue;
        }

        this._addMessage(msg.role, text, msg.role === 'assistant', msg.timestamp);
      }
      this._historyStale = false;
      this._scrollToBottom(true);
    } catch (e) {
      console.warn('[ChatPanel] Failed to load history:', e.message);
    } finally {
      this._historyLoading = false;
    }
  }

  /**
   * 外部组件追加消息（供 BottomChatInput 等调用）
   * 面板打开时实时追加；关闭时仅标记脏位，下次打开时拉取
   * @param {'user'|'assistant'} role
   * @param {string} text
   */
  appendExternal(role, text) {
    if (!this.isOpen) {
      this._historyStale = true;
      return;
    }
    this._addMessage(role, text, role === 'assistant');
  }

  /**
   * 添加小型系统通知消息（居中、半透明、无边框）
   */
  _addSystemMessage(text, timestamp) {
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-system';

    const contentEl = document.createElement('div');
    contentEl.className = 'msg-content';
    contentEl.textContent = text;

    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = this._formatTime(timestamp);

    div.appendChild(contentEl);
    div.appendChild(timeEl);
    this.messagesEl.insertBefore(div, this.scrollBtn);
  }

  _detectSentiment(text) {
    if (/[❤️😊🎉✨😄开心高兴棒好赞喜欢]/.test(text)) return 'positive';
    if (/[😢😭💔难过伤心抱歉对不起错误失败呜]/.test(text)) return 'negative';
    return 'neutral';
  }

  _formatTime(timestamp) {
    const d = timestamp ? new Date(timestamp) : new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
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
    this._restorePanelSize();
    this.element.classList.add('open');
    this.onStateChange?.();
    this._loadHistory();
    setTimeout(() => this.inputEl.focus(), 100);
  }

  close() {
    if (!this.isOpen) return;
    this._savePanelSize();
    this.isOpen = false;
    this.element.classList.remove('open');
    this.onStateChange?.();
  }

  /** Save current panel size to localStorage */
  _savePanelSize() {
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    if (w > 0 && h > 0) {
      localStorage.setItem('chatPanelSize', JSON.stringify({ w, h }));
    }
  }

  /** Restore saved panel size from localStorage */
  _restorePanelSize() {
    try {
      const saved = JSON.parse(localStorage.getItem('chatPanelSize'));
      if (saved?.w && saved?.h) {
        this.element.style.width = saved.w + 'px';
        this.element.style.height = saved.h + 'px';
      }
    } catch {}
  }

  closeQuiet() {
    this.isOpen = false;
    this.element.classList.remove('open');
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
