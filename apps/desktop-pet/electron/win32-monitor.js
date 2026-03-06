/**
 * win32-monitor.js — Win32 API 封装（koffi）
 *
 * 功能：
 * - 获取前台窗口信息（标题、进程名、分类）
 * - 获取窗口位置/大小
 * - 检测窗口最小化状态
 * - 前台应用切换轮询
 */

let koffi;
let user32, kernel32, psapi;
let available = false;

// Win32 函数指针
let GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId;
let OpenProcess, CloseHandle, GetModuleBaseNameW, GetWindowRect, IsIconic;

// 常量
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

try {
  koffi = require('koffi');

  user32 = koffi.load('user32.dll');
  kernel32 = koffi.load('kernel32.dll');
  psapi = koffi.load('psapi.dll');

  // 定义 RECT 结构体
  const RECT = koffi.struct('RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });

  // 绑定 Win32 函数
  GetForegroundWindow = user32.func('GetForegroundWindow', 'void*', []);
  GetWindowTextW = user32.func('GetWindowTextW', 'int', ['void*', 'str16', 'int']);
  GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['void*', koffi.out(koffi.pointer('uint32'))]);
  OpenProcess = kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32']);
  CloseHandle = kernel32.func('CloseHandle', 'bool', ['void*']);
  GetModuleBaseNameW = psapi.func('GetModuleBaseNameW', 'uint32', ['void*', 'void*', 'str16', 'uint32']);
  GetWindowRect = user32.func('GetWindowRect', 'bool', ['void*', koffi.out(koffi.pointer(RECT))]);
  IsIconic = user32.func('IsIconic', 'bool', ['void*']);

  available = true;
} catch (e) {
  console.warn('[Win32Monitor] koffi not available, Win32 features disabled:', e.message);
}

class Win32Monitor {
  constructor() {
    this._pollTimer = null;
    this._dockTimer = null;
    this._lastProcess = '';
    this._lastTitle = '';
    this._dockHwnd = null;
  }

  get available() {
    return available;
  }

  /**
   * 获取前台窗口信息
   */
  getForegroundInfo() {
    if (!available) return null;

    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;

      // 窗口标题
      const titleBuf = Buffer.alloc(512);
      GetWindowTextW(hwnd, titleBuf, 256);
      const title = titleBuf.toString('utf16le').replace(/\0+$/, '');

      // 进程 ID
      const pidBuf = [0];
      GetWindowThreadProcessId(hwnd, pidBuf);
      const pid = pidBuf[0];

      // 进程名
      let processName = '';
      const hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
      if (hProcess) {
        const nameBuf = Buffer.alloc(520);
        const len = GetModuleBaseNameW(hProcess, null, nameBuf, 260);
        if (len > 0) {
          processName = nameBuf.toString('utf16le').substring(0, len);
        }
        CloseHandle(hProcess);
      }

      const category = this._categorize(processName);

      return { hwnd, title, processName, pid, category };
    } catch (e) {
      console.error('[Win32Monitor] getForegroundInfo error:', e);
      return null;
    }
  }

  /**
   * 获取窗口矩形
   */
  getWindowRect(hwnd) {
    if (!available || !hwnd) return null;

    try {
      const rect = { left: 0, top: 0, right: 0, bottom: 0 };
      const ok = GetWindowRect(hwnd, rect);
      if (!ok) return null;
      return rect;
    } catch {
      return null;
    }
  }

  /**
   * 检测窗口是否最小化
   */
  isMinimized(hwnd) {
    if (!available || !hwnd) return false;
    try {
      return IsIconic(hwnd);
    } catch {
      return false;
    }
  }

  /**
   * 轮询前台窗口切换
   */
  startForegroundPolling(callback, intervalMs = 4000) {
    this.stopForegroundPolling();

    this._pollTimer = setInterval(() => {
      const info = this.getForegroundInfo();
      if (!info) return;

      // 仅在切换时触发
      if (info.processName !== this._lastProcess || info.title !== this._lastTitle) {
        this._lastProcess = info.processName;
        this._lastTitle = info.title;
        callback(info);
      }
    }, intervalMs);
  }

  stopForegroundPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * 开始停靠追踪：锁定当前前台窗口 HWND，200ms 轮询其位置
   */
  startDockTracking(callback) {
    this.stopDockTracking();

    const info = this.getForegroundInfo();
    if (!info) return false;

    this._dockHwnd = info.hwnd;

    this._dockTimer = setInterval(() => {
      if (!this._dockHwnd) { this.stopDockTracking(); return; }

      // 检查最小化
      const minimized = this.isMinimized(this._dockHwnd);
      if (minimized) {
        callback({ minimized: true, rect: null });
        this.stopDockTracking();
        return;
      }

      // 检查是否仍是前台
      const currentHwnd = GetForegroundWindow();
      // hwnd 比较：koffi 返回的指针可能不能直接 === 比较，用 toString
      const isSame = String(currentHwnd) === String(this._dockHwnd);

      const rect = this.getWindowRect(this._dockHwnd);
      if (!rect) {
        callback({ minimized: true, rect: null });
        this.stopDockTracking();
        return;
      }

      callback({ minimized: false, rect, isForeground: isSame });
    }, 200);

    return true;
  }

  stopDockTracking() {
    if (this._dockTimer) {
      clearInterval(this._dockTimer);
      this._dockTimer = null;
    }
    this._dockHwnd = null;
  }

  /**
   * 进程名 → 分类
   */
  _categorize(processName) {
    const name = (processName || '').toLowerCase();

    const matchers = [
      { pattern: /code\.exe|devenv|idea64|pycharm|webstorm|goland|rider|clion|studio64|sublime_text|notepad\+\+|atom/, category: 'code_editor' },
      { pattern: /chrome|msedge|firefox|brave|opera|vivaldi|arc/, category: 'browser' },
      { pattern: /wechat|telegram|discord|qq|slack|teams|dingtalk|feishu|lark/, category: 'chat' },
      { pattern: /steam|epicgames|riot|league|genshin|yuanshen/, category: 'game' },
      { pattern: /windowsterminal|cmd\.exe|powershell|wt\.exe|mintty|conemu|alacritty|wezterm/, category: 'terminal' },
      { pattern: /spotify|vlc|potplayer|foobar|musicbee|aimp|qqmusic|neteasemusic/, category: 'media' },
      { pattern: /winword|excel|powerpnt|onenote|wps|et\.exe|wpp/, category: 'office' },
    ];

    for (const { pattern, category } of matchers) {
      if (pattern.test(name)) return category;
    }

    return 'other';
  }

  destroy() {
    this.stopForegroundPolling();
    this.stopDockTracking();
  }
}

module.exports = { Win32Monitor };
