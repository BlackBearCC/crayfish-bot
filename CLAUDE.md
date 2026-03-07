# Crayfish Bot — CLAUDE.md

Fork of [OpenClaw](https://github.com/openclaw/openclaw), extended with a Pet Engine for AI character/companion features.

## Project Structure

```
crayfish-bot/
├── src/                          # OpenClaw core (TypeScript)
│   ├── pet/                      # 🆕 Pet Engine — AI character state engine
│   │   ├── pet-engine.ts         # Main entry, composes all subsystems
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
│   │   └── server-methods/pet.ts # 21 pet.* RPC methods
│   ├── auto-reply/               # LLM calling + reply processing
│   ├── sessions/                 # Session management
│   └── ...                       # Other OpenClaw modules
├── apps/
│   ├── desktop-pet/              # 🆕 Electron desktop pet client
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
pnpm build                        # Build OpenClaw + pet engine
pnpm gateway:watch                # Dev mode with auto-reload

# Desktop pet (from apps/desktop-pet/)
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

- `origin` → https://github.com/BlackBearCC/crayfish-bot.git
- `upstream` → https://github.com/openclaw/openclaw.git

## Pet Engine Architecture

### Core Concept

The Pet Engine (`src/pet/`) provides a generic AI character state engine that runs inside the Gateway process. Clients (desktop-pet, web, mobile) connect via WebSocket and call `pet.*` RPC methods.

### Gateway RPC Methods (21 total)

| Category | Methods |
|----------|---------|
| State | `pet.state.get`, `pet.interact`, `pet.growth.info`, `pet.config.get` |
| Persona | `pet.persona.get`, `pet.persona.set` |
| Skills | `pet.skill.record`, `pet.skill.tool`, `pet.skill.attributes`, `pet.skill.tools`, `pet.skill.realized`, `pet.skill.addRealized` |
| Learning | `pet.learn.courses`, `pet.learn.add`, `pet.learn.start`, `pet.learn.abort`, `pet.learn.active`, `pet.learn.progress`, `pet.learn.history` |
| Achievements | `pet.achievement.list`, `pet.achievement.check` |

### Data Flow

```
Client (Electron/Web/Mobile)
  ──WS──→ Gateway (port 18789)
            ├── pet.* handlers → PetEngine (in-memory, file-persisted)
            ├── chat.* handlers → LLM API (streaming)
            └── agent.* handlers → Tool execution
```

### Persistence

Pet state is stored as JSON files in `~/.openclaw/store/pet/`:
- `mood.json`, `hunger.json`, `health.json` — attribute states
- `intimacy.json` — growth points
- `skill-system.json` — domain data, tools, realized skills
- `learning-system.json` — courses, progress, history
- `achievement-system.json` — unlock records

## Desktop Pet Client (`apps/desktop-pet/`)

Electron app, frameless transparent window, always-on-top. See `apps/desktop-pet/CLAUDE.md` for detailed architecture.

Key conventions:
- **No bundler**: Plain ES module imports in renderer
- **IPC only**: Renderer uses `window.electronAPI`, never Node.js directly
- **Canvas rendering**: Pet animation via `requestAnimationFrame` in PetRenderer
- **Streaming chat**: `electronAPI.chatSend()` + `onChatStream()` for AI conversation
- **Server-authoritative state**: Client has no local state systems — all pet state (mood/hunger/health/growth) lives in the server-side Pet Engine, accessed via `PetStateSync` → generic `petRPC`

### Client–Server State Architecture

```
Renderer (PetStateSync)
  │  petRPC('pet.state.get')        ← 10s polling
  │  petRPC('pet.interact', {...})  ← click/feed/chat/quiz/...
  │  petRPC('pet.skill.record')     ← domain activity
  ▼
Preload (single IPC channel)
  │  petRPC: (method, params) => ipcRenderer.invoke('pet-rpc', method, params)
  ▼
Main → llm-service.petRPC()
  │  _ensureConnected() + _sendRequest(method, params)
  ▼
Gateway (21 pet.* RPC handlers) → PetEngine (in-memory, file-persisted)
```

- **No local MoodSystem/HungerSystem/HealthSystem/IntimacySystem** — removed entirely
- All state reads go through `petSync.getMood()`, `petSync.getGrowthStage()`, etc.
- All mutations go through `petSync.interact(action, rewards)` → server RPC
- UI reactions (bubbles, animations) triggered by `petSync.onAttributeChange()` / `onGrowthStageUp()` callbacks

## Key Conventions

- Pet engine is TypeScript (`src/pet/`), desktop client is plain JS (`apps/desktop-pet/`)
- All pet state logic lives in the engine, clients are thin renderers
- One generic `petRPC(method, params)` covers all `pet.*` methods — no specialized IPC per method
- Keep upstream OpenClaw modules untouched when possible for easy sync
- New pet features go in `src/pet/` + `src/gateway/server-methods/pet.ts`
