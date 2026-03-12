# MiniAgent 设计文档

## 背景问题

当前 Smart Queue 的 `parallel` 路由存在设计问题：

```
用户连发 A、B 两条消息
  ↓
主代理正在处理 A
  ↓
smart queue 将 B 分类为 parallel
  ↓
spawnParallelSubagent() 创建子代理处理 B
  ↓
子代理完成后通过 announce 机制推回主代理
  ↓
主代理合并 A + B 的上下文，给出一条综合回复
  ↓
用户收到 1 条回复（期望 2 条独立回复）
```

**用户期望**：并行消息应该**直接回复用户**，不经主代理合并。

## 设计原则

1. **局部改动** — 只改 smart-queue-router，不影响系统其他配置
2. **复用现有能力** — LLM 配置、上下文构建、routeReply 都复用现有代码
3. **独立回复** — 直接调用 routeReply 发送，不经主代理

## 方案

在 `smart-queue-router.ts` 内部新增 `sendDirectReply()` 函数，替代 `spawnParallelSubagent()`：

```
parallel 路由
    │
    ▼
buildParallelContextSnapshot()   ← 已有
    │
    ▼
sendDirectReply()                 ← 新增
    │
    ├─ 构建简单 prompt (user 消息 + 上下文快照)
    │
    ├─ 调用 classifierLLMComplete() 或类似轻量调用
    │
    └─ routeReply() 直接发用户    ← 已有
    │
    ▼
用户收到独立回复
（主代理不知道这条消息）
```

---

## 通用化：MiniAgent

上述 `sendDirectReply()` 依赖的核心能力是**轻量 Agent 调用**，这个能力可复用到多个场景：

### 与主代理的区别

| | 主代理 (Full Agent) | MiniAgent |
|---|---|---|
| **Session** | 完整 session 生命周期 | 无 session，一次调用 |
| **Announce** | 子代理结果会 announce 回主代理 | 直接输出，无 announce |
| **工具** | 全量工具集 | 可配置轻量工具子集 |
| **上下文** | Bootstrap + 历史对话 | 按需注入快照 |
| **状态** | 持久化到 session | 无状态 |

### 关键设计：会话镜像

MiniAgent 执行时无 session，但**完成后需要将对话写回主 session**，让主代理后续能看到：

```
用户发消息 B（parallel）
    │
    ▼
MiniAgent.run() 处理 B
    │
    ├─ 直接回复用户（routeReply）
    │
    └─ 写入主 session JSONL          ← 新增
       ├─ { type: "message", role: "user", content: "B" }
       └─ { type: "message", role: "assistant", content: "回复内容" }
    │
    ▼
主代理下次运行时能看到 B 的对话
```

**为什么需要镜像？**
- 主代理需要知道 MiniAgent 回复了什么
- 保持对话历史的连续性
- 避免主代理重复回答同一问题

**写入时机**：MiniAgent 完成后立即写入，不等待主代理

**写入格式**：标准的 session JSONL 格式，与主代理写入一致

### 无 Session 的风险与处理

MiniAgent 不创建 session，但需要处理以下问题：

| 风险 | 说明 | 解决方案 |
|------|------|----------|
| **无法追踪** | `isEmbeddedPiRunActive` 检测不到 | 不注册到 embeddedPiRuns，不阻塞后续消息 |
| **事件关联** | `emitAgentEvent` 需要 runId | 生成临时 runId: `mini-agent:{uuid}` |
| **工具依赖** | 某些工具需要 sessionKey | 显式传入主 session 的 sessionKey |

**实现要点**：

```typescript
const miniRunId = `mini-agent:${crypto.randomUUID()}`;

// 注册到 runContextById（用于事件关联）
registerAgentRunContext(miniRunId, {
  sessionKey: params.mirrorToSession?.sessionKey,
});

// 但不注册到 embeddedPiRuns
// 这样后续消息不会被错误地认为"主代理忙"

// 完成后清理
clearAgentRunContext(miniRunId);
```

**为什么不阻塞后续消息？**

MiniAgent 的设计目标是快速响应，不应该让用户等待。如果 MiniAgent 执行期间用户又发了消息：
- 新消息会走正常的 smart queue 流程
- 主代理如果空闲，直接处理新消息
- 不会因为 MiniAgent 在运行而排队

这与子代理不同 —— 子代理会 announce 回主代理，导致主代理"看起来"在忙。

### 核心接口

```
MiniAgent.run(params)
├── params.systemPrompt?: string        ← 可选 system prompt
├── params.userPrompt: string           ← 必需 user prompt
├── params.tools?: AgentTool[]          ← 可选工具列表
├── params.maxTokens?: number           ← 默认 1024
├── params.temperature?: number         ← 默认 0.7
├── params.stream?: boolean             ← 默认 false
├── params.onChunk?: (chunk) => void    ← streaming 回调
├── params.contextSnapshot?: string     ← 角色状态/记忆等上下文
└── params.mirrorToSession?: {          ← 会话镜像配置
    sessionFile: string;                ← 主 session JSONL 路径
    sessionKey?: string;                ← 用于 event 注入
  }
```

### 复用场景

| 场景 | 工具 | 输出 |
|------|------|------|
| **parallel 直接回复** | `memory_search` | 自然语言回复 |
| **记忆提取** | 无 | JSON 结构化记忆 |
| **情绪评估** | 无 | intent + delta |
| **每日任务生成** | 无 | JSON 任务列表 |
| **Soul Agent 说话** | `memory_search` | 自然语言或 `HEARTBEAT_OK` |
| **World Agent 事件** | `memory_search` | JSON 事件或 `HEARTBEAT_OK` |

### 特色：轻量工具调用

MiniAgent 可配置工具子集，例如 `parallel 直接回复` 场景：

```typescript
// 仅允许 memory_search，让回复更有上下文感
const result = await MiniAgent.run({
  userPrompt: followupRun.prompt,
  contextSnapshot: await buildParallelContextSnapshot({...}),
  tools: [createMemorySearchTool()],
  maxTokens: 2048,
});
```

工具调用流程：
1. MiniAgent 收到 LLM tool_call
2. 执行工具，获取结果
3. 将结果注入下一轮 LLM 调用
4. 返回最终文本

**限制**：
- 最多 2 轮工具调用（防止无限循环）
- 不支持 `bash` 等危险工具
- 工具执行同步完成，不写 session

### 文件位置

`src/agents/mini-agent.ts`

```typescript
export interface MiniAgentParams {
  systemPrompt?: string;
  userPrompt: string;
  tools?: AnyAgentTool[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  contextSnapshot?: string;
}

export interface MiniAgentResult {
  ok: boolean;
  text?: string;
  error?: string;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
}

export async function runMiniAgent(params: MiniAgentParams): Promise<MiniAgentResult>
```

### 改造现有代码

```typescript
// character.ts
export async function characterLLMComplete(prompt: string): Promise<string | null> {
  const result = await runMiniAgent({ userPrompt: prompt, maxTokens: 512 });
  return result.text ?? null;
}

export async function classifierLLMComplete(prompt: string): Promise<string | null> {
  const result = await runMiniAgent({ userPrompt: prompt, maxTokens: 128, temperature: 0.1 });
  return result.text ?? null;
}
```

---

**设计者**: Claude
**日期**: 2026-03-12
**状态**: 待用户确认后实现