# OpenClaw Pet 🐱

OpenClaw 桌面宠物助手 — 内嵌 OpenClaw AI 的可爱像素小猫。

**一体化打包**：一个 exe 启动，OpenClaw Gateway 自动在内部运行，无需手动启动任何服务。

## 快速开始

```bash
# 安装全部依赖（含 OpenClaw）
npm install

# 生成占位帧动画（首次运行）
npm run generate-placeholder

# 启动（自动拉起 OpenClaw Gateway）
npm start

# 开发模式（自动打开 DevTools）
npm run dev

# 打包成 exe
npm run dist

# 运行测试
npm test
```

**前提**：需要先通过 `openclaw onboard` 完成 OpenClaw 的基础配置（选模型、配 API Key 等），这些配置保存在 `~/.openclaw/openclaw.json` 中。

> **注意**：Claude Code 环境会设置 `ELECTRON_RUN_AS_NODE=1`，导致 Electron 以纯 Node 模式启动。请在系统终端（PowerShell / cmd）中运行 `npm start`。

## 架构

```
┌──────────────────────────────────────────┐
│            Electron 主进程                │
│  ┌────────────────────────────────┐      │
│  │     LLM Service                │      │
│  │  - 管理 Gateway 生命周期       │      │
│  │  - 调用 /v1/chat/completions   │      │
│  │  - 流式 chat + agent 事件转发  │      │
│  └──────────┬─────────────────────┘      │
│             │ HTTP localhost:18789        │
│  ┌──────────▼─────────────────────┐      │
│  │  OpenClaw Gateway (子进程)      │      │
│  │  - 来自 node_modules/openclaw   │     │
│  │  - 自动启动/关闭                │      │
│  └────────────────────────────────┘      │
│                                          │
│  Win32Monitor — 前台窗口轮询 (4s)        │
│  ClipboardWatcher — 剪贴板轮询 (2s)      │
│  PetAI LLM — 宠物内心独白直连 LLM       │
├──────────────────────────────────────────┤
│            Electron 渲染进程              │
│  ┌─ 动画 ────────────────────────┐       │
│  │  PetRenderer (Canvas 2D 960px) │      │
│  │  StateMachine + Behaviors      │      │
│  │  MiniCatSystem (子代理伴侣)    │      │
│  │  AgentConnections (SVG 连线)   │      │
│  ├─ 养成 ────────────────────────┤       │
│  │  Hunger / Mood / Health        │      │
│  │  IntimacySystem (4 阶段)       │      │
│  │  KnowledgeSystem + PetAI       │      │
│  │  SkillUnlockSystem             │      │
│  │  AchievementSystem (12 徽章)   │      │
│  ├─ UI ──────────────────────────┤       │
│  │  ChatPanel / BottomChatInput   │      │
│  │  StreamingBubble / Markdown    │      │
│  │  SkillPanel (四页图鉴)         │      │
│  │  SettingsPanel / ContextMenu   │      │
│  │  ToolStatusBar                 │      │
│  └────────────────────────────────┘      │
└──────────────────────────────────────────┘
```

窗口尺寸 620×580px，透明无边框，置顶显示，定位于屏幕右下角。渲染进程通过 `window.electronAPI`（preload 暴露）与主进程通信，不直接使用 Node.js API。

## 功能

### 动画与交互

- **帧动画引擎** — Canvas 2D 渲染 960px，spritesheet 驱动，19 张 spritesheet
- **18 种动画状态** — idle / walk / sit / sleep / swing / work / drag / click_react / happy / sad / talk / eat / edge_idle，以及 5 种 idle 变体（ear_twitch / yawn / sneeze / trip / butterfly）
- **复合动画** — sleep、work、swing 支持 enter → loop → exit 三阶段
- **自主行为** — 每 4–12 秒触发：走动 30% / 坐下 15% / 荡秋千 30% / 静止 25%；idle 变体每 8–17 秒随机播放
- **睡眠** — 10 分钟无互动自动入睡，任意交互唤醒
- **拖拽** — 抓住小猫拖到桌面任意位置，到达边缘会触发边缘反应
- **点击互动** — 单击摸头（心情 +3，亲密 +1），双击打开聊天面板，长按 1.5s 撒娇（心情 +15，亲密 +5）
- **文件拖放** — 拖入代码/文档文件，AI 自动分析内容（支持 35 种文件格式，最大 100KB）
- **剪贴板感知** — 主进程每 2 秒轮询剪贴板，检测 URL / 错误 / 代码 / 长文本并通知渲染进程
- **前台窗口检测** — Win32 API 轮询当前前台窗口，WorkspaceWatcher 解析 VS Code / JetBrains / 终端窗口标题

### 养成系统

- **亲密度成长** — 4 阶段：幼猫 🐱(0) → 朋友 😺(100) → 亲密伙伴 😻(350) → 心灵契合 💖(800)，不同阶段切换 spritesheet 和 CSS 滤镜
- **三维数值** — 饱腹度（衰减 0.6/分钟）、心情值（衰减 0.4/分钟，下限 15）、健康值（由饱腹+心情联合驱动），均持久化到 localStorage，支持离线衰减补算
- **喂食** — 右键菜单喂零食，饱腹 +35 / 心情 +20 / 亲密 +10，触发 4 阶段喂食动画
- **领域成长** — DomainSystem 定义 7 个生活领域（技术/创作/办公/探索/生活/社交/情感），对话内容通过 `inferDomainFromText()` 自动推断领域，学习课程完成也可贡献；领域活跃度积累触发 PetAI 生成"领悟"
- **宠物属性** — 5 维属性（逻辑力/创造力/执行力/共情力/感受力），基于 Gardner 多元智能 + Sternberg 三元论 + Goleman 情商；领域→属性权重矩阵驱动属性 XP 成长（共 10 级），图鉴技能 tab 展示 5 维进度条
- **工具图鉴** — 工具调用仍记录到图鉴（供展示），1/5/20 次分别解锁 ⭐/⭐⭐/⭐⭐⭐；工具数据不再影响技能领域
- **成就系统** — 12 枚徽章（初出茅庐/搜索达人/代码工匠/终端大师/全能助手/心灵契合/指挥官/夜猫子/文件侦探/话痨伙伴/神速执行/冲浪高手），解锁后加亲密度

### 子代理伴侣

- **MiniCatSystem** — 自动轮询 Gateway 活跃子会话，显示最多 4 只迷你猫伴侣（48px），有 idle/busy/happy 状态和浮动动画
- **AgentConnections** — SVG 连线可视化主猫与迷你猫之间的关系，busy 状态显示流动粒子 + 工具图标 + 任务名
- **AgentStatsTracker** — 记录每个子会话的工具使用数、时长、独立工具数，7 天自动清理

### AI 对话

- **流式聊天** — 支持流式输出的聊天面板，可中断（`chatAbort`）
- **消息气泡** — 头顶堆叠气泡（最多 8 段），分句显示，每段间隔 1 秒，5 秒后自动消退
- **Markdown 面板** — 检测到 MD 语法的回复在角色左侧独立面板完整渲染（使用 marked 库），15 秒自动关闭
- **快捷输入** — 底部浮动输入栏，Enter 发送，流式回复走气泡，Markdown 回复走面板
- **工具状态栏** — 角色头顶显示当前执行的工具名称 + 图标 + 转圈动画
- **思考动画** — 等待 AI 首个回复时显示 6 点省略号动效
- **内嵌 OpenClaw** — 自动管理 Gateway 生命周期，支持多会话、工具调用、Agent 事件

### 图鉴面板

四页 Tab 切换：
- **工具** — 展示所有已用工具，区分核心/插件/额外，显示星级
- **技能** — 7 个生活领域活跃度 + 5 维属性进度条 + 领悟技能列表
- **代理** — 持久化代理列表、子会话历史、工具统计
- **成就** — 12 枚徽章解锁状态和日期

### 设置与自定义

- **设置面板** — 右键 → 设置，配置模型、人设等
- **右键菜单** — 自定义 DOM 风格菜单，顶部显示三维数值进度条（🍖 饱腹 / 😊 心情 / 💚 健康），支持喂食/聊天/图鉴/设置/置顶/清空对话/开发者工具/退出

## 项目结构

```
openclaw-pet/
├── electron/
│   ├── main.js                主进程、窗口 620×580、IPC 路由
│   ├── preload.js             安全桥接 window.electronAPI
│   ├── llm-service.js         Gateway 管理 + 流式对话 + Agent 事件
│   └── win32-monitor.js       Win32 前台窗口轮询
├── src/
│   ├── app.js                 渲染入口，串联所有子系统
│   ├── pet/
│   │   ├── PetRenderer.js     Canvas 动画渲染器 (960px)
│   │   ├── SpriteSheet.js     Spritesheet 加载 + 帧绘制
│   │   ├── StateMachine.js    18 种动画状态机
│   │   ├── Behaviors.js       自主行为调度 + 边缘检测
│   │   ├── MoodSystem.js      心情系统（衰减 + 离线补算）
│   │   ├── HungerSystem.js    饱腹度系统
│   │   ├── HealthSystem.js    健康值系统（饱腹+心情联合驱动）
│   │   ├── IntimacySystem.js  亲密度 / 4 阶段成长
│   │   ├── FeedingAnimator.js 4 阶段喂食动画
│   │   ├── DomainSystem.js    7 领域 + 5 属性 + 权重矩阵（静态定义）
│   │   ├── SkillSystem.js     领域活跃度 + 领悟触发 + 属性 XP 成长（原 KnowledgeSystem + SkillUnlockSystem 合并）
│   │   ├── PetAI.js           宠物内心独白 LLM 直连
│   │   ├── AchievementSystem.js 12 枚成就徽章
│   │   ├── MiniCatSystem.js   子代理迷你猫伴侣 (≤4)
│   │   ├── AgentStatsTracker.js 子会话工具统计
│   │   └── WorkspaceWatcher.js  前台窗口标题解析
│   ├── interaction/
│   │   ├── DragHandler.js     窗口拖拽
│   │   ├── ClickHandler.js    单击/双击/长按 (1.5s)
│   │   ├── FileDropHandler.js 文件拖放分析 (35 种格式)
│   │   └── ContextMenu.js     右键菜单 + 状态条
│   ├── ui/
│   │   ├── ChatPanel.js       聊天面板（流式 + 多会话）
│   │   ├── StreamingBubble.js 堆叠消息气泡 (≤8 段)
│   │   ├── MarkdownPanel.js   Markdown 渲染面板
│   │   ├── BottomChatInput.js 底部浮动快捷输入
│   │   ├── SettingsPanel.js   设置面板
│   │   ├── SkillPanel.js      四页图鉴（工具/技能+属性/代理/成就）
│   │   ├── ToolStatusBar.js   工具执行状态栏
│   │   └── AgentConnections.js SVG 连线可视化
│   ├── bridge/
│   │   └── OpenClawBridge.js  (已弃用)
│   └── utils/
│       └── textSplitter.js    标点分句工具
├── assets/sprites/            帧动画资源 (19 张 spritesheet)
└── scripts/                   工具脚本
```

## 替换动画资源

1. 准备 128×128 的序列帧 PNG
2. 打包成 spritesheet（如 TexturePacker）
3. 生成 JSON 元数据（参考 `assets/sprites/placeholder/spritesheet.json`）
4. 放到 `assets/sprites/` 对应目录
5. 复合动画需额外准备 enter/loop/exit 三张 spritesheet

## License

MIT
