# Crayfish Bot

A desktop pet powered by AI — fork of [OpenClaw](https://github.com/openclaw/openclaw) with a built-in Pet Engine for AI character/companion features.

## What is this?

Crayfish Bot turns OpenClaw into an AI desktop companion. A virtual pet lives on your screen, reacts to your actions, learns new skills, grows through intimacy stages, and chats with you using LLM-powered personality.

**Key features:**

- **Desktop Pet** — Frameless, transparent, always-on-top Electron app with high-quality frame-by-frame cat animations
- **Pet Engine** — TypeScript state engine managing mood, hunger, health, growth, skills, learning, and achievements
- **AI Personality** — LLM-driven inner voice with configurable persona and structured prompts
- **Growth System** — 4 intimacy stages (kitten → friend → companion → soulmate) with visual evolution
- **Skill System** — 7 life domains, 5 skill attributes, domain activity tracking, epiphany events
- **Learning System** — Timed courses with XP, fragments, interactive quizzes, and level progression
- **Achievement System** — 12 badges unlocked through tool usage, chat, and growth milestones
- **Sub-agents** — Up to 4 mini-cat companions that execute tasks independently

Built on OpenClaw's Gateway for LLM routing, session management, and tool execution.

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm

### Setup

```bash
# Clone
git clone https://github.com/BlackBearCC/crayfish-bot.git
cd crayfish-bot

# Install
pnpm install

# Run OpenClaw onboarding (first time only — sets up API keys)
npx openclaw onboard

# Build pet engine
pnpm build

# Launch desktop pet
cd apps/desktop-pet
pnpm install
npm run generate-placeholder   # Generate sprite assets (first time)
npm start                      # Launch the app
```

### Development

```bash
# Dev mode (opens DevTools)
cd apps/desktop-pet
npm run dev

# Build Gateway with auto-reload
pnpm gateway:watch

# Run tests
npm test
```

## Architecture

```
crayfish-bot/
├── src/pet/                    # Pet Engine (TypeScript)
│   ├── pet-engine.ts           # Main entry, composes all subsystems
│   ├── attribute-engine.ts     # Generic attributes (mood/hunger/health)
│   ├── growth-system.ts        # Intimacy stages + evolution
│   ├── persona-engine.ts       # LLM persona + prompt builder
│   ├── skill-system.ts         # Domain tracking, epiphany, attribute XP
│   ├── learning-system.ts      # Courses, timer, XP, fragments, levels
│   ├── achievement-system.ts   # 12 achievement badges
│   ├── domain-system.ts        # 7 domains + 5 attributes + weight matrix
│   ├── event-bus.ts            # Typed pub/sub events
│   ├── presets.ts              # Default configs
│   └── index.ts                # Public API
├── src/gateway/                # OpenClaw Gateway (HTTP/WS on port 18789)
│   └── server-methods/pet.ts   # 21 pet.* RPC handlers
├── apps/desktop-pet/           # Electron desktop pet client
│   ├── electron/               # Main process (IPC, window, LLM service)
│   ├── src/                    # Renderer (canvas, UI, interactions)
│   ├── assets/                 # Spritesheets
│   └── scripts/                # Asset generation
└── ...                         # Other OpenClaw modules
```

### Data Flow

```
Desktop Pet (Electron Renderer)
  │  PetStateSync — polls pet.state.get every 10s, caches for UI reads
  │  All mutations via petSync.interact(action, rewards) → generic petRPC
  ▼
Electron Main (single petRPC IPC channel)
  │  llm-service.petRPC(method, params) → WebSocket
  ▼
Gateway (port 18789)
  ├── pet.* handlers → PetEngine (in-memory, file-persisted)
  ├── chat.* handlers → LLM API (streaming)
  └── agent.* handlers → Tool execution
```

Client has no local state systems — server Pet Engine is the sole authority for mood, hunger, health, and growth.

### Pet Engine RPC Methods (21 total)

| Category | Methods |
|----------|---------|
| State | `pet.state.get`, `pet.interact`, `pet.growth.info`, `pet.config.get` |
| Persona | `pet.persona.get`, `pet.persona.set` |
| Skills | `pet.skill.record`, `pet.skill.tool`, `pet.skill.attributes`, `pet.skill.tools`, `pet.skill.realized`, `pet.skill.addRealized` |
| Learning | `pet.learn.courses`, `pet.learn.add`, `pet.learn.start`, `pet.learn.abort`, `pet.learn.active`, `pet.learn.progress`, `pet.learn.history` |
| Achievements | `pet.achievement.list`, `pet.achievement.check` |

### Persistence

Pet state stored as JSON in `~/.openclaw/store/pet/`:
- `mood.json`, `hunger.json`, `health.json` — attribute states
- `intimacy.json` — growth points
- `skill-system.json` — domains, tools, realized skills
- `learning-system.json` — courses, progress, history
- `achievement-system.json` — unlock records

## Growth Stages

| Stage | Points | Name | Visual |
|-------|--------|------|--------|
| 0 | 0 | Kitten | Kitten spritesheet, 0.85x scale |
| 1 | 100 | Friend | Adult + brightness filter |
| 2 | 350 | Companion | Adult (default) |
| 3 | 800 | Soulmate | Adult + saturate filter |

## Upstream Sync

This is a fork of OpenClaw. To pull latest upstream changes:

```bash
git fetch upstream
git merge upstream/main
```

- `origin` → https://github.com/BlackBearCC/crayfish-bot.git
- `upstream` → https://github.com/openclaw/openclaw.git

## License

MIT — see [LICENSE](LICENSE).
