/**
 * WorkspaceWatcher.js
 * 工作区感知 — 解析前台窗口标题，提取项目/文件信息，输出变更事件
 *
 * 设计原则：
 * - 零新 IPC：复用 onForegroundAppChanged 的 title 字段
 * - 独立模块：只输出事件，不修改全局状态
 * - 节流：同项目内切换文件不重复触发
 */

export class WorkspaceWatcher {
  constructor() {
    this._current = null;   // {category, project, file, processName}
    this._sessionStart = 0;
    this._onChangeCallback = null;
  }

  onChange(cb) { this._onChangeCallback = cb; }

  handleAppChange(data) {
    const { title = '', processName = '', category = '' } = data;
    const parsed = this._parse(title, category);
    const info = { ...parsed, category, processName };
    if (this._isDifferent(info)) {
      this._current = info;
      this._sessionStart = Date.now();
      this._onChangeCallback?.(info);
    }
  }

  _parse(title, category) {
    // VS Code: "file.ts - project - Visual Studio Code"
    if (category === 'code_editor' && title.includes(' - ')) {
      const parts = title.split(' - ');
      if (parts.length >= 3) return { file: parts[0].trim(), project: parts[1].trim() };
      if (parts.length === 2) return { file: null, project: parts[0].trim() };
    }
    // JetBrains: "Project – file.py [IDE]"
    if (category === 'code_editor' && title.includes(' \u2013 ')) {
      const parts = title.split(' \u2013 ');
      return { project: parts[0].trim(), file: parts[1]?.split('[')[0].trim() || null };
    }
    // Terminal: 尝试提取最后路径段
    if (category === 'terminal') {
      const match = title.match(/([^/\\:]+)[\s>$#]*$/);
      return { project: match?.[1] || null, file: null };
    }
    return { project: null, file: null };
  }

  _isDifferent(info) {
    if (!this._current) return true;
    return this._current.project !== info.project ||
           this._current.category !== info.category;
  }

  get sessionDuration() { return Date.now() - this._sessionStart; }
  get current() { return this._current; }
}
