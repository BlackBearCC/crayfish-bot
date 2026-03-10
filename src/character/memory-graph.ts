/**
 * Character Engine — MemoryGraphSystem
 *
 * Server-side memory cluster management:
 * - Receives userMsg + aiReply after each chat completion
 * - Calls LLM to extract memorable info (interests/habits/projects/preferences)
 * - Manages clusters (merge, prune, keyword inference)
 * - Indexes clusters into memory_search (SQLite FTS) via callback
 *
 * Persistence: file-based JSON via PersistenceStore (same as other character subsystems).
 * LLM calls: injected callback (set by gateway).
 */

import type { PersistenceStore } from "./attribute-engine.js";

// ─── Types ───

export type LLMCompleteCallback = (prompt: string) => Promise<string | null>;

export interface MemoryCluster {
  id: string;
  theme: string;
  keywords: string[];
  implicitKeywords: string[];
  summary: string;
  fragments: MemoryFragment[];
  relatedClusters: string[];
  weight: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryFragment {
  id: string;
  text: string;
  userMsg: string;
  aiReply: string;
  timestamp: number;
}

interface MemoryGraphData {
  clusters: Record<string, MemoryCluster>;
  meta: {
    extractCount: number;
    lastExtractAt: number;
    version: number;
  };
}

// ─── Constants ───

const STORE_KEY = "memory-graph";
const MAX_CLUSTERS = 50;
const MAX_FRAGMENTS_PER_CLUSTER = 20;
const DEBOUNCE_MS = 3000;

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Helpers ───

/**
 * Smart truncation for AI replies: head(40%) + middle(20%) + tail(40%).
 * Splits by sentence/clause boundaries before cutting, then joins with "……".
 */
function smartTruncateAiReply(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text;

  const EL = "……";
  // Split into segments at sentence/clause boundaries (keeping the delimiter)
  const segs = text.match(/[^。！？.!?，,；;\n]+[。！？.!?，,；;\n]*/g) ?? [text];

  if (segs.length < 3 || maxLen < 20) {
    const keep = Math.floor((maxLen - EL.length) / 2);
    return text.slice(0, keep) + EL + text.slice(-keep);
  }

  const budget = maxLen - EL.length * 2;
  const hBudget = Math.floor(budget * 0.4);
  const tBudget = Math.floor(budget * 0.4);
  const mBudget = budget - hBudget - tBudget;

  let head = "", hi = 0;
  while (hi < segs.length && head.length + segs[hi].length <= hBudget) head += segs[hi++];

  let tail = "", ti = segs.length - 1;
  while (ti >= hi && tail.length + segs[ti].length <= tBudget) tail = segs[ti--] + tail;

  let mid = "";
  if (hi <= ti && mBudget > 0) {
    const midIdx = Math.floor((hi + ti) / 2);
    for (let mi = midIdx; mi <= ti && mid.length + segs[mi].length <= mBudget; mi++) {
      mid += segs[mi];
    }
  }

  return [head, mid, tail].filter(s => s.length > 0).join(EL);
}

// ─── System ───

export class MemoryGraphSystem {
  private _store: PersistenceStore;
  private _data: MemoryGraphData;
  private _busy = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingUserMsg: string | null = null;
  private _pendingAiReply: string | null = null;
  private _llmComplete: LLMCompleteCallback | null = null;
  private _onIndexClusters: ((clusters: MemoryCluster[]) => void) | null = null;

  constructor(store: PersistenceStore) {
    this._store = store;
    this._data = this._load();
  }

  /** Register the LLM completion callback (set by gateway) */
  setLLMComplete(callback: LLMCompleteCallback): void {
    this._llmComplete = callback;
  }

  /** Register the cluster indexing callback (called after extraction) */
  setIndexCallback(callback: (clusters: MemoryCluster[]) => void): void {
    this._onIndexClusters = callback;
  }

  /** Get current cluster array */
  getClusters(): MemoryCluster[] {
    return Object.values(this._data.clusters);
  }

  /** Get total fragment count */
  getFragmentCount(): number {
    return this.getClusters().reduce((sum, c) => sum + c.fragments.length, 0);
  }

  /** Get status info */
  getStatus() {
    return {
      clusterCount: this.getClusters().length,
      fragmentCount: this.getFragmentCount(),
      extractCount: this._data.meta.extractCount,
      lastExtractAt: this._data.meta.lastExtractAt,
    };
  }

  // ─── Extraction entry ───

  /**
   * Enqueue extraction with debounce (3s).
   * Called after each chat completion via character.memory.extract RPC.
   */
  enqueueExtraction(userMsg: string, aiReply: string): void {
    if ((!userMsg && !aiReply) || (userMsg + aiReply).length < 10) return;
    this._pendingUserMsg = userMsg;
    this._pendingAiReply = aiReply;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._doExtract(), DEBOUNCE_MS);
  }

  private async _doExtract(): Promise<void> {
    const userMsg = this._pendingUserMsg;
    const aiReply = this._pendingAiReply;
    this._pendingUserMsg = null;
    this._pendingAiReply = null;
    if ((!userMsg && !aiReply) || this._busy) return;
    await this.extractAndMerge(userMsg ?? "", aiReply ?? "");
  }

  // ─── LLM extraction ───

  async extractAndMerge(userMsg: string, aiReply: string): Promise<void> {
    if (this._busy || !this._llmComplete) return;
    this._busy = true;
    try {
      const themes = this.getClusters().map(c => c.theme).join("、");

      const prompt = `[角色]
你是记忆管理器。

[情景]
用户: ${userMsg}
AI回复: ${smartTruncateAiReply(aiReply, 500)}
已有记忆簇: ${themes || "（空）"}

[任务]
判断这段对话是否包含值得长期记住的用户信息（兴趣/习惯/项目/人际/偏好/情感/技能/工作）。
闲聊、打招呼、简单问答不值得记忆。
如果值得记忆，决定归入已有簇还是新建簇。

返回严格JSON（无代码块标记，无其他文字）：
{"worth":true,"cluster":"已有簇主题或null","newTheme":"新簇主题或null","keywords":["显式关键词1","显式关键词2"],"implicitKeywords":["同义词","上位概念","关联术语","用户可能用的其他说法"],"fragment":"这段对话的记忆摘要，一句话","summaryUpdate":"归入已有簇时更新后的簇摘要，新建时为初始摘要"}
keywords=对话中直接出现的词；implicitKeywords=未直接出现但语义相关的词（同义词、缩写、上位概念、口语说法），用于提升召回率。
不值得记忆时返回：{"worth":false}`;

      const result = await this._llmComplete(prompt);
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

      // Index clusters into memory search
      this._indexToMemorySearch();
    } catch {
      // Silent fail — memory extraction is non-critical
    } finally {
      this._busy = false;
    }
  }

  // ─── Merge logic ───

  private _merge(
    parsed: {
      cluster?: string;
      newTheme?: string;
      keywords?: string[];
      implicitKeywords?: string[];
      fragment?: string;
      summaryUpdate?: string;
    },
    userMsg: string,
    aiReply: string,
  ): void {
    const { cluster, newTheme, keywords = [], implicitKeywords = [], fragment, summaryUpdate } = parsed;
    const now = Date.now();

    const frag: MemoryFragment = {
      id: genId("f"),
      text: (fragment ?? "").slice(0, 120),
      userMsg: userMsg ?? "",
      aiReply: smartTruncateAiReply(aiReply ?? "", 300),
      timestamp: now,
    };

    if (cluster) {
      const existing = this._findClusterByTheme(cluster);
      if (existing) {
        existing.fragments.push(frag);
        if (existing.fragments.length > MAX_FRAGMENTS_PER_CLUSTER) {
          existing.fragments = existing.fragments.slice(-MAX_FRAGMENTS_PER_CLUSTER);
        }
        existing.weight++;
        existing.updatedAt = now;
        if (summaryUpdate) existing.summary = summaryUpdate.slice(0, 200);
        const kwSet = new Set(existing.keywords);
        for (const kw of keywords) kwSet.add(kw.toLowerCase());
        existing.keywords = [...kwSet].slice(0, 15);
        const ikwSet = new Set(existing.implicitKeywords);
        for (const kw of implicitKeywords) ikwSet.add(kw.toLowerCase());
        existing.implicitKeywords = [...ikwSet].slice(0, 20);
        return;
      }
      // Fall through to create new cluster
    }

    const id = genId("mc");
    const newCluster: MemoryCluster = {
      id,
      theme: (newTheme ?? cluster ?? fragment ?? "").slice(0, 30),
      keywords: keywords.map(k => k.toLowerCase()).slice(0, 10),
      implicitKeywords: implicitKeywords.map(k => k.toLowerCase()).slice(0, 15),
      summary: (summaryUpdate ?? fragment ?? "").slice(0, 200),
      fragments: [frag],
      relatedClusters: [],
      weight: 1,
      createdAt: now,
      updatedAt: now,
    };
    this._data.clusters[id] = newCluster;
    this._inferRelations(newCluster);
  }

  private _findClusterByTheme(theme: string): MemoryCluster | undefined {
    const lower = theme.toLowerCase().trim();
    // Normalize all cluster themes once to avoid repeated toLowerCase/trim per pass
    const norm = Object.values(this._data.clusters).map(c => ({ c, cl: c.theme.toLowerCase().trim() }));

    // 1. Exact match
    const exact = norm.find(({ cl }) => cl === lower);
    if (exact) return exact.c;

    // 2. Substring containment — shorter must be at least 2 chars to avoid false hits
    if (lower.length >= 2) {
      const contained = norm.find(({ cl }) =>
        cl.length >= 2 && (cl.includes(lower) || lower.includes(cl))
      );
      if (contained) return contained.c;
    }

    // 3. Character-set overlap ratio (good for Chinese, catches paraphrase)
    const newChars = new Set([...lower]);
    let bestCluster: MemoryCluster | undefined;
    let bestScore = 0;
    for (const { c, cl } of norm) {
      const clChars = new Set([...cl]);
      const intersection = [...newChars].filter(ch => clChars.has(ch)).length;
      const score = intersection / Math.max(newChars.size, clChars.size);
      if (score > bestScore) { bestScore = score; bestCluster = c; }
    }
    // Threshold 0.7: at least 70% character overlap
    return bestScore >= 0.7 ? bestCluster : undefined;
  }

  private _inferRelations(newCluster: MemoryCluster): void {
    const newKws = new Set(newCluster.keywords);
    for (const c of Object.values(this._data.clusters)) {
      if (c.id === newCluster.id) continue;
      const overlap = c.keywords.filter(k => newKws.has(k));
      if (overlap.length >= 1) {
        if (!newCluster.relatedClusters.includes(c.id)) {
          newCluster.relatedClusters.push(c.id);
        }
        if (!c.relatedClusters.includes(newCluster.id)) {
          c.relatedClusters.push(newCluster.id);
        }
      }
    }
  }

  // ─── Prune ───

  private _prune(): void {
    const clusters = Object.values(this._data.clusters);
    if (clusters.length <= MAX_CLUSTERS) return;

    clusters.sort((a, b) => a.weight - b.weight);
    const toRemove = clusters.slice(0, clusters.length - MAX_CLUSTERS);
    const removeIds = new Set(toRemove.map(c => c.id));

    for (const id of removeIds) {
      delete this._data.clusters[id];
    }

    for (const c of Object.values(this._data.clusters)) {
      c.relatedClusters = c.relatedClusters.filter(id => !removeIds.has(id));
    }
  }

  // ─── Index to memory search ───

  private _indexToMemorySearch(): void {
    if (!this._onIndexClusters) return;
    const clusters = this.getClusters();
    if (clusters.length === 0) return;
    try {
      this._onIndexClusters(clusters);
    } catch {
      // Silent fail — indexing is best-effort
    }
  }

  // ─── Persistence ───

  private _load(): MemoryGraphData {
    try {
      const saved = this._store.load(STORE_KEY) as MemoryGraphData | null;
      if (saved?.clusters && saved?.meta) return saved;
    } catch { /* ignore */ }
    return { clusters: {}, meta: { extractCount: 0, lastExtractAt: 0, version: 2 } };
  }

  private _save(): void {
    this._store.save(STORE_KEY, this._data as unknown as Record<string, unknown>);
  }
}
