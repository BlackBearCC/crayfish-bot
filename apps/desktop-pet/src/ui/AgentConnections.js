/**
 * AgentConnections.js
 * 多 Agent 协作可视化 — SVG 连线 + 工具徽章
 *
 * 在 pet-area 上叠加 SVG 层，从主猫中心向每只小分身连线：
 * - idle：细虚线低透明
 * - busy：实线 + animateMotion 流光粒子 + 工具图标徽章
 *
 * 250ms 轮询更新（非每帧 RAF，节省性能）
 */

import { ICON_MAP } from './ToolStatusBar.js';

// pet-area 200×250 内的坐标（px）
// 主猫中心（canvas 128px 居中，底部对齐）
const MAIN = [100, 186];

// 对应 MiniCatSystem._positions 四个槽位的小猫中心（48px 画布中心）
// slot 0: left:4,bottom:80  → center x=4+24=28, y=250-80-24=146
// slot 1: right:4,bottom:80 → center x=200-4-24=172, y=146
// slot 2: left:4,bottom:150 → center x=28, y=250-150-24=76
// slot 3: right:4,bottom:150→ center x=172, y=76
const SLOT_CENTERS = [
  [28, 146],
  [172, 146],
  [28, 76],
  [172, 76],
];

const NS = 'http://www.w3.org/2000/svg';

export class AgentConnections {
  constructor(petArea, miniCatSystem, agentStatsTracker = null) {
    this.miniCatSystem = miniCatSystem;
    this.agentStatsTracker = agentStatsTracker;
    this._timer = null;

    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'agent-connections-svg');
    this.svg.setAttribute('viewBox', '0 0 200 250');
    this.svg.setAttribute('width', '200');
    this.svg.setAttribute('height', '250');
    petArea.appendChild(this.svg);

    this._timer = setInterval(() => this._update(), 250);
  }

  _update() {
    // Clear
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    const cats = this.miniCatSystem?.miniCats;
    if (!cats || cats.size === 0) return;

    for (const [, cat] of cats) {
      const [cx, cy] = SLOT_CENTERS[cat.slotIndex] ?? MAIN;
      const busy = cat._busy;

      // 连线
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', MAIN[0]); line.setAttribute('y1', MAIN[1]);
      line.setAttribute('x2', cx);      line.setAttribute('y2', cy);
      line.setAttribute('class', `agent-line ${busy ? 'busy' : 'idle'}`);
      this.svg.appendChild(line);

      if (busy) {
        // 流光粒子
        const circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('r', '3');
        circle.setAttribute('fill', 'rgba(255,160,50,0.9)');
        const anim = document.createElementNS(NS, 'animateMotion');
        anim.setAttribute('dur', '1.2s');
        anim.setAttribute('repeatCount', 'indefinite');
        anim.setAttribute('path', `M${MAIN[0]},${MAIN[1]} L${cx},${cy}`);
        circle.appendChild(anim);
        this.svg.appendChild(circle);

        // 工具徽章
        if (cat._currentTool) {
          const icon = this._resolveIcon(cat._currentTool);
          const fo = document.createElementNS(NS, 'foreignObject');
          fo.setAttribute('x', String(cx + 10));
          fo.setAttribute('y', String(cy - 20));
          fo.setAttribute('width', '20');
          fo.setAttribute('height', '20');
          const div = document.createElement('div');
          div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
          div.className = 'agent-badge';
          div.textContent = icon;
          fo.appendChild(div);
          this.svg.appendChild(fo);
        }

        // 任务名标签
        const entry = this.agentStatsTracker?.get(cat.session?.key);
        const taskName = entry?.taskName || cat.session?.derivedTitle || '';
        if (taskName) {
          const mx = Math.round((MAIN[0] + cx) / 2);
          const my = Math.round((MAIN[1] + cy) / 2) - 6;
          const label = document.createElementNS(NS, 'text');
          label.setAttribute('x', String(mx));
          label.setAttribute('y', String(my));
          label.setAttribute('class', 'agent-task-label');
          label.setAttribute('text-anchor', 'middle');
          label.textContent = taskName.length > 12 ? taskName.slice(0, 11) + '\u2026' : taskName;
          this.svg.appendChild(label);
        }
      }
    }
  }

  _resolveIcon(toolName) {
    const lower = toolName.toLowerCase();
    for (const [k, v] of Object.entries(ICON_MAP)) {
      if (lower.includes(k)) return v;
    }
    return '⚡';
  }

  destroy() {
    clearInterval(this._timer);
    this.svg.remove();
  }
}
