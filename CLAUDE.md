# Pet-Claw — CLAUDE.md

Fork of [OpenClaw](https://github.com/openclaw/openclaw), extended with a Character Engine for AI character/companion features.

## Project Structure

```
petclaw/
├── src/                          # OpenClaw core (TypeScript)
│   ├── character/                # 🆕 Character Engine — AI character state engine
│   │   ├── character-engine.ts   # Main entry, composes all subsystems
│   │   ├── attribute-engine.ts   # Generic attributes (mood/hunger/health/custom)
│   │   ├── growth-system.ts      # Growth stages (intimacy/evolution)
│   │   ├── persona-engine.ts     # LLM persona management + prompt builder
│   │   ├── skill-system.ts       # Domain tracking, epiphany, attribute XP
│   │   ├── learning-system.ts    # Course timer, XP, fragments, levels
│   │   ├── achievement-system.ts # 12 achievement badges
│   │   ├── domain-system.ts      # 7 life domains + 5 attributes + weight matrix
│   │   ├── event-bus.ts          # Typed pub/sub event system
│   │   ├── presets.ts            # Default configs (mood/hunger/health/intimacy)
│   │   └── index.ts              # Public API exports
│   ├── gateway/                  # Gateway HTTP/WS server
│   │   └── server-methods/character.ts # character.* RPC methods
│   ├── auto-reply/               # LLM calling + reply processing
│   ├── sessions/                 # Session management
│   └── ...                       # Other OpenClaw modules
├── apps/
│   ├── desktop-pet/              # 🆕 Electron desktop character client
│   │   ├── electron/             # Main process (IPC, window, llm-service)
│   │   ├── src/                  # Renderer (canvas, UI, interactions)
│   │   ├── assets/               # Spritesheets
│   │   └── scripts/              # Asset generation
│   ├── android/
│   ├── ios/
│   └── macos/
├── extensions/                   # Channel extensions (Discord, Slack, etc.)
├── skills/                       # Built-in skills
└── pnpm-workspace.yaml
```

## Commands

```bash
pnpm install                      # Install all workspace dependencies
pnpm build                        # Build OpenClaw + character engine
pnpm gateway:watch                # Dev mode with auto-reload

# Desktop character (from apps/desktop-pet/)
cd apps/desktop-pet
pnpm install
pnpm start                        # Launch Electron app
pnpm dev                          # Dev mode with DevTools
pnpm run generate-placeholder     # Regenerate placeholder sprites
```

## Upstream Sync

```bash
git fetch upstream
git merge upstream/main            # Merge latest OpenClaw changes
```

- `origin` → https://github.com/BlackBearCC/PetClaw.git
- `upstream` → https://github.com/openclaw/openclaw.git

## Character Engine Architecture

### Core Concept

The Character Engine (`src/character/`) provides a generic AI character state engine that runs inside the Gateway process. Clients (desktop-pet, web, mobile) connect via WebSocket and call `character.*` RPC methods.

### Gateway RPC Methods

| Category | Methods |
|----------|---------|
| State | `character.state.get`, `character.interact`, `character.growth.info`, `character.config.get` |
| Persona | `character.persona.get`, `character.persona.set` |
| Skills | `character.skill.record`, `character.skill.tool`, `character.skill.attributes`, `character.skill.tools`, `character.skill.realized`, `character.skill.addRealized` |
| Learning | `character.learn.courses`, `character.learn.add`, `character.learn.start`, `character.learn.abort`, `character.learn.active`, `character.learn.progress`, `character.learn.history` |
| Achievements | `character.achievement.list`, `character.achievement.check` |
| Care | `character.care.feed`, `character.care.play`, `character.care.rest`, `character.care.heal`, `character.care.status` |
| Shop | `character.shop.catalog`, `character.shop.buy`, `character.shop.wallet` |
| Daily | `character.daily.tasks`, `character.daily.claim` |
| Memory | `character.memory.extract`, `character.memory.search`, `character.memory.clusters` |

### Data Flow

```
Client (Electron/Web/Mobile)
  ──WS──→ Gateway (port 18789)
            ├── character.* handlers → CharacterEngine (in-memory, file-persisted)
            ├── chat.* handlers → LLM API (streaming)
            └── agent.* handlers → Tool execution
```

### Persistence

Character state is stored as JSON files in `~/.petclaw/store/character/`:
- `mood.json`, `hunger.json`, `health.json` — attribute states
- `intimacy.json` — growth points
- `skill-system.json` — domain data, tools, realized skills
- `learning-system.json` — courses, progress, history
- `achievement-system.json` — unlock records

## Desktop Character Client (`apps/desktop-pet/`)

Electron app, frameless transparent window, always-on-top. See `apps/desktop-pet/CLAUDE.md` for detailed architecture.

Key conventions:
- **No bundler**: Plain ES module imports in renderer
- **IPC only**: Renderer uses `window.electronAPI`, never Node.js directly
- **Canvas rendering**: Character animation via `requestAnimationFrame` in CharacterRenderer
- **Streaming chat**: `electronAPI.chatSend()` + `onChatStream()` for AI conversation
- **Server-authoritative state**: Client has no local state systems — all character state (mood/hunger/health/growth) lives in the server-side Character Engine, accessed via `CharacterStateSync` → generic `characterRPC`

### Client–Server State Architecture

```
Renderer (CharacterStateSync)
  │  characterRPC('character.state.get')        ← 10s polling
  │  characterRPC('character.interact', {...})  ← click/feed/chat/quiz/...
  │  characterRPC('character.skill.record')     ← domain activity
  ▼
Preload (single IPC channel)
  │  characterRPC: (method, params) => ipcRenderer.invoke('character-rpc', method, params)
  ▼
Main → llm-service.characterRPC()
  │  _ensureConnected() + _sendRequest(method, params)
  ▼
Gateway (character.* RPC handlers) → CharacterEngine (in-memory, file-persisted)
```

- **No local MoodSystem/HungerSystem/HealthSystem/IntimacySystem** — removed entirely
- All state reads go through `charSync.getMood()`, `charSync.getGrowthStage()`, etc.
- All mutations go through `charSync.interact(action, rewards)` → server RPC
- UI reactions (bubbles, animations) triggered by `charSync.onAttributeChange()` / `onGrowthStageUp()` callbacks

## AI Integration (P0 — Done)

角色状态驱动 LLM 语气，每次对话自动注入当前挡位片段：

### 挡位系统
| 属性 | 低挡阈值 | 高挡阈值 | 注入时机 |
|------|---------|---------|---------|
| mood | < 30 | > 70 | 非正常挡才注入 |
| hunger | < 60 | > 200 | 非正常挡才注入 |
| health | < 40 | — | 低挡才注入 |
| level | 始终注入 | — | baby/growing/mature/veteran |
| intimacy | 始终注入 | — | stranger/familiar/close/bonded |

### 实现机制
- **`CharacterEngine.getPromptContext()`** — 计算当前挡位，拼接片段字符串（`src/character/character-engine.ts:270`）
- **`agent:bootstrap` 内部 Hook** — 在 `src/gateway/server-methods/character.ts` 的 `getEngine()` 首次调用时注册，将 `CHARACTER_STATE.md` 注入到 bootstrapFiles 数组（SOUL.md 之后）
- **`getCharacterChatGate()`** — 导出函数，供 `chat.send` 调用；engine 未初始化时返回 null（安全降级）
- **Character Chat Gate 在 `chat.ts`** — dedupe 检查之后、try 块之前：调用 `canChat()`（饥饿门控）+ `onMessage()`（消息计数）

### 记忆图谱 — 全服务端架构 (Done)

服务端 `MemoryGraphSystem`（`src/character/memory-graph.ts`）负责记忆的完整生命周期：LLM 提取 → 簇合并/剪枝 → SQLite FTS 索引。客户端零逻辑，仅在对话完成后调用 `characterRPC('character.memory.extract', {userMsg, aiReply})` 传递原始数据。

- **数据流**: 对话完成 → `character.memory.extract` RPC → `MemoryGraphSystem.enqueueExtraction()` → LLM 提取 → `indexClusters()` → SQLite FTS
- **LLM 调用**: 服务端 `characterLLMComplete()` 直接调用 OpenAI-compatible API（读取 OpenClaw config 的 model provider）
- **簇持久化**: `~/.petclaw/store/character/memory-graph.json`（PersistenceStore，与其他 character state 一致）
- **隐性关键词**: LLM 提取时生成 `implicitKeywords`（同义词/上位概念），写入 FTS 索引提升召回率
- **面板**: `MemoryGraphPanel` 通过 `characterRPC('character.memory.clusters')` 读取服务端数据

### ChatEvalSystem — 对话意图评估 (Done)

每 5 条用户消息 + 间隔 ≥5min 触发一次 LLM 意图分类（`chat-eval-system.ts`）：
- **意图标签**: praise / deep_talk / playful / gratitude / cold / impatient / angry / sad_share / neutral
- **效果**: mood/intimacy delta + streak 连击倍率（最高 3×）+ LevelSystem +5 EXP
- **饥饿门控**: hunger ≤30 时 `canChat()` 返回 false，`chat.ts` 拒绝对话
- **AI 回复上下文**: `message:sent` hook 调用 `onAssistantMessage()` 补全双边对话记录
- **客户端反应**: 服务端 `chat:eval` bus → `_broadcast("character", { kind: "chat-eval", intent, ... })` → `app.js._handleChatEval()` → 正向 intent 播放 happy 动画 + 随机气泡，负向只播 sad 动画

### P1 待实现
- 气泡型主动对话（客户端固定文案触发）

## Upstream Sync

```bash
git fetch upstream
git merge upstream/main            # 正常合并（已建立 git 关系，v2026.3.8 后）
```

- `origin` → https://github.com/BlackBearCC/PetClaw.git
- `upstream` → https://github.com/openclaw/openclaw.git

> **注意**: 本项目最初是代码复制（非 git fork），v2026.3.8 同步时通过 cherry-pick 策略建立了正式 git 关系。
> 后续直接 `git fetch upstream && git merge upstream/main` 即可。

### v2026.3.8 上游新特性（已合并）
- `BootstrapContextMode("full"/"lightweight")` + `BootstrapContextRunKind` — heartbeat/cron 按需减少 context 注入
- `getOrLoadBootstrapFiles` — bootstrap 文件缓存，避免重复读盘
- `TypingPolicy` 类型 — 更细粒度的打字指示器控制
- `bootstrapContextMode` / `suppressTyping` / `isReasoning` 字段到 `GetReplyOptions` / `ReplyPayload`

## Key Conventions

- Character engine is TypeScript (`src/character/`), desktop client is plain JS (`apps/desktop-pet/`)
- All character state logic lives in the engine, clients are thin renderers
- One generic `characterRPC(method, params)` covers all `character.*` methods — no specialized IPC per method
- Keep upstream OpenClaw modules untouched when possible for easy sync
- New character features go in `src/character/` + `src/gateway/server-methods/character.ts`
- AI 集成（角色状态 → LLM 语气）通过 `agent:bootstrap` hook 无侵入注入，不改 OpenClaw 核心
- **Git 提交不加 Co-Authored-By** — 提交消息中不要附加 `Co-Authored-By: Claude ...` 签名行
