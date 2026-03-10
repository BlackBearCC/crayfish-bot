# 智能并行队列设计文档

## 问题

当主 Agent 正在执行长任务（工具调用、代码执行等）时，用户发来的新消息会进入 followup 串行队列，必须等主 Agent 完成后才能逐条处理。用户体验差——发了消息没人回。

## 目标

在主 Agent 忙碌时，用 LLM 对新消息做快速分类：
- **steer**（与当前任务相关）→ 走现有 `queueEmbeddedPiMessage` steer 机制，注入到正在运行的 Agent 输入流
- **parallel**（独立新话题/闲聊/新任务）→ 启动子代理并行处理，立即回复用户

子代理必须拥有：完整 Agent 管线能力（工具、技能、hooks）+ 对话上下文（记忆摘要 + 最近 5 轮真实聊天记录）。

## 现有机制分析

### 消息流入路径（`agent-runner.ts:197-222`）

```
用户消息到达
  ↓
shouldSteer && isStreaming?
  ├─ YES → queueEmbeddedPiMessage() → 注入当前运行中的 Agent（steer）
  └─ NO  → resolveActiveRunQueueAction()
              ├─ "run-now"          → 正常启动新 run
              ├─ "drop"             → 丢弃（heartbeat）
              └─ "enqueue-followup" → enqueueFollowupRun() ← 改造点
```

### 关键约束

| 约束 | 说明 |
|------|------|
| Session 写锁 | `acquireSessionWriteLock()` 用 `fs.open(path, "wx")`，同一 sessionFile 无法并发两个 `runEmbeddedPiAgent` |
| Steer 已存在 | `queueEmbeddedPiMessage` 已实现消息注入正在运行的 Agent，无需重复实现 |
| 子代理独立 session | `spawnSubagentDirect` / `callGateway({method:"agent"})` 创建独立 session，天然支持并行（`CommandLane.Subagent` maxConcurrent=8）|
| Memory Graph | 已有聊天记忆摘要（最多 50 个 cluster，按 weight 排序），可直接读取 |

### 可复用的基础设施

| 组件 | 位置 | 用途 |
|------|------|------|
| `callGateway` | `src/gateway/call.ts` | 发起 gateway RPC 调用 |
| `AGENT_LANE_SUBAGENT` | `src/agents/lanes.ts` | 子代理 lane（`"subagent"`） |
| `MemoryGraphSystem.getClusters()` | `src/character/memory-graph.ts` | 获取记忆簇（theme/summary/fragments/weight）|
| `CharacterEngine.getPromptContext()` | `src/character/character-engine.ts` | 获取角色状态片段（mood/hunger/level/intimacy）|
| `characterLLMComplete()` | `src/gateway/server-methods/character.ts` | 轻量 LLM 直接调用（分类器用）|
| Session JSONL | `~/.openclaw/agents/{id}/sessions/*.jsonl` | 存储真实聊天记录，可只读解析 |

## 架构设计

### 整体流程

```
用户消息到达 & 主 Agent 正在运行（isActive=true）
  ↓
resolveActiveRunQueueAction() === "enqueue-followup"
  ↓
┌─────────────────────────────────────────┐
│  Smart Queue Router（新增）              │
│                                          │
│  1. LLM 分类器：steer / parallel         │
│     - 输入：用户新消息 + 最近 1 轮上下文  │
│     - 输出：JSON { "route": "steer" }    │
│            或 { "route": "parallel" }    │
│                                          │
│  2. 路由：                               │
│     steer → enqueueFollowupRun()        │
│            （保持原有串行队列行为）        │
│     parallel → 构建上下文 → 启动子代理   │
└─────────────────────────────────────────┘
```

### 子代理上下文构建

子代理需要对话上下文避免"断片"，通过 `extraSystemPrompt` 注入：

```
┌────────────────────────────────────────────┐
│ extraSystemPrompt 组成：                    │
│                                             │
│ 1. 角色状态（getPromptContext()）            │
│    → mood/hunger/health/level/intimacy      │
│    → ~40-100 tokens                         │
│                                             │
│ 2. 记忆摘要（getMemorySummary(1)）          │
│    → top-1 权重最高的 memory cluster         │
│    → theme + summary + 最新 fragment         │
│    → ~50-100 tokens                         │
│                                             │
│ 3. 最近 5 轮聊天记录                         │
│    → 从 sessionFile JSONL 只读解析           │
│    → user/assistant 交替的真实消息           │
│    → ~500-1500 tokens                       │
│                                             │
│ 总计：~600-1700 tokens（可控）               │
└────────────────────────────────────────────┘
```

### 子代理启动方式

通过 `callGateway({ method: "agent" })` 启动，与 `spawnSubagentDirect` 一致：

```typescript
callGateway<{ runId: string }>({
  method: "agent",
  params: {
    message: userPrompt,
    sessionKey: undefined,              // 自动生成独立 session
    channel: followupRun.originatingChannel,
    to: followupRun.originatingTo,
    accountId: followupRun.originatingAccountId,
    threadId: followupRun.originatingThreadId,
    idempotencyKey: crypto.randomUUID(),
    deliver: true,                      // 直接投递回复到用户
    lane: AGENT_LANE_SUBAGENT,          // 子代理 lane
    extraSystemPrompt: contextSnapshot, // 上下文快照
    label: "parallel-queue",
    spawnedBy: followupRun.run.sessionKey,
  },
  timeoutMs: 10_000,
});
```

### 回复投递

| 渠道类型 | 投递方式 |
|----------|----------|
| 外部渠道（Telegram/Discord/Slack） | `deliver: true` → gateway agent handler 自动投递 |
| 内部渠道（desktop-pet webchat） | `deliver: true` 在内部渠道会被 gateway 强制 `false`。需 fallback：用 `opts.onBlockReply` 回调 |

对于内部渠道 fallback：子代理完成后通过 gateway `agent` handler 的 response 拿到结果，或监听 agent 完成事件，再调用 `onBlockReply` 投递。

**备选方案**：如果 `deliver: true` 在内部渠道不生效，可以改用 `followupRunner` 模式——构建一个独立 sessionFile 的 `FollowupRun`，用 `createFollowupRunner` 处理。这样回复投递走 `sendFollowupPayloads` 已有路径（支持 `onBlockReply` 和 `routeReply`）。

## 新增文件

### 1. `src/character/character-engine.ts` — 新增 `getMemorySummary(topN)`

```typescript
getMemorySummary(topN = 1): string {
  const clusters = this.memoryGraph.getClusters();
  if (clusters.length === 0) return "";
  const sorted = [...clusters].sort((a, b) => b.weight - a.weight).slice(0, topN);
  const lines: string[] = [];
  for (const c of sorted) {
    const recentFrag = c.fragments.length > 0
      ? c.fragments[c.fragments.length - 1].text : "";
    lines.push(`[${c.theme}] ${c.summary}${recentFrag ? ` — 最近: "${recentFrag}"` : ""}`);
  }
  return lines.join("\n");
}
```

### 2. `src/auto-reply/reply/parallel-context.ts` — 上下文快照构建器

职责：
- `readRecentSessionMessages(sessionFile, turns=5)` — 只读解析 session JSONL，提取最近 N 轮 user/assistant 真实消息
- `buildParallelContextSnapshot(params)` — 组装完整上下文字符串（角色状态 + 记忆摘要 + 聊天记录）

Session JSONL 格式（每行一个 JSON）：
```jsonl
{"type":"message","id":"...","message":{"role":"user","content":[{"type":"text","text":"用户消息"}]}}
{"type":"message","id":"...","message":{"role":"assistant","content":[{"type":"text","text":"AI回复"}]}}
```

读取策略：逐行解析，收集 `type === "message"` 且 `role` 为 `user`/`assistant` 的条目，取最后 `turns * 2` 条。只读操作，不需要写锁。

### 3. `src/auto-reply/reply/smart-queue-router.ts` — 智能路由器

职责：
- `classifyMessage(params)` — 调用 LLM 判断 steer/parallel
- `routeToParallelSubagent(params)` — 构建上下文 + 启动子代理
- `smartRouteOrEnqueue(params)` — 主入口，串联分类 + 路由

LLM 分类器 prompt 设计：
```
你是消息分类器。判断用户新消息是否与当前正在执行的任务相关。

当前任务上下文（最近一轮对话）：
用户: {lastUserMsg}
助手: {lastAssistantMsg}（正在执行中...）

用户新消息: {newMessage}

如果新消息是对当前任务的补充、修正、催促或追问，返回 {"route":"steer"}
如果新消息是独立的新话题、闲聊、或新任务，返回 {"route":"parallel"}

只返回 JSON，不要解释。
```

分类器调用：使用 `characterLLMComplete()`（已有的轻量 LLM 调用），无需额外配置。

### 4. `src/auto-reply/reply/agent-runner.ts` — 修改 `enqueue-followup` 分支

改造点（第 218-222 行）：

```typescript
// Before:
if (activeRunQueueAction === "enqueue-followup") {
  enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
  await touchActiveSessionEntry();
  typing.cleanup();
  return undefined;
}

// After:
if (activeRunQueueAction === "enqueue-followup") {
  const routed = await smartRouteOrEnqueue({
    queueKey, followupRun, resolvedQueue, opts,
  });
  await touchActiveSessionEntry();
  typing.cleanup();
  if (routed === "steer-enqueued") {
    // 走原有 followup 串行队列
  }
  if (routed === "parallel-spawned") {
    // 子代理已启动，异步执行
  }
  return undefined;
}
```

## 降级策略

| 场景 | 降级行为 |
|------|----------|
| LLM 分类器调用失败/超时 | 默认走 `enqueueFollowupRun`（原有行为）|
| Character Engine 未初始化 | 跳过记忆摘要和角色状态，只用聊天记录 |
| Session 文件读取失败 | 跳过聊天记录，只用记忆摘要 |
| 子代理启动失败 | fallback 到 `enqueueFollowupRun` |
| 内部渠道 deliver 无效 | 用备选方案（followupRunner 模式或 onBlockReply 回调）|

## Token 开销估算

| 组件 | 估算 |
|------|------|
| 分类器（每条消息触发一次） | ~200 input + ~20 output ≈ 220 tokens |
| 子代理 extraSystemPrompt | ~800-2000 tokens（一次性注入）|
| 子代理本身的运行 | 与正常 agent run 相同 |

分类器调用极轻量，延迟约 0.5-1s，用户几乎无感。

## 不改动的部分

- 主 Agent 的记忆注入机制（`agent:bootstrap` hook）
- 现有 steer 机制（`queueEmbeddedPiMessage`）
- 现有 followup 串行队列逻辑（作为 fallback 保留）
- Memory Graph 的提取/合并/剪枝逻辑
