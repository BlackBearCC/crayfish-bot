/**
 * MemoryGraphPanel.js
 * 记忆图谱可视化面板 — Canvas 2D 力导向布局
 *
 * 节点 = 记忆簇（theme 标签，大小按 fragment 数量）
 * 边 = relatedClusters 关联
 * 点击节点 → 展开 fragment 列表
 */

const CLUSTER_COLORS = [
  '#FF8C42', '#8B5CF6', '#3EC98B', '#F59E0B',
  '#EF4444', '#3B82F6', '#EC4899', '#14B8A6',
];

export class MemoryGraphPanel {
  constructor(memoryGraph) {
    this.mg = memoryGraph;
    this.isOpen = false;
    this._rafId = null;
    this._layoutNodes = [];
    this._layoutEdges = [];
    this._dragNode = null;
    this._hoverNode = null;
    this._selectedNode = null; // 点击展开 fragment 的节点
    this._converged = false;
    this._iterCount = 0;
    this._cw = 270;
    this._ch = 340;

    this._createDOM();
    this.mg.onChange(() => {
      if (this.isOpen) this._rebuildLayout();
    });
  }

  // ─── DOM ───

  _createDOM() {
    this.element = document.createElement('div');
    this.element.id = 'memory-graph-panel';
    this.element.innerHTML = `
      <div class="mg-header">
        <span>🧠 记忆图谱</span>
        <button class="mg-close">✕</button>
      </div>
      <div class="mg-body">
        <canvas class="mg-canvas"></canvas>
        <div class="mg-tooltip" style="display:none"></div>
        <div class="mg-empty" style="display:none">还没有记住什么呢...<br>多和我聊聊吧~ 🐾</div>
      </div>
      <div class="mg-detail" style="display:none">
        <div class="mg-detail-header">
          <span class="mg-detail-title"></span>
          <button class="mg-detail-back">← 返回</button>
        </div>
        <div class="mg-detail-summary"></div>
        <div class="mg-detail-keywords"></div>
        <div class="mg-detail-fragments"></div>
      </div>
      <div class="mg-footer">
        <span class="mg-stats"></span>
      </div>
    `;

    this.element.querySelector('.mg-close').onclick = () => this.close();
    this.element.querySelector('.mg-detail-back').onclick = () => this._closeDetail();
    this.canvas = this.element.querySelector('.mg-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tooltipEl = this.element.querySelector('.mg-tooltip');
    this.emptyEl = this.element.querySelector('.mg-empty');
    this.statsEl = this.element.querySelector('.mg-stats');
    this.bodyEl = this.element.querySelector('.mg-body');
    this.detailEl = this.element.querySelector('.mg-detail');

    this._setupCanvasEvents();
    document.body.appendChild(this.element);
  }

  // ─── Panel toggle ───

  open() {
    this.isOpen = true;
    this.element.classList.add('open');
    this._closeDetail();
    this._resizeCanvas();
    this._rebuildLayout();
    this._startRender();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.element.classList.remove('open');
    this._stopRender();
  }

  closeQuiet() { this.close(); }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ─── Canvas sizing ───

  _resizeCanvas() {
    requestAnimationFrame(() => {
      const w = this.bodyEl.clientWidth || 270;
      const h = this.bodyEl.clientHeight || 340;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._cw = w;
      this._ch = h;
    });
  }

  // ─── Layout ───

  _rebuildLayout() {
    const clusters = this.mg.getClusters();
    const fragCount = this.mg.getFragmentCount();

    const hasData = clusters.length > 0;
    this.emptyEl.style.display = hasData ? 'none' : 'flex';
    this.canvas.style.display = hasData ? 'block' : 'none';
    this.statsEl.textContent = hasData
      ? `${clusters.length} 个记忆主题 · ${fragCount} 条对话片段`
      : '';

    if (!hasData) return;

    const w = this._cw;
    const h = this._ch;
    const cx = w / 2;
    const cy = h / 2;

    // 保留已有位置
    const oldPosMap = {};
    for (const ln of this._layoutNodes) {
      oldPosMap[ln.id] = { x: ln.x, y: ln.y };
    }

    // 数据节点 — 圆形初始布局
    const angleStep = (2 * Math.PI) / Math.max(clusters.length, 1);
    this._layoutNodes = clusters.map((c, i) => {
      const old = oldPosMap[c.id];
      const angle = angleStep * i - Math.PI / 2;
      const r = Math.min(w, h) * 0.3;
      const fragSize = Math.min(c.fragments.length, 10);
      const radius = Math.min(12 + fragSize * 2, 28);
      return {
        id: c.id,
        theme: c.theme,
        summary: c.summary,
        fragCount: c.fragments.length,
        weight: c.weight,
        color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
        x: old ? old.x : cx + Math.cos(angle) * r,
        y: old ? old.y : cy + Math.sin(angle) * r,
        vx: 0, vy: 0,
        radius,
      };
    });

    // 构建边 (relatedClusters)
    const nodeIndex = {};
    this._layoutNodes.forEach((n, i) => { nodeIndex[n.id] = i; });

    this._layoutEdges = [];
    const edgeSet = new Set();
    for (const c of clusters) {
      const si = nodeIndex[c.id];
      if (si === undefined) continue;
      for (const relId of c.relatedClusters) {
        const ti = nodeIndex[relId];
        if (ti === undefined) continue;
        const key = si < ti ? `${si}-${ti}` : `${ti}-${si}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        this._layoutEdges.push({ source: si, target: ti });
      }
    }

    this._converged = false;
    this._iterCount = 0;
  }

  // ─── Force simulation ───

  _simulate() {
    if (this._converged) return;

    const nodes = this._layoutNodes;
    const edges = this._layoutEdges;
    const repulsion = 2500;
    const springK = 0.015;
    const restLen = 80;
    const damping = 0.85;
    const padding = 24;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    for (const e of edges) {
      const a = nodes[e.source], b = nodes[e.target];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = springK * (dist - restLen);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // 向心力：防止节点飘太远
    const cx = this._cw / 2;
    const cy = this._ch / 2;
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.002;
      n.vy += (cy - n.y) * 0.002;
    }

    let totalV = 0;
    for (const n of nodes) {
      if (n === this._dragNode) continue;
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(padding + n.radius, Math.min(this._cw - padding - n.radius, n.x));
      n.y = Math.max(padding + n.radius, Math.min(this._ch - padding - n.radius, n.y));
      totalV += Math.abs(n.vx) + Math.abs(n.vy);
    }

    this._iterCount++;
    if (totalV < 0.5 || this._iterCount > 300) {
      this._converged = true;
    }
  }

  // ─── Render ───

  _startRender() {
    this._stopRender();
    const loop = () => {
      this._simulate();
      this._draw();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _stopRender() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this._cw, this._ch);
    const nodes = this._layoutNodes;
    const edges = this._layoutEdges;

    // 边
    for (const e of edges) {
      const a = nodes[e.source], b = nodes[e.target];
      this._drawEdge(ctx, a, b);
    }

    // 节点
    for (const n of nodes) {
      this._drawNode(ctx, n, n === this._hoverNode, n === this._selectedNode);
    }
  }

  _drawEdge(ctx, a, b) {
    const seed = (a.x * 7 + b.y * 13) % 100;
    const mx = (a.x + b.x) / 2 + Math.sin(seed) * 3;
    const my = (a.y + b.y) / 2 + Math.cos(seed) * 3;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.strokeStyle = 'rgba(60,50,40,0.2)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawNode(ctx, node, isHover, isSelected) {
    const { x, y, radius, color, theme, fragCount } = node;

    // 手绘风阴影
    ctx.beginPath();
    ctx.arc(x + 2, y + 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(60,50,40,0.12)';
    ctx.fill();

    // 圆形填充
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isHover || isSelected ? this._lighten(color, 0.25) : color;
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#3C3228' : '#3C3228';
    ctx.lineWidth = isSelected ? 3.5 : isHover ? 3 : 2;
    ctx.stroke();

    // fragment 计数徽章
    if (fragCount > 1) {
      const bx = x + radius * 0.65;
      const by = y - radius * 0.65;
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#3C3228';
      ctx.fill();
      ctx.font = 'bold 9px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fragCount > 9 ? '9+' : String(fragCount), bx, by);
    }

    // 主题标签
    ctx.font = `${isHover || isSelected ? 'bold ' : ''}11px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = '#3C3228';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // 文字截断
    const maxLabelWidth = 60;
    let label = theme;
    if (ctx.measureText(label).width > maxLabelWidth) {
      while (label.length > 2 && ctx.measureText(label + '…').width > maxLabelWidth) {
        label = label.slice(0, -1);
      }
      label += '…';
    }
    ctx.fillText(label, x, y + radius + 5);
  }

  _lighten(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.min(255, Math.round(r + (255 - r) * amount))},${Math.min(255, Math.round(g + (255 - g) * amount))},${Math.min(255, Math.round(b + (255 - b) * amount))})`;
  }

  // ─── Detail panel (fragment 展开) ───

  _showDetail(node) {
    this._selectedNode = node;
    const cluster = this.mg.getData().clusters[node.id];
    if (!cluster) return;

    this.bodyEl.style.display = 'none';
    this.detailEl.style.display = 'flex';

    this.detailEl.querySelector('.mg-detail-title').textContent = cluster.theme;
    this.detailEl.querySelector('.mg-detail-summary').textContent = cluster.summary;
    this.detailEl.querySelector('.mg-detail-keywords').textContent =
      cluster.keywords.map(k => `#${k}`).join('  ');

    const fragContainer = this.detailEl.querySelector('.mg-detail-fragments');
    fragContainer.innerHTML = '';

    // 按时间倒序
    const frags = [...cluster.fragments].sort((a, b) => b.timestamp - a.timestamp);
    for (const f of frags) {
      const el = document.createElement('div');
      el.className = 'mg-fragment';
      const dateStr = new Date(f.timestamp).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      el.innerHTML = `
        <div class="mg-frag-text">${this._escapeHtml(f.text)}</div>
        <div class="mg-frag-meta">
          <span class="mg-frag-date">${dateStr}</span>
        </div>
        ${f.userMsg ? `<div class="mg-frag-quote"><span class="mg-frag-role">用户:</span> ${this._escapeHtml(f.userMsg)}</div>` : ''}
        ${f.aiReply ? `<div class="mg-frag-quote"><span class="mg-frag-role">AI:</span> ${this._escapeHtml(f.aiReply)}</div>` : ''}
      `;
      fragContainer.appendChild(el);
    }
  }

  _closeDetail() {
    this._selectedNode = null;
    this.detailEl.style.display = 'none';
    this.bodyEl.style.display = 'block';
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Canvas interaction ───

  _setupCanvasEvents() {
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverNode = null;
      this._dragNode = null;
      this.tooltipEl.style.display = 'none';
    });
  }

  _canvasXY(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _hitTest(x, y) {
    for (let i = this._layoutNodes.length - 1; i >= 0; i--) {
      const n = this._layoutNodes[i];
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
    }
    return null;
  }

  _onMouseDown(e) {
    const { x, y } = this._canvasXY(e);
    const hit = this._hitTest(x, y);
    if (hit) {
      this._dragNode = hit;
      this._dragStartPos = { x, y };
    }
  }

  _onMouseMove(e) {
    const { x, y } = this._canvasXY(e);

    if (this._dragNode) {
      this._dragNode.x = x;
      this._dragNode.y = y;
      this._dragNode.vx = 0;
      this._dragNode.vy = 0;
      this._converged = false;
      this._iterCount = Math.max(this._iterCount - 10, 0);
      return;
    }

    const hit = this._hitTest(x, y);
    this._hoverNode = hit;
    this.canvas.style.cursor = hit ? 'pointer' : 'default';

    if (hit && hit.summary) {
      this.tooltipEl.textContent = hit.summary;
      this.tooltipEl.style.display = 'block';
      const panelRect = this.bodyEl.getBoundingClientRect();
      this.tooltipEl.style.left = Math.min(e.clientX - panelRect.left + 10, this._cw - 150) + 'px';
      this.tooltipEl.style.top = Math.max(e.clientY - panelRect.top - 32, 4) + 'px';
    } else {
      this.tooltipEl.style.display = 'none';
    }
  }

  _onMouseUp(e) {
    if (this._dragNode && this._dragStartPos) {
      const { x, y } = this._canvasXY(e);
      const dx = x - this._dragStartPos.x;
      const dy = y - this._dragStartPos.y;
      // 判定为点击（而非拖拽）：移动距离 < 5px
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
        this._showDetail(this._dragNode);
      }
    }
    this._dragNode = null;
    this._dragStartPos = null;
  }
}
