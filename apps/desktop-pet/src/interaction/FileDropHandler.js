/**
 * FileDropHandler.js
 * 文件拖拽分析 — 把文件拖到宠物上，AI 帮你分析
 *
 * 支持的格式：常见代码/文本文件（白名单）
 * 大文件/二进制 → 友好提示拒绝
 * 分析结果：ChatPanel 打开时流式显示，关闭时 bubble 显示摘要
 */

const ALLOWED_EXTENSIONS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'java', 'kt', 'go', 'rs',
  'cpp', 'c', 'h', 'css', 'html', 'md', 'txt', 'json', 'yaml', 'yml',
  'sh', 'log', 'csv', 'rb', 'php', 'swift',
  'doc', 'docx', 'rtf', 'xml', 'ini', 'conf', 'toml', 'env',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_CONTENT_CHARS = 5000;

export class FileDropHandler {
  /**
   * @param {HTMLElement} _dropTarget - 保留参数（未使用，事件绑定到 document）
   * @param {object} electronAPI
   * @param {import('../pet/StateMachine').StateMachine} stateMachine
   * @param {import('../ui/Bubble').Bubble} bubble
   * @param {import('../ui/ChatPanel').ChatPanel} chatPanel
   * @param {import('../pet/IntimacySystem').IntimacySystem} intimacySystem
   */
  constructor(_dropTarget, electronAPI, stateMachine, bubble, chatPanel, intimacySystem) {
    this.electronAPI = electronAPI;
    this.sm = stateMachine;
    this.bubble = bubble;
    this.chatPanel = chatPanel;
    this.intimacySystem = intimacySystem;

    this._analyzing = false; // 防止并发分析

    this._onDragEnter = this._onDragEnter.bind(this);
    this._onDragOver = this._onDragOver.bind(this);
    this._onDragLeave = this._onDragLeave.bind(this);
    this._onDrop = this._onDrop.bind(this);

    document.addEventListener('dragenter', this._onDragEnter);
    document.addEventListener('dragover', this._onDragOver);
    document.addEventListener('dragleave', this._onDragLeave);
    document.addEventListener('drop', this._onDrop);
  }

  _onDragEnter(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();

    // 禁用鼠标穿透，防止拖拽时窗口消失
    this.electronAPI?.setIgnoreMouse?.(false);

    // 好奇姿势
    this.sm.transition('idle_ear_twitch', { force: true });
    this.bubble.show('放到我这里~ 我来帮你看看！', 3000);
  }

  _onDragOver(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  _onDragLeave(e) {
    // relatedTarget === null 表示离开了窗口
    if (e.relatedTarget !== null) return;
    this.sm.transition('idle', { force: true });
  }

  async _onDrop(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // 如果正在分析，等待（简单排队：丢弃）
    if (this._analyzing) {
      this.bubble.show('等我分析完上一个喵~ 稍等！', 2000);
      return;
    }

    const file = files[0];
    await this._processFile(file);
  }

  async _processFile(file) {
    const ext = this._getExtension(file.name);

    // 不支持的格式
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      this.bubble.show('我不认识这种文件呢 🐾', 3000);
      this.sm.transition('idle', { force: true });
      return;
    }

    // 文件太大
    if (file.size > MAX_FILE_SIZE) {
      this.bubble.show('这个文件太大了，让我处理不了喵 😿', 3000);
      this.sm.transition('idle', { force: true });
      return;
    }

    this._analyzing = true;

    // 开始分析动作
    this.sm.transition('talk', { force: true, duration: 2000 });
    this.bubble.show(`正在分析 ${file.name}... 🔍`, 5000);

    try {
      const content = await this._readFile(file);
      const truncated = content.length > MAX_CONTENT_CHARS;
      const snippet = content.slice(0, MAX_CONTENT_CHARS);

      const fileType = this._describeFileType(ext);
      const prompt = this._buildPrompt(file.name, fileType, snippet, truncated);

      if (this.chatPanel.isOpen) {
        // 流式显示在聊天面板
        this.chatPanel.sendMessage(prompt);
      } else {
        // bubble 显示简短摘要
        if (this.electronAPI?.chatWithAI) {
          try {
            const shortPrompt = `[文件分析] 文件名：${file.name}\n\n${snippet.slice(0, 1500)}\n\n请用中文一句话（不超过80字）概括这个文件的主要功能。`;
            const response = await this.electronAPI.chatWithAI(shortPrompt);
            const summary = (response?.text || '').slice(0, 80);
            this.bubble.show(summary || `已分析 ${file.name} 喵~`, 6000);
          } catch (err) {
            this.bubble.show(`分析完成，${file.name} 是${fileType}文件 🐾`, 4000);
          }
        } else {
          this.bubble.show(`${file.name} 读取完成啦~ 双击我打开聊天来分析吧！`, 4000);
        }
      }

      // 亲密度增益 + 文件拖拽计数（成就系统用）
      this.intimacySystem?.gain(8);
      const dropCount = parseInt(localStorage.getItem('pet-file-drop-count') || '0') + 1;
      localStorage.setItem('pet-file-drop-count', String(dropCount));
      this.sm.transition('happy', { force: true, duration: 3000 });

    } catch (err) {
      console.error('[FileDropHandler] Error processing file:', err);
      this.bubble.show('读取文件时出错了喵... 😿', 3000);
      this.sm.transition('sad', { force: true, duration: 1500 });
    } finally {
      this._analyzing = false;
    }
  }

  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result || '');
      reader.onerror = () => reject(new Error('FileReader error'));
      reader.readAsText(file, 'utf-8');
    });
  }

  _getExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  _describeFileType(ext) {
    const map = {
      js: 'JavaScript代码', ts: 'TypeScript代码', jsx: 'React JSX代码', tsx: 'React TSX代码',
      vue: 'Vue组件', py: 'Python代码', java: 'Java代码', kt: 'Kotlin代码',
      go: 'Go代码', rs: 'Rust代码', cpp: 'C++代码', c: 'C代码', h: 'C头文件',
      css: 'CSS样式', html: 'HTML页面', md: 'Markdown文档', txt: '文本',
      json: 'JSON数据', yaml: 'YAML配置', yml: 'YAML配置', sh: 'Shell脚本',
      log: '日志', csv: 'CSV数据', rb: 'Ruby代码', php: 'PHP代码', swift: 'Swift代码',
      doc: 'Word文档', docx: 'Word文档', rtf: '富文本', xml: 'XML数据',
      ini: '配置文件', conf: '配置文件', toml: 'TOML配置', env: '环境变量',
    };
    return map[ext] || '文本';
  }

  _buildPrompt(filename, fileType, content, truncated) {
    const truncNote = truncated ? `（前${MAX_CONTENT_CHARS}字符）` : '';
    return `[文件分析请求]
文件名：${filename}  类型：${fileType}${truncNote}

\`\`\`
${content}
\`\`\`

请用中文简洁总结这个文件的主要功能，并给出1-2条有用建议。`;
  }

  destroy() {
    document.removeEventListener('dragenter', this._onDragEnter);
    document.removeEventListener('dragover', this._onDragOver);
    document.removeEventListener('dragleave', this._onDragLeave);
    document.removeEventListener('drop', this._onDrop);
  }
}
