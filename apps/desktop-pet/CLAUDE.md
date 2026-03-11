# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                    # Install dependencies (includes petclaw gateway)
npm run generate-placeholder   # Generate placeholder spritesheets (required first-time setup)
npm start                      # Launch app (auto-starts PetClaw Gateway subprocess)
npm run dev                    # Development mode with DevTools opened
npm run dist                   # Build distributable Windows .exe
npm test                       # Run Jest tests (ES module support enabled)
```

**Prerequisite**: Pet-Claw 客户端首次启动时会自动初始化 `~/.petclaw/openclaw.json`，无需手动 onboard。

**ELECTRON_RUN_AS_NODE 自愈**：Claude Code 等工具会设置 `ELECTRON_RUN_AS_NODE=1`，导致 Electron 以纯 Node 模式启动。`main.js` 顶部已内置自愈逻辑：检测到该变量时，利用 `require('electron')` 返回的二进制路径，以干净环境 `spawn` 重新启动自身，因此可直接在 Claude Code 终端中 `pnpm start`。

## Architecture

PetClaw Desktop Character is a frameless, transparent, always-on-top Electron desktop companion. The app is split into two isolated processes:

**Main process** (`electron/main.js`):
- Creates 280×580px window positioned bottom-right
- Manages the PetClaw Gateway subprocess (auto-spawned from `node_modules/openclaw`)
- Handles Win32 foreground window tracking (`electron/win32-monitor.js`)
- All LLM communication via `electron/llm-service.js` which connects to the Gateway over HTTP/WebSocket

**Renderer process** (`src/`):
- Pure ES modules, no bundler — `src/index.html` uses `<script type="module" src="app.js">`
- `src/app.js` exports `PetClawPet` class which bootstraps and owns all subsystems
- No direct Node.js access — renderer talks to main exclusively via `window.electronAPI` (exposed by `electron/preload.js`)

**IPC bridge** (`electron/preload.js`):
- All renderer→main calls go through `window.electronAPI`
- Main→renderer events: `toggle-chat`, `chat-stream`, `agent-event`, `clipboard-changed`, `feed-character`, `dock-target-update`, etc.
- Renderer→main: `chatSend(text, sessionKey)` → streaming; `chatWithAI(text)` → one-shot legacy; `expandWindow(bool)`, `setIgnoreMouse(bool)`, etc.
- **Generic RPC**: `characterRPC(method, params)` — single IPC channel covering all `character.*` gateway methods. No per-method specialized IPC.

**Server-authoritative state** (`src/character/CharacterStateSync.js`):
- All character state (mood/hunger/health/growth/skills) managed by server-side Character Engine
- `CharacterStateSync` polls `character.state.get` every 10s, caches values for synchronous UI reads
- All mutations route through `charSync.interact(action, rewards)` → server RPC
- No local MoodSystem/HungerSystem/HealthSystem/IntimacySystem — removed entirely
- UI reactions (bubbles, animations) triggered by `onAttributeChange()` / `onGrowthStageUp()` callbacks

## Renderer Subsystems

```
src/app.js (PetClawPet)
├── character/CharacterStateSync.js   Server state bridge (characterRPC, 10s polling, callbacks)
├── character/CharacterRenderer.js    Canvas 2D renderer; wraps SpriteSheet + StateMachine
├── character/StateMachine.js         Animation state transitions (idle/walk/sit/sleep/work/eat/…)
├── character/Behaviors.js            Autonomous behavior scheduler (random movement, idle actions)
├── character/FeedingAnimator.js      4-phase feeding sequence
├── character/DomainSystem.js         7 life domains + 5 attributes + weight matrix (static defs)
├── character/SkillSystem.js          Domain activity tracking + epiphany trigger + attribute XP
├── character/CharacterAI.js          Character inner-voice LLM (persona-aware, structured prompts)
├── character/LearningSystem.js       Course timer, XP, fragments, reads state from charSync
├── character/CourseGenerator.js      LLM-generated courses (persona-aware)
├── character/LearningEventScheduler.js Learning session interactive events (murmur/quiz/story)
├── character/AchievementSystem.js    12 achievement badges, reads stage from charSync
├── character/MiniCatSystem.js        Sub-agent mini-cat companions (≤4)
├── character/AgentStatsTracker.js    Sub-session tool stats
├── character/WorkspaceWatcher.js     Foreground window title parsing
├── ui/ChatPanel.js                   Full chat UI with streaming support
├── ui/StreamingBubble.js             Stacked speech bubbles (up to 8)
├── ui/BottomChatInput.js             Quick-input bar below the character
├── ui/MarkdownPanel.js               Markdown rendering panel (left side)
├── ui/SkillPanel.js                  4-tab almanac (tools/skills/agents/achievements)
├── ui/ToolStatusBar.js               Tool execution status above character
├── ui/LearningStatusBar.js           Bottom learning progress bar
├── ui/LearningChoiceUI.js            Interactive Q&A choice buttons during learning
├── ui/SettingsPanel.js               Config UI (model, personality, etc.)
├── ui/MemoryGraphPanel.js            Memory graph visualization (reads from server RPC)
├── ui/AgentConnections.js            SVG connection lines visualization
├── interaction/DragHandler.js        Window drag via moveWindow IPC
├── interaction/ClickHandler.js       Single / double / long-press detection
├── interaction/FileDropHandler.js    File drop → AI analysis, mutations via charSync
└── interaction/ContextMenu.js        Right-click menu with stat bars from charSync
```

## Sprite System

Spritesheets live in `assets/sprites/placeholder/`. Each animation has a `.png` atlas and a `.json` descriptor with frame coordinates and timing. The main spritesheet (`spritesheet.png`) has 128×128 frames in an 8-col × 12-row grid. Compound animations (sleep, work) use separate enter/loop/exit sheets registered via `StateMachine.addCompoundAnimation()`.

Regenerate all sprites: `npm run generate-placeholder` (calls `scripts/generate-placeholder.js`).

## Growth Stages (server-managed)

| Stage | Points | Name | Spritesheet | CSS filter |
|-------|--------|------|-------------|------------|
| 0 | 0 | 幼猫 | kitten | scale(0.85) |
| 1 | 100 | 朋友 | adult | brightness(1.12) saturate(0.8) |
| 2 | 350 | 亲密伙伴 | adult | none |
| 3 | 800 | 心灵契合 | adult | saturate(1.25) brightness(0.92) |

Persisted server-side in `~/.petclaw/store/character/intimacy.json`. Client reads via `charSync.getGrowthStage()`.

## CharacterAI & Prompt Engineering

`CharacterAI.js` handles all character-internal LLM calls (not through PetClaw Gateway). Key conventions:

- **Persona from config**: All prompts load persona via `_getPersona()` which reads `systemPrompt` from user settings. Default: `'你是一只可爱的桌面宠物猫'`. Never hardcode a specific character in prompts.
- **Structured prompts**: Use `_buildPrompt(persona, context, task)` → `[角色] + [情景] + [任务]` three-section format.
- **Role-neutral language**: Use "角色人设的口吻" not "猫咪口吻". Constraints (word limits, format) go in `[任务]` section.
- **`resetPersona()`**: Call when settings change to clear cached persona.
- **LLM config** (`electron/main.js` `character-ai-complete`): `enable_thinking: false` (百炼 provider), `max_tokens: 1024`, `stream: false`.

## Learning System

- **Online-only**: Learning must complete while app is running. App exit = lesson interrupted, no XP.
- **LearningEventScheduler**: During learning sessions (30-60 min), triggers interactive events every 2-3 min (first at 30-60s):
  - Murmur (50%): 8-char bubble via CharacterAI
  - Quiz (30%): Choice buttons → mood/intimacy rewards
  - Story (20%): Fun fact via MarkdownPanel
- **Event sync**: All learning events + CharacterAI reactions written to PetClaw via `appendAgentSession` + `appendAgentMemory`.
- **StateMachine note**: Transitioning from `work` to `talk`/`happy` returns to `idle` (not `work`). Must manually `transition('work', { force: true })` after temporary animations.

## Key Conventions

- **No bundler**: Do not introduce webpack/vite. Keep renderer as plain ES module imports.
- **IPC only**: Renderer must never use Node.js APIs directly. All system access goes through `window.electronAPI`.
- **Canvas rendering**: Character animation runs via `requestAnimationFrame` in `CharacterRenderer`. Do not manipulate the canvas outside this class.
- **Streaming chat**: Use `electronAPI.chatSend()` + `onChatStream()` for new AI calls. `chatWithAI()` is legacy (one-shot, used only for quick bubble responses when chat panel is closed).
- **Server-authoritative state**: All character state (mood, hunger, health, growth) managed by server Character Engine via `charSync`. No local state systems. Client-side `localStorage` only for UI preferences (settings cache, chat count).
- **Generic RPC**: Use `characterRPC(method, params)` for all `character.*` calls. Do not create specialized IPC handlers per method.
- **Mouse passthrough**: Interactive UI elements must be added to the `isOverPanel` check in `_setupMousePassthrough()` to receive clicks.
