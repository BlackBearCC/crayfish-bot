# PetClaw 开发踩坑与经验积累

记录开发过程中发现的架构行为、陷阱和反直觉设计，供后续开发参考。
claude需自己维护更新此文档

---

## 1. Smart Queue — 并行子代理的"合并回复"问题

### 现象

用户连发两条消息（A → B），主代理正在处理 A，smart queue 把 B 分类为 `parallel` 并派子代理处理。**用户最终只收到一条合并回复**，而不是两条独立回复。

### 原因

`parallel` 路由使用 `spawnSubagentDirect` / `callGateway({method:"agent"})` 创建子代理。子代理完成后走 **announce 机制**把结果推回主代理（`announce:v1:...` runId），主代理收到通知后合并 A 和 B 的上下文，给出一条综合回复。

### 解决方案：MiniAgent（已实现）

**设计文档**：`docs/mini-agent-design.md`

用 **MiniAgent** 替代子代理：
- 无 session 生命周期，一次调用
- 直接回复用户（`routeReply`），不经 announce
- 会话镜像：写回主 session JSONL，让主代理后续能看到
- 不阻塞后续消息（不注册到 embeddedPiRuns）

**文件**：
- `src/agents/mini-agent.ts` — MiniAgent 核心实现
- `src/auto-reply/reply/smart-queue-router.ts` — `sendDirectReply()` 替代 `spawnParallelSubagent()`

---

## 2. Announce Run — 不是用户对话的主代理

### 背景

`isEmbeddedPiRunActive("agent:main:main")` 在 announce run 期间也会返回 `true`，因为 announce run 使用主 session key 触发。

### Announce Run 的本质

- 框架内部投递子代理结果的 agent run
- `idempotencyKey = "announce:v1:{childSessionKey}:{childRunId}"`
- 因此 `runId = "announce:v1:..."` 开头
- `sessionKey = "agent:main:main"`（与真实主代理相同）

### 识别方式

```javascript
const isAnnounceRun = typeof event.runId === 'string' && event.runId.startsWith('announce:');
const isRealMainAgent = isMainSession && !isAnnounceRun;
```

### 影响

如果不过滤 announce run：
- 主代理空闲时 UI 仍显示"思考中"（announce run 结束后 `_agentRunning` 被错误清零）
- 用户看到假的"任务完成"庆祝动画
- 工具完成后"思考中"状态消失（因为 `_agentRunning` 已被 announce end 清为 false）

**文件**：`apps/desktop-pet/src/app.js` lifecycle 事件处理器

---

## 3. Lifecycle 事件 phase 名称

### 实际值（`pi-embedded-subscribe.handlers.lifecycle.ts`）

| phase | 含义 |
|-------|------|
| `"start"` | agent run 开始 |
| `"end"` | agent run 正常结束 |
| `"error"` | agent run 出错结束 |

### 不存在的值（易犯错）

- ~~`"thinking"`~~ — 不存在
- ~~`"running"`~~ — 不存在
- ~~`"complete"`~~ — 不存在

---

## 4. Smart Queue Pipeline Counter 问题

### 场景

Telegram 消息到 LLM 启动有 10–16s 延迟，期间 `isEmbeddedPiRunActive=false`。快速连发的第二条消息检测不到主代理忙碌，进入 `run-now` 路径而非 `enqueue-followup`，导致并行触发两个主代理 run。

### 修复

`src/auto-reply/reply/get-reply-run.ts` 新增 `sessionPipelineCount: Map<string, number>`，在 `runPreparedReply` 入口 increment，`try/finally` 保证 decrement。

**关键点**：必须用 `return await runReplyAgent(...)` 而非 `return runReplyAgent(...)`，否则 `finally` 在 agent 完成前就触发。

---

## 5. 子代理 announce 阻塞新消息（~77s）

### 场景

主代理完成任务后，announce run 在主 session（`agent:main:main`）执行，期间 `isEmbeddedPiRunActive` 仍为 true。用户此时发来的新消息被 smart queue 拦截排队，等待约 77s。

### 根本原因

`announce run` 用 `sessionKey: "agent:main:main"` 注册为 active embedded Pi run，这和普通主代理 run 完全无法区分（通过 sessionKey）。

### 识别方式

同 §2，通过 `runId.startsWith('announce:')` 识别。

---

## 6. PETCLAW_PROMPT_DEBUG 调试模式

### 启用

```bash
pnpm start:debug    # electron . --prompt-debug
pnpm dev:debug      # electron . --prompt-debug --dev
```

### 注意事项

- `pnpm start`（无 `--prompt-debug`）**不写入** `~/.petclaw/logs/prompt-debug.jsonl`
- prompt-debug.jsonl 记录的是 **LLM 调用前** 的 payload，不含 LLM 回复
- 子代理的 prompt 也会写入，sessionKey 会带 `subagent` 标识
- 看 LLM 实际回复需要查 `~/.petclaw/logs/2026-XX-XX.log` 里的 `agent-event` 条目

---

## 7. ELECTRON_RUN_AS_NODE 自愈机制

Claude Code 环境设置 `ELECTRON_RUN_AS_NODE=1` 导致 electron 以纯 Node 模式运行。`main.js` 顶部检测到后，用干净环境 `spawn` 重新启动 electron，第一个进程立即退出（exit code 0）。

**误判**：看到 `pnpm start` 背景任务"exit code 0 completed"不代表应用崩溃，是正常的自愈行为。真正的 electron 进程继续在后台运行。
