/**
 * MemoryGraph.js
 * 记忆簇系统 — 按主题聚合对话片段，为 OpenClaw 提供语义索引层
 *
 * 数据存储在 localStorage('pet-memory-clusters')
 * 每个簇 = 一个主题（theme + keywords + summary + fragments）
 *
 * OpenClaw 联动：
 *   - writeSkillFile('user-profile', ...) 写用户画像（认知层，与事件流水正交）
 *   - recall(query) 检索相关簇，供对话上下文注入
 */

const STORAGE_KEY = 'pet-memory-clusters';
const MAX_CLUSTERS = 50;
const MAX_FRAGMENTS_PER_CLUSTER = 20;
const DEBOUNCE_MS = 3000;
const SNAPSHOT_EVERY = 5;

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 简单中英文分词：按空格/标点/CJK字符边界切分 */
function tokenize(text) {
  if (!text) return [];
  // 提取连续英文单词和单个CJK字符
  const tokens = text.toLowerCase().match(/[a-z0-9_\-]+|[\u4e00-\u9fff]/g) || [];
  return [...new Set(tokens)].filter(t => t.length > 1 || /[\u4e00-\u9fff]/.test(t));
}

export class MemoryGraph {
  constructor(electronAPI) {
    this.electronAPI = electronAPI;
    this._busy = false;
    this._debounceTimer = null;
    this._pendingUserMsg = null;
    this._pendingAiReply = null;
    this._data = this._load();
    this._onChange = null;
  }

  /** 注册变更回调（面板刷新用） */
  onChange(cb) { this._onChange = cb; }

  /** 返回当前数据 */
  getData() { return this._data; }

  /** 获取簇数组 */
  getClusters() { return Object.values(this._data.clusters); }

  /** 获取总 fragment 数 */
  getFragmentCount() {
    return this.getClusters().reduce((sum, c) => sum + c.fragments.length, 0);
  }

  // ─── 提取入口 ───

  /**
   * 加入提取队列（去抖 3 秒）
   */
  enqueueExtraction(userMsg, aiReply) {
    if ((!userMsg && !aiReply) || (userMsg + aiReply).length < 10) return;
    this._pendingUserMsg = userMsg;
    this._pendingAiReply = aiReply;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._doExtract(), DEBOUNCE_MS);
  }

  async _doExtract() {
    const userMsg = this._pendingUserMsg;
    const aiReply = this._pendingAiReply;
    this._pendingUserMsg = null;
    this._pendingAiReply = null;
    if ((!userMsg && !aiReply) || this._busy) return;
    await this.extractAndMerge(userMsg || '', aiReply || '');
  }

  // ─── LLM 提取 ───

  async extractAndMerge(userMsg, aiReply) {
    if (this._busy) return;
    this._busy = true;
    try {
      const themes = this.getClusters().map(c => c.theme).join('、');

      const prompt = `[角色]
你是记忆管理器。

[情景]
用户: ${userMsg.slice(0, 200)}
AI回复: ${aiReply.slice(0, 200)}
已有记忆簇: ${themes || '（空）'}

[任务]
判断这段对话是否包含值得长期记住的用户信息（兴趣/习惯/项目/人际/偏好/情感/技能/工作）。
闲聊、打招呼、简单问答不值得记忆。
如果值得记忆，决定归入已有簇还是新建簇。

返回严格JSON（无代码块标记，无其他文字）：
{"worth":true,"cluster":"已有簇主题或null","newTheme":"新簇主题或null","keywords":["显式关键词1","显式关键词2"],"implicitKeywords":["同义词","上位概念","关联术语","用户可能用的其他说法"],"fragment":"这段对话的记忆摘要，一句话","summaryUpdate":"归入已有簇时更新后的簇摘要，新建时为初始摘要"}
keywords=对话中直接出现的词；implicitKeywords=未直接出现但语义相关的词（同义词、缩写、上位概念、口语说法），用于提升召回率。
不值得记忆时返回：{"worth":false}`;

      const result = await this.electronAPI.petAIComplete(prompt);
      if (!result) return;

      const match = result.match(/\{[\s\S]*\}/);
      if (!match) return;

      const parsed = JSON.parse(match[0]);
      if (!parsed.worth) return;

      this._merge(parsed, userMsg, aiReply);
      this._prune();
      this._data.meta.extractCount++;
      this._data.meta.lastExtractAt = Date.now();
      this._save();

      // 同步簇数据到服务端 memory search 索引
      this._syncToServer();

      // 定期写 OpenClaw 用户画像
      if (this._data.meta.extractCount % SNAPSHOT_EVERY === 0) {
        this._writeUserProfile();
      }

      this._onChange?.();
    } catch (e) {
      console.warn('[MemoryGraph] extractAndMerge failed:', e.message);
    } finally {
      this._busy = false;
    }
  }

  // ─── 合并逻辑 ───

  _merge(parsed, userMsg, aiReply) {
    const { cluster, newTheme, keywords = [], implicitKeywords = [], fragment, summaryUpdate } = parsed;
    const now = Date.now();

    const frag = {
      id: genId('f'),
      text: (fragment || '').slice(0, 120),
      userMsg: (userMsg || '').slice(0, 100),
      aiReply: (aiReply || '').slice(0, 100),
      timestamp: now,
    };

    if (cluster) {
      // 归入已有簇
      const existing = this._findClusterByTheme(cluster);
      if (existing) {
        existing.fragments.push(frag);
        // 限制 fragment 数量
        if (existing.fragments.length > MAX_FRAGMENTS_PER_CLUSTER) {
          existing.fragments = existing.fragments.slice(-MAX_FRAGMENTS_PER_CLUSTER);
        }
        existing.weight++;
        existing.updatedAt = now;
        if (summaryUpdate) existing.summary = summaryUpdate.slice(0, 200);
        // 合并新 keywords
        const kwSet = new Set(existing.keywords);
        for (const kw of keywords) kwSet.add(kw.toLowerCase());
        existing.keywords = [...kwSet].slice(0, 15);
        // 合并隐性关键词
        const ikwSet = new Set(existing.implicitKeywords || []);
        for (const kw of implicitKeywords) ikwSet.add(kw.toLowerCase());
        existing.implicitKeywords = [...ikwSet].slice(0, 20);
        return;
      }
      // 未找到已有簇，降级为新建
    }

    // 新建簇
    const id = genId('mc');
    const newCluster = {
      id,
      theme: (newTheme || cluster || fragment || '').slice(0, 30),
      keywords: keywords.map(k => k.toLowerCase()).slice(0, 10),
      implicitKeywords: implicitKeywords.map(k => k.toLowerCase()).slice(0, 15),
      summary: (summaryUpdate || fragment || '').slice(0, 200),
      fragments: [frag],
      relatedClusters: [],
      weight: 1,
      createdAt: now,
      updatedAt: now,
    };

    this._data.clusters[id] = newCluster;

    // 推断关联：keywords 交集
    this._inferRelations(newCluster);
  }

  _findClusterByTheme(theme) {
    const lower = theme.toLowerCase();
    return Object.values(this._data.clusters).find(
      c => c.theme.toLowerCase() === lower
    );
  }

  /** 通过 keywords 交集推断关联 */
  _inferRelations(newCluster) {
    const newKws = new Set(newCluster.keywords);
    for (const c of Object.values(this._data.clusters)) {
      if (c.id === newCluster.id) continue;
      const overlap = c.keywords.filter(k => newKws.has(k));
      if (overlap.length >= 1) {
        // 双向关联
        if (!newCluster.relatedClusters.includes(c.id)) {
          newCluster.relatedClusters.push(c.id);
        }
        if (!c.relatedClusters.includes(newCluster.id)) {
          c.relatedClusters.push(newCluster.id);
        }
      }
    }
  }

  // ─── 剪枝 ───

  _prune() {
    const clusters = Object.values(this._data.clusters);
    if (clusters.length <= MAX_CLUSTERS) return;

    clusters.sort((a, b) => a.weight - b.weight);
    const toRemove = clusters.slice(0, clusters.length - MAX_CLUSTERS);
    const removeIds = new Set(toRemove.map(c => c.id));

    for (const id of removeIds) {
      delete this._data.clusters[id];
    }

    // 清理 relatedClusters 中的悬挂引用
    for (const c of Object.values(this._data.clusters)) {
      c.relatedClusters = c.relatedClusters.filter(id => !removeIds.has(id));
    }
  }

  // ─── 检索：关键词匹配 ───

  /**
   * 根据查询文本检索相关记忆簇
   * @param {string} query - 用户消息或搜索词
   * @param {number} topK - 返回前 K 个
   * @returns {{ cluster: object, score: number }[]}
   */
  recall(query, topK = 3) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const clusters = this.getClusters();
    const scored = [];

    for (const c of clusters) {
      let score = 0;

      // 1) theme 包含匹配（高权重）
      const themeLower = c.theme.toLowerCase();
      for (const t of queryTokens) {
        if (themeLower.includes(t)) score += 5;
      }

      // 2) keywords 精确匹配
      const kwSet = new Set(c.keywords);
      for (const t of queryTokens) {
        if (kwSet.has(t)) score += 3;
      }

      // 3) implicitKeywords 匹配（隐性关联）
      const ikwSet = new Set(c.implicitKeywords || []);
      for (const t of queryTokens) {
        if (ikwSet.has(t)) score += 2;
      }

      // 4) fragment text 模糊匹配（低权重）
      for (const frag of c.fragments) {
        const fragLower = frag.text.toLowerCase();
        for (const t of queryTokens) {
          if (fragLower.includes(t)) score += 1;
        }
      }

      // 5) summary 匹配
      if (c.summary) {
        const summaryLower = c.summary.toLowerCase();
        for (const t of queryTokens) {
          if (summaryLower.includes(t)) score += 2;
        }
      }

      // 6) 时效衰减：最近更新的簇加分
      const daysSinceUpdate = (Date.now() - c.updatedAt) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 1) score += 2;
      else if (daysSinceUpdate < 7) score += 1;

      if (score > 0) {
        scored.push({ cluster: c, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 生成对话注入文本：recall 后拼接相关簇摘要
   * @param {string} userMsg
   * @returns {string} 注入前缀（空字符串表示无相关记忆）
   */
  buildContextPrefix(userMsg) {
    const results = this.recall(userMsg, 3);
    if (results.length === 0) return '';

    const lines = results.map(r =>
      `- ${r.cluster.theme}: ${r.cluster.summary}`
    );
    return `[记忆参考]\n${lines.join('\n')}\n---\n`;
  }

  // ─── 服务端同步：写入 memory search 索引 ───

  _syncToServer() {
    try {
      const clusters = this.getClusters();
      if (clusters.length === 0) return;

      // 转换为服务端 MemoryClusterInput 格式
      const payload = clusters.map(c => ({
        id: c.id,
        theme: c.theme,
        keywords: c.keywords,
        implicitKeywords: c.implicitKeywords || [],
        summary: c.summary,
        fragments: c.fragments.map(f => ({ text: f.text })),
        weight: c.weight,
        updatedAt: c.updatedAt,
      }));

      this.electronAPI.petRPC?.('pet.memory.sync', { clusters: payload })
        .catch(e => console.warn('[MemoryGraph] sync to server failed:', e?.message));
    } catch { /* fire-and-forget */ }
  }

  // ─── OpenClaw 联动：用户画像 ───

  _writeUserProfile() {
    try {
      const clusters = this.getClusters();
      if (clusters.length === 0) return;

      // 按 weight 降序
      const sorted = [...clusters].sort((a, b) => b.weight - a.weight);

      let md = `---
name: user-profile
description: "宠物通过日常对话积累的用户画像。了解用户兴趣、项目、偏好、人际关系时查阅此文件。"
---

# 用户画像

> 自动维护。共 ${clusters.length} 个记忆主题，${this.getFragmentCount()} 条对话片段。
> 最后更新: ${new Date().toLocaleString('zh-CN')}

`;

      for (const c of sorted) {
        md += `## ${c.theme}\n`;
        md += `> ${c.summary}\n`;
        md += `- 关键词: ${c.keywords.join(', ')}\n`;
        if (c.relatedClusters.length > 0) {
          const relNames = c.relatedClusters
            .map(id => this._data.clusters[id]?.theme)
            .filter(Boolean);
          if (relNames.length > 0) {
            md += `- 关联: ${relNames.join(', ')}\n`;
          }
        }
        md += `- 对话片段: ${c.fragments.length} 条 (最近: ${new Date(c.updatedAt).toLocaleDateString('zh-CN')})\n`;
        md += '\n';
      }

      this.electronAPI.writeSkillFile?.('user-profile', md);
      this._data.meta.lastSnapshotAt = Date.now();
    } catch { /* fire-and-forget */ }
  }

  // ─── 持久化 ───

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.clusters && data.meta) return data;
      }
    } catch { /* ignore */ }
    return { clusters: {}, meta: { extractCount: 0, lastExtractAt: 0, lastSnapshotAt: 0, version: 2 } };
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
    } catch (e) {
      console.warn('[MemoryGraph] save failed:', e.message);
    }
  }
}
