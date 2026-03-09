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
     ├── 调用 character.chat.canChat → hunger <= 10 → 拒绝
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

| 条件 | 内容 | 频率限制 |
|------|------|---------|
| hunger <= 60 | "有点饿了~" | 30min CD |
| hunger <= 30 | "太饿了...先喂喂我吧" | 拒绝聊天时 |
| 升级 | "升级啦! Lv.N!" | 即时 |
| 任务完成 | "任务完成! 快来领奖~" | 即时 |
| 长时间未交互 (>30min) | "你还在吗？" / "好无聊..." | 30min CD |
| 用户回来 | "你回来啦!" | 每次离开/回来 |

**fixed 型** — 客户端本地固定文案，零 token 消耗
**ai 型** — LLM 生成的主动闲聊，消耗 hunger，有频率限制

---

# 三、记忆图谱 — 全服务端架构 (Done)

AI 通过记忆图谱记住用户的偏好、项目、习惯等长期信息，强化养成的连续性。

## 架构

```
对话完成 (任意渠道)
  → message-sent hook / characterRPC('character.memory.extract', {userMsg, aiReply})
  → Gateway: MemoryGraphSystem.enqueueExtraction()     ← 去抖 3s
    → petLLMComplete(prompt)                           ← 服务端直接调 LLM API
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

可优化：CHARACTER_STATE.md 中追加一句 `"你可以用 memory_search 回忆和主人相关的事情，让对话更有连续感。"`

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
| LLM 调用 | `petLLMComplete()` → 读 OpenClaw config 的 provider | `character.ts` |
| 记忆索引 | `MemoryGraphSystem` → `getMemorySearchManager()` SQLite FTS | `character.ts` |
| 文件持久化 | PersistenceStore → `resolveStateDir()` | `character.ts` |

**未利用的 OpenClaw 能力:** Hook 系统（仅用 1/10+）、Cron 调度、Tools Catalog、Channel 系统、Session 系统。

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

## Cron 调度 — 主动对话与定时任务

复用 OpenClaw Cron（持久化、miss-fire 补偿、重启不丢失）：

```typescript
function registerCharacterCronJobs() {
  const cronService = getCronService();

  // 每日任务刷新 — 每天 0:00
  cronService.addInternal({
    id: "character:daily-reset",
    rule: "every day 0:00",
    handler: () => {
      engine.dailyTaskSystem.reset();
      engine.loginTracker.checkLogin();
    },
  });

  // 主动对话检查 — 每 30 分钟
  cronService.addInternal({
    id: "character:proactive-chat",
    rule: "every 30min",
    handler: () => {
      const state = engine.getFullState();
      const bubble = evaluateProactiveBubble(state);
      if (bubble) broadcastToClients("character:bubble", bubble);
    },
  });

  // 饥饿提醒 — 每小时
  cronService.addInternal({
    id: "character:hunger-alert",
    rule: "every 1h",
    handler: () => {
      const hunger = engine.getAttribute("hunger");
      if (hunger.value <= 60) {
        broadcastToClients("character:bubble", {
          type: "fixed",
          text: hunger.value <= 30 ? "太饿了...先喂喂我吧" : "有点饿了~",
        });
      }
    },
  });
}
```

| 维度 | setInterval (现有) | OpenClaw Cron |
|------|-------------------|---------------|
| 重启后恢复 | 丢失 | 自动恢复 |
| Miss-fire 补偿 | 无 | 内建 |
| 持久化 | 无 | JSON 存储 |
| 可观测 | 无 | `cron.list` / `cron.runs` RPC |

**属性衰减仍用 tick loop**（秒级精度），主动对话/任务刷新改用 Cron。

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

---

## 跨渠道人格

所有渠道共享同一个 CharacterEngine 实例，状态天然同步。但增加渠道维度微调：

```typescript
const CHANNEL_HINTS: Record<string, string> = {
  "desktop-pet": "", // 桌宠端不加限制，最自然
  "discord":     "你现在在群聊中，说话简洁一些，不要太撒娇。",
  "slack":       "你现在在工作频道，保持专业但友好。",
  "telegram":    "你现在在私聊，可以随意一些。",
};
```

---

## Session 集成

```typescript
registerInternalHook("session-end", (event) => {
  const { sessionKey, messageCount, duration } = event.context;
  const engine = getEngineIfReady();
  if (!engine) return;

  engine.dailyTaskSystem.addProgress("chat_minutes", Math.floor(duration / 60000));
  const baseExp = Math.min(messageCount * 2, 50);
  engine.levelSystem.addExp(baseExp, "session_complete");
});
```

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

1. `CharacterEngine.getPromptContext()` — 构建挡位片段
2. Gateway `agent:bootstrap` hook 注入 CHARACTER_STATE.md
3. 接通 `character.chat.canChat` + `character.chat.onMessage`
4. `MemoryGraphSystem` 全服务端架构
5. `after-tool-call` hook 全渠道技能记录

### P1 — Cron 主动对话 + 领域推断

6. Cron 注册宠物定时任务 (每日刷新/主动对话/饥饿提醒)
7. `message-received` hook 领域关键词推断
8. 渠道人格微调

### P2 — AI 自主体

9. 宠物专属 Tools (character_self_care / character_remember / character_express_mood)
10. Session 集成（时长 EXP / 任务计数）

---

## 集成全景图

```
                        OpenClaw Gateway
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    ┌─────┴─────┐     ┌──────┴──────┐     ┌──────┴──────┐
    │  Hook 系统  │     │  Cron 调度  │     │  Channel 层  │
    └─────┬─────┘     └──────┬──────┘     └──────┬──────┘
          │                  │                   │
  ┌───────┼────────┐    ┌────┼────┐         渠道人格微调
  │       │        │    │    │    │
after  bootstrap  msg  daily proactive  hunger
-tool    │       -sent reset  chat     alert
  │      │        │    │      │        │
  ▼      ▼        ▼    ▼      ▼        ▼
┌─────────────────────────────────────────────┐
│           CharacterEngine (单例)              │
│                                             │
│  SkillSystem  ←── 工具自动记录 + 领域推断     │
│  MemoryGraph  ←── 自动提取 + 对话时召回       │
│  ChatEval     ←── 意图评估                   │
│  CareSystem   ←── AI 自主调用宠物工具         │
│  DailyTask    ←── Cron 刷新                  │
│  LevelSystem  ←── 会话完成 EXP               │
│                                             │
│  getPromptContext(channelType?)              │
│    → CHARACTER_STATE.md (挡位片段)            │
│    → CHARACTER_TOOLS (自主操作工具)            │
└─────────────────────────────────────────────┘
```

---

## See also

- [核心循环](core-loop.md) — Token 经济模型、LLM 意图评估、数值平衡
- [经济与道具](economy.md) — 道具定义、星币货币
- [每日任务](daily-tasks.md) — 任务生成与完成检测
- [客户端交互](client-interaction.md) — 气泡规则、养成面板
