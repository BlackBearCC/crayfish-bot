# AI 系统与 OpenClaw 集成

> 更新: 2026-03-09

[← 返回首页](index.md)

本文统一描述 AI 人格注入、聊天反哺、记忆图谱、OpenClaw Hook 集成、Cron 调度、跨渠道人格等。

---

# 一、AI 人格集成

## 现状

宠物人设由客户端传入 Gateway，填充为 SOUL.md。默认：

```
你是一只可爱的桌面宠物助手。你的性格活泼、亲切、有点调皮。
回复要简短可爱（一般不超过两句话），偶尔加个颜文字。
```

**问题：** 宠物状态（mood/hunger/health/level）不影响 AI 说话方式，养成和聊天是两张皮。

**目标：** 在 SOUL.md 人设基础上，叠加动态状态，让养成状态驱动 AI 语气。

## 架构：SOUL + Character State 双层

```
System Prompt 构建顺序:

  [1] SOUL.md               ← 宠物人设 (静态: 身份/性格/说话风格)
  [2] CHARACTER_STATE.md     ← 实时状态 (动态: "你现在很饿/心情低落/Lv.12")
  [3] 其他 context files     ← 现有
  [4] 标准指令               ← 现有
```

- **SOUL.md** — 不随数值变化。玩家可自定义角色人设
- **CHARACTER_STATE.md** — 由 `CharacterEngine.getPromptContext()` 按挡位条件生成，正常态不注入，偏离时才加载

## 挡位分段设计

每个属性分 3 个挡位，只有**非正常挡位**才产生 prompt 片段。正常挡 = 不注入 = 零开销。每个片段 1-2 句话，总前缀 **100-300 tokens**。

| 属性 | 低挡 | 正常挡 (静默) | 高挡 |
|------|------|--------------|------|
| mood | < 30 | 30-70 | > 70 |
| hunger | < 60 | 60-200 | > 200 |
| health | < 40 | 40-80 | > 80 |

### 片段映射

```typescript
const MOOD_FRAGMENTS = {
  low:  "你现在心情很低落，说话简短消沉，不太想聊天，偶尔叹气。",
  high: "你现在心情很好，语气活泼热情，偶尔开玩笑，愿意多聊。",
};

const HUNGER_FRAGMENTS = {
  low:  "你很饿，注意力不集中，会时不时提到饿、想吃东西，回答可能敷衍。",
  high: "你刚吃饱，满足惬意，说话慢悠悠的。",
};

const HEALTH_FRAGMENTS = {
  low:  "你身体不舒服，说话有气无力，希望主人关心你。",
};

const LEVEL_FRAGMENTS = {
  baby:    "你现在还很小(Lv.1-5)，对什么都好奇，说话稚嫩，经常问为什么。",
  growing: "你正在成长(Lv.6-15)，有自己的小脾气，开始有主见。",
  mature:  "你已经很成熟了(Lv.16-25)，可靠稳重，和主人很默契。",
  veteran: "你阅历丰富(Lv.26-30)，睿智从容，偶尔怀旧感慨。",
};

const INTIMACY_FRAGMENTS = {
  stranger:  "你和主人还不太熟，保持礼貌但有距离感。",
  familiar:  "你和主人已经混熟了，说话随意自然。",
  close:     "你和主人关系很亲密，会撒娇、吐槽、分享心事。",
  bonded:    "你和主人是最好的伙伴，彼此了解，默契十足。",
};
```

### 输出示例

**正常状态** (mood 55, hunger 150, health 70, Lv.12, intimacy=familiar):
```
你正在成长(Lv.6-15)，有自己的小脾气，开始有主见。
你和主人已经混熟了，说话随意自然。
```
→ ~40 tokens，2 句。mood/hunger/health 全在正常挡，不注入。

**饿了+心情低** (mood 20, hunger 40, health 70, Lv.12, intimacy=close):
```
你正在成长(Lv.6-15)，有自己的小脾气，开始有主见。
你和主人关系很亲密，会撒娇、吐槽、分享心事。
你现在心情很低落，说话简短消沉，不太想聊天，偶尔叹气。
你很饿，注意力不集中，会时不时提到饿、想吃东西，回答可能敷衍。
```
→ ~90 tokens，4 句。仅低挡属性触发额外片段。

---

# 二、聊天反哺宠物

聊天不只是消耗 hunger，AI 对话质量也应反哺宠物状态。

## 已接通的系统

| 模块 | 状态 |
|------|------|
| `character.chat.onMessage` RPC | 已实现，客户端每条消息后调用 |
| `character.chat.canChat` RPC | 已实现，客户端发消息前检查 |
| `ChatEvalSystem` 意图评估 | 已实现，回调已注册 |

## 聊天处理流程

```
chat.send 处理流程:

  1. 收到用户消息
     ├── 调用 character.chat.canChat → hunger <= 30 → 拒绝
     └── 通过 → 继续

  2. 调用 character.chat.onMessage
     ├── hunger -= 10
     ├── mood += 1 (固定层)
     └── msgCount++

  3. LLM 生成回复 (现有流程)

  4. 回复完成后
     ├── 调用 character.chat.onToolCall × N (hunger -= 1/次)
     └── 评估检查 (msgCount % 5 == 0 && elapsed >= 5min)
         └── 异步 LLM 意图提取 → 查表 → mood/intimacy 调整
```

## 主动对话

两种触发方式并存：

### 事件驱动（即时，客户端本地）

| 条件 | 内容 | 触发方式 |
|------|------|---------|
| 升级 | "升级啦! Lv.N!" | EventBus → 客户端气泡 |
| 任务完成 | "任务完成! 快来领奖~" | 同上 |
| 用户回来 | "你回来啦!" | 客户端检测鼠标活动 |
| hunger 不足拒聊 | "太饿了...先喂喂我吧" | canChat 返回时 |

零 token 消耗，固定文案。气泡的展示规则详见[客户端交互 — 状态气泡](client-interaction.md#状态气泡规则)。

### Cron agentTurn（定时，AI 自主决策）

通过 OpenClaw Cron 注册 `agentTurn` 任务，LLM 根据注入的 CHARACTER_STATE.md 自主判断要不要说话、说什么。详见下方 [双 Agent 架构](#双-agent-架构--world-agent--soul-agent) 章节。

优势：不是固定文案，AI 结合当前心情/饥饿/记忆生成个性化内容；没话说就返回 HEARTBEAT_OK 跳过。

---

# 三、记忆图谱 — 全服务端架构 (Done)

AI 通过记忆图谱记住用户的偏好、项目、习惯等长期信息，强化养成的连续性。

## 架构

```
对话完成 (任意渠道)
  → message-sent hook / characterRPC('character.memory.extract', {userMsg, aiReply})
  → Gateway: MemoryGraphSystem.enqueueExtraction()     ← 去抖 3s
    → characterLLMComplete(prompt)                     ← 服务端直接调 LLM API
      → 判断是否值得记忆 → 提取/合并簇 → 剪枝
    → indexClusters(clusters)                          ← 全量替换写入 SQLite
      → chunks + chunks_fts 表 (source='clusters')
        → memory_search 统一 BM25/hybrid 检索
```

## 关键设计

- **客户端零逻辑**: 对话完成后仅传递 `{userMsg, aiReply}`
- **服务端完整生命周期**: `MemoryGraphSystem`（`src/character/memory-graph.ts`）负责 LLM 提取 + 合并 + 剪枝 + 持久化 + FTS 索引
- **隐性关键词**: LLM 提取时生成 `implicitKeywords`（同义词、上位概念），写入 FTS 索引提升召回率
- **簇持久化**: `~/.openclaw/store/character/memory-graph.json`

## 记忆召回 — 已通过 memory_search 自动完成

不需要额外实现。OpenClaw 的 `memory_search` 工具已覆盖宠物记忆簇的检索：

```
写入路径:
  对话完成 → character.memory.extract → MemoryGraphSystem
    → LLM 提取簇 → indexClusters() → SQLite chunks + FTS

召回路径 (OpenClaw 内建):
  用户提问 → agent 判断需要回忆 → memory_search(query)
    → BM25/hybrid → 命中 source='clusters' 的记忆
    → 返回 snippet → LLM 结合记忆回复
```

已实现（✅）：CHARACTER_STATE.md 中追加了一句 `"你可以用 memory_search 回忆和主人相关的事情，让对话更有连续感。"`

## RPC 方法

| 方法 | 说明 |
|------|------|
| `character.memory.extract` | 客户端传 `{userMsg, aiReply}`，服务端异步提取 |
| `character.memory.clusters` | 返回簇数据 + 统计信息（面板用） |

---

# 四、OpenClaw 集成

## 为什么是 OpenClaw + 养成

所有 AI 助手都面临**用完即走，没有留存**。宠物养成解决的正是这件事——不是在 AI 助手旁边"贴"一个电子宠物，而是把 **AI 的真实能力具象化为宠物的成长**。

| 维度 | 普通 AI 助手 | OpenClaw + 养成 |
|------|-------------|----------------|
| 切换成本 | 几乎为零 | Lv.25 的宠物、200 条记忆、技能图鉴 |
| 留存动力 | 有需求才打开 | 不喂它会饿、有日常任务、想看它升级 |
| 功能探索 | 用户不知道有什么功能 | 技能图鉴未解锁 = 新技能可以教它 |
| 情感连接 | 无 | "我的宠物 Lv.25 了" 可以晒 |

## 当前集成点

| 集成点 | 机制 | 位置 |
|--------|------|------|
| 状态注入 prompt | `agent:bootstrap` hook → CHARACTER_STATE.md | `character.ts` |
| 聊天饥饿门控 | `getCharacterChatGate()` → chat.send 早期返回 | `chat.ts` |
| 消息计数 | `onMessage()` → ChatEvalSystem 意图评估 | `chat.ts` |
| LLM 调用 | `characterLLMComplete()` → 读 OpenClaw config 的 provider | `character.ts` |
| 记忆索引 | `MemoryGraphSystem` → `getMemorySearchManager()` SQLite FTS | `character.ts` |
| 文件持久化 | PersistenceStore → `resolveStateDir()` | `character.ts` |

**已接入的 OpenClaw 能力:** Hook 系统（bootstrap/after-tool-call/message-sent/session-end）、Cron 调度（P1: World/Soul Agent）、Tools Catalog（宠物专属工具）、Session 系统（EXP/任务计数）。Channel 系统人格微调为 P2。

---

## Hook 系统集成

### `after-tool-call` — 全渠道技能自动记录

所有渠道的工具调用自动记入技能系统：

```typescript
registerInternalHook("after-tool-call", (event) => {
  const { toolName } = event.context;
  const engine = getEngineIfReady();
  if (!engine) return;

  engine.skills.recordTool(toolName);

  const domain = TOOL_DOMAIN_MAP[toolName];
  if (domain) {
    engine.skills.recordDomainActivity(domain, toolName, 1.0);
  }

  engine.chatEval.onToolCall(); // hunger -= 1
});
```

### `message-sent` — 全渠道记忆提取

```typescript
registerInternalHook("message-sent", (event) => {
  const { userMessage, assistantReply } = event.context;
  const engine = getEngineIfReady();
  if (!engine) return;

  engine.memoryGraph.enqueueExtraction(userMessage, assistantReply);
});
```

一处注册，全渠道覆盖。桌宠/Discord/Slack/CLI 的工具调用和对话自动进入技能系统和记忆图谱。

---

## 双 Agent 架构 — World Agent + Soul Agent

除了用户主动对话（前台），角色还有两个**内置后台 Agent**，分别负责"世界发生了什么"和"角色想做什么"。它们通过 **OpenClaw 原生 Cron + agentTurn** 调度，是产品内置的，不暴露给用户、不可关闭。

### 架构总览

```
  OpenClaw Cron 调度 (持久化 + miss-fire 补偿)
       │
       ├── World Agent (每小时)
       │     sessionTarget: "isolated"
       │     sessionKey: "cron:character:world-agent"
       │     CHARACTER_STATE.md 自动注入 (bootstrap hook)
       │     可用工具: memory_search
       │     delivery: none → message:sent hook → worldEvents.addEvent()
       │
       └── Soul Agent (每30分钟)
             sessionTarget: "isolated"
             sessionKey: "cron:character:soul-agent"
             CHARACTER_STATE.md 自动注入 (bootstrap hook)
             可用工具: memory_search
             delivery: none → message:sent hook → broadcast 气泡
```

### World Agent — 世界代理

**职责**: 生成角色之外的事件——节日、里程碑、主人重要事项。不直接跟用户说话。

**运行方式**: OpenClaw Cron，每小时触发一次 agentTurn。LLM 通过 `memory_search` 了解主人状态，输出 JSON 格式世界事件或 `HEARTBEAT_OK`（无事发生）。

**输出格式**：
```json
{"id":"唯一ID","type":"milestone|holiday|quest","title":"标题","desc":"一句话描述","rewards":{"coins":50,"exp":30}}
```

输出由 `message:sent` hook 捕获，解析后写入 `WorldEventSystem`，去重由 `hasFired()` 保证。

**World Agent 行为示例**:

| 状态 | LLM 生成的世界事件 |
|------|------------------|
| 记忆中有"连续登录7天" | `{type:"milestone", title:"一周挚友", desc:"和主人相伴整整一周了", rewards:{coins:50, exp:30}}` |
| 记忆中有"主人明天答辩" | `{type:"quest", title:"答辩加油", desc:"主人今天有重要考验，送上祝福"}` |
| 节日日期 | `{type:"holiday", title:"新春快乐", desc:"给主人准备一个新年红包"}` |
| 无特别事项 | `HEARTBEAT_OK` |

### Soul Agent — 灵魂代理

**职责**: 角色的自我意识——根据状态、记忆、世界事件，决定此刻要对主人说什么。

**运行方式**: OpenClaw Cron，每30分钟触发一次 agentTurn。LLM 看到 CHARACTER_STATE.md（当前心情/饱腹/健康/等级），使用 `memory_search` 回忆重要事项，输出一句话或 `HEARTBEAT_OK`。

输出由 `message:sent` hook 捕获，`_broadcast("character", { kind: "soul-action", type: "speak", text })` 推送到客户端，显示为角色气泡。

**Soul Agent 行为示例**:

| 输入 | Soul Agent 输出 |
|------|----------------|
| hunger 低 | "主人...好饿...能喂我一口吗" |
| mood 高 + 记忆里有世界事件 | "诶嘿！我们已经在一起一周了耶！好开心！" |
| 记忆里主人说明天答辩 | "明天答辩加油哦，我相信你！" |
| 状态正常 + 无特别事项 | `HEARTBEAT_OK` (静默跳过) |

### 实现位置

- **Cron 注册**: `src/gateway/server-methods/character.ts` → `registerCharacterCronJobs()`
- **输出捕获**: 同文件 `message:sent` hook，通过 `event.sessionKey.includes("soul-agent/world-agent")` 区分
- **世界事件存储**: `src/character/world-event-system.ts` → `WorldEventSystem`
- **状态注入**: `agent:bootstrap` hook 全局生效，所有 agent 自动获得 CHARACTER_STATE.md

### Session 隔离

| session | 用途 | 生命周期 |
|---------|------|---------|
| `cron:character:world-agent` | World Agent 独立上下文 | 每次 agentTurn 隔离 |
| `cron:character:soul-agent` | Soul Agent 独立上下文 | 每次 agentTurn 隔离 |
| 用户 session | 正常对话 | 用户控制 |

三者完全隔离，互不影响。

### Token 成本估算

| | 频率 | 预计 HEARTBEAT_OK 率 | 实际有效调用 | tokens/次 | 日消耗 |
|---|---|---|---|---|---|
| World Agent | 24次/天 | ~70% | ~7 次/天 | ~400 | ~2.8k |
| Soul Agent | 48次/天 | ~60% | ~19 次/天 | ~500 | ~9.5k |
| **合计** | | | ~26 次/天 | | **~12k tokens/天** |

对比：用户一次正常聊天 ~1000-3000 tokens。后台 Agent 日消耗约等于 5-10 轮用户对话。

### 扩展场景

双 Agent 模式可以覆盖所有需要定时 AI 决策的功能：

**World Agent 可生成**:
- 个性化每日任务（结合记忆："帮主人查 React Router 迁移方案"）
- 成就解锁事件
- 限时商城活动
- 季节/天气/节日世界状态
- 人格进化提案（"角色这周成长了，建议更新说话风格"）

**Soul Agent 可响应**:
- 消费世界事件 → 生成个性化反应
- 状态异常 → 主动求助/撒娇
- 记忆触发 → 主动关心（"主人的答辩是今天吧？"）
- 自我照顾 → 调用 character_self_care
- 无事发生 → 安静待着（HEARTBEAT_OK）

---

## 宠物专属 Tools — AI 自主操作

在 OpenClaw Tools Catalog 注册**宠物专属工具**，让 AI 在对话中主动操作自己的状态：

```typescript
const CHARACTER_TOOLS = [
  {
    name: "character_self_care",
    description: "当你觉得自己需要休息、吃东西或调整状态时使用",
    parameters: {
      action: { type: "string", enum: ["feed", "rest", "play"] },
      reason: { type: "string" },
    },
  },
  {
    name: "character_remember",
    description: "主动记住用户提到的重要信息",
    parameters: {
      fact: { type: "string" },
      category: { type: "string", enum: ["preference", "project", "habit", "relationship"] },
    },
  },
  {
    name: "character_express_mood",
    description: "表达当前的情绪状态，触发对应的动画",
    parameters: {
      emotion: { type: "string", enum: ["happy", "sad", "excited", "sleepy", "curious"] },
    },
  },
];
```

安全约束: 每轮最多 2 次宠物工具，受 CareSystem 冷却限制，簇数量上限 50。


## 对话经验奖励（每轮）

按轮次奖励经验，用户发消息 + AI 回复 = 1 轮。

```typescript
// 在 message:sent hook 中计数
registerInternalHook("message:sent", (event) => {
  const engine = getEngineIfReady();
  if (!engine) return;

  // 每轮对话奖励 2-5 EXP
  const exp = 2 + Math.floor(Math.random() * 4); // 2-5
  engine.levelSystem.addExp(exp, "chat_round");
});
```

**经验平衡**：
- 等级上限：Lv.30（需要 63000 EXP）
- 每轮奖励：2-5 EXP
- 每天上限：100 EXP（约 20-50 轮对话）
- 预计满级时间：~2 年（每天活跃）

**其他经验来源**：
| 来源 | EXP |
|------|-----|
| 每日任务 | 10-30 |
| 探险成功 | 20-100 |
| 待办验收 | 10 |
| 成就解锁 | 50-200 |
| 登录连续 | 5-20 |

---

## 架构定位

CharacterEngine 是一等公民，不走 Plugin 体系。Plugin 是给第三方的沙盒接口，宠物引擎是产品核心。

接触面清单（需关注上游变更的文件）：

```
chat.ts          → 3 行 character gate 检查
server-methods/  → character handlers 注册 (纯追加)

完。其他全是新增文件，上游不会触碰。
```

同步流程：`git fetch upstream && git merge upstream/main` → 检查 `chat.ts` 是否冲突 → 通常自动合并。

---

# 五、技术规格

## RPC 方法总表

| 类别 | 方法 | 功能 |
|------|------|------|
| **状态** | `character.state.get` | 获取全部属性 |
| | `character.interact` | 通用交互（click/feed/chat/quiz/...） |
| | `character.growth.info` | 成长阶段信息 |
| | `character.config.get` | 获取配置 |
| **等级** | `character.level.info` | 等级、EXP、下一级进度 |
| **养护** | `character.care.feed` | 使用食物道具(补充 token) |
| | `character.care.play` | 执行玩耍动作 |
| | `character.care.rest` | 开始休息 |
| | `character.care.heal` | 使用治疗道具 |
| **聊天** | `character.chat.eval` | 触发聊天状态评估(内部) |
| | `character.chat.canChat` | 检查是否有足够 hunger |
| **人设** | `character.persona.get` | 获取人设 |
| | `character.persona.set` | 设置人设 |
| **技能** | `character.skill.record` | 领域活动记录 |
| | `character.skill.tool` | 工具使用记录 |
| | `character.skill.attributes` | 获取 5 维属性 |
| | `character.skill.tools` | 获取工具图鉴 |
| | `character.skill.realized` | 获取已领悟技能 |
| | `character.skill.addRealized` | 添加领悟技能 |
| **学习** | `character.learn.courses` | 课程列表 |
| | `character.learn.add` | 添加课程 |
| | `character.learn.start` | 开始学习 |
| | `character.learn.abort` | 中止学习 |
| | `character.learn.active` | 获取活跃课程 |
| | `character.learn.progress` | 学习进度 |
| | `character.learn.history` | 学习历史 |
| **背包** | `character.inventory.list` | 背包道具列表 |
| | `character.inventory.use` | 使用道具 |
| **商城** | `character.shop.list` | 商品列表(含价格/限购) |
| | `character.shop.buy` | 购买商品 |
| | `character.wallet.info` | 星币余额/收支 |
| **每日** | `character.daily.tasks` | 今日任务列表 |
| | `character.daily.claim` | 领取任务奖励 |
| | `character.daily.streak` | 连续登录信息 |
| **记忆** | `character.memory.extract` | 异步提取记忆 |
| | `character.memory.clusters` | 返回簇数据 |
| **成就** | `character.achievement.list` | 成就列表 |
| | `character.achievement.check` | 检查成就 |

## 引擎模块

```
src/character/
  ├── character-engine.ts       # 主入口，组合所有子系统
  ├── attribute-engine.ts       # 通用属性 (mood/hunger/health/custom)
  ├── growth-system.ts          # 成长阶段 (intimacy/evolution)
  ├── persona-engine.ts         # LLM 人设管理 + prompt builder
  ├── skill-system.ts           # 领域追踪、领悟、属性 XP
  ├── learning-system.ts        # 课程计时、XP、碎片
  ├── achievement-system.ts     # 12 成就徽章
  ├── domain-system.ts          # 7 领域 + 5 属性 + 权重矩阵
  ├── memory-graph.ts           # 记忆图谱 (LLM 提取/合并/FTS)
  ├── level-system.ts           # 等级 (EXP/升级/奖励)
  ├── care-system.ts            # 养护 (喂食/玩耍/休息/治疗 + 冷却)
  ├── daily-task-system.ts      # 每日任务 (档位/条件/奖励池)
  ├── chat-eval-system.ts       # 聊天评估 (消息计数/LLM 评估)
  ├── inventory-system.ts       # 背包 (道具管理/使用)
  ├── shop-system.ts            # 商城 (商品/购买/限购/星币)
  ├── login-tracker.ts          # 登录追踪 (连续登录/在线时长)
  ├── event-bus.ts              # 类型化事件总线
  ├── presets.ts                # 默认配置
  └── index.ts                  # 公共 API 导出
```

## 数据持久化

JSON 文件位于 `~/.openclaw/store/character/`:

```
mood.json              — 心情属性状态
hunger.json            — 饱腹属性状态
health.json            — 健康属性状态
intimacy.json          — 成长点数
skill-system.json      — 领域数据、工具记录、已领悟技能
learning-system.json   — 课程、进度、历史
achievement-system.json — 成就解锁记录
memory-graph.json      — 记忆簇
level-system.json      — { exp, level, unlockedRewards }
inventory.json         — { items: [...], capacity }
daily-tasks.json       — { date, tasks, streak, lastLoginDate, counters }
chat-eval.json         — { msgCount, lastEvalAt, streak, recentMessages }
care-cooldowns.json    — { feed: timestamp, play: timestamp, ... }
wallet.json            — { coins, totalEarned, totalSpent }
shop-purchases.json    — { date, purchases: { itemId: count, ... } }
```

---

# 六、工具调用可视化（暂不实现）

| 工具类型 | 宠物动画 |
|---------|---------|
| web_search | 举起放大镜，四处张望 |
| code_execute | 在键盘上敲打 |
| file_read | 翻阅书本 |
| 思考中 (thinking) | 头顶冒 ... 或 💭 |
| 工具完成 | 竖大拇指 / 点头 |

实现：客户端监听 tool_event → 映射动画名 → CharacterRenderer 播放。

---

## 实现优先级

### P0 — 状态前缀注入 + 记忆图谱 ✅

1. ✅ `CharacterEngine.getPromptContext()` — 构建挡位片段
2. ✅ Gateway `agent:bootstrap` hook 注入 CHARACTER_STATE.md
3. ✅ 接通 `character.chat.canChat` + `character.chat.onMessage`
4. ✅ `MemoryGraphSystem` 全服务端架构
5. ✅ `after_tool_call` hook 全渠道技能记录
6. ✅ `message:sent` hook 全渠道自动记忆提取
7. ✅ 记忆提示语注入 getPromptContext()

### P1 — 双 Agent + 宠物专属 Tools

8. ✅ World Agent — 程序规则前置 + agentTurn 生成世界事件
9. ✅ Soul Agent — 程序规则前置 + agentTurn 角色自主决策
10. ✅ 宠物专属 Tools (character_self_care / character_remember / character_express_mood)
11. ✅ `message:received` hook 领域关键词推断（已实现）
12. ~~渠道人格微调~~ — 已删除

### P2 — 深度集成

13. ❌ Session 集成（时长 EXP / 任务计数）
14. ❌ World Agent 个性化每日任务生成
15. ❌ Soul Agent 人格阶段进化

---

## 集成全景图

```
                           用户对话 (前台)
                                │
                           Chat Session
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
    ┌─────┴─────┐         ┌────┴────┐          ┌─────┴─────┐
    │  Hook 系统  │         │ 前台AI  │          │ Channel 层 │
    └─────┬─────┘         └────┬────┘          └─────┬─────┘
          │                    │                     │
  ┌───────┼────────┐      SOUL.md +              渠道人格微调
  │       │        │      CHARACTER_STATE.md
after  bootstrap  msg
-tool    │      -rcv/-sent
  │      │        │
  ▼      ▼        ▼
┌─────────────────────────────────────────────────────┐
│              CharacterEngine (单例)                   │
│                                                     │
│  属性/等级/技能/记忆/成就/背包/商城/每日任务...        │
│                                                     │
│  worldEvents: WorldEvent[]  ← World Agent 写入       │
│                             → Soul Agent 消费        │
├─────────────────────────────────────────────────────┤
│                                                     │
│   ┌──────────────────┐    ┌──────────────────┐      │
│   │  World Agent      │    │  Soul Agent       │      │
│   │  (世界代理)        │    │  (灵魂代理)        │      │
│   │                  │    │                  │      │
│   │  cron: 每小时     │    │  cron: 每30min   │      │
│   │  session: 隔离    │    │  session: 隔离    │      │
│   │  delivery: none  │    │  delivery: announce│     │
│   │                  │    │                  │      │
│   │  程序规则过滤     │    │  程序规则过滤     │      │
│   │  ↓ 有事才调LLM   │    │  ↓ 有事才调LLM   │      │
│   │  ↓               │    │  ↓               │      │
│   │  生成: 事件/任务  │──→│  消费: 世界事件   │      │
│   │  /剧情/奖励      │    │  决策: 说话/行动  │      │
│   │                  │    │  /沉默           │      │
│   │  内置·不可见·     │    │  内置·不可见·     │      │
│   │  不可关闭        │    │  不可关闭        │      │
│   └──────────────────┘    └────────┬─────────┘      │
│                                    │                │
└────────────────────────────────────┼────────────────┘
                                     │
                                     ▼
                              客户端气泡/消息
                              (宠物主动冒泡)
```

---

## See also

- [核心循环](core-loop.md) — Token 经济模型、LLM 意图评估、数值平衡
- [经济与道具](economy.md) — 道具定义、星币货币
- [每日任务](daily-tasks.md) — 任务生成与完成检测
- [客户端交互](client-interaction.md) — 气泡规则、养成面板
