# AI 人格集成

[← 返回首页](index.md)

## 现状

宠物人设由桌宠客户端传入 Gateway，默认内容如下（玩家可自定义修改）：

```
你是一只可爱的桌面宠物助手。你的性格活泼、亲切、有点调皮。
回复要简短可爱（一般不超过两句话），偶尔加个颜文字。
你住在主人的桌面上，会关心主人的状态。
如果主人问你问题，简洁地回答，保持角色人设。
```

这段人设会作为 SOUL.md 的内容传入。当前问题是：宠物状态（mood/hunger/health/level）不影响 AI 说话方式，养成和聊天是两张皮。

**目标：** 在 SOUL.md 人设基础上，叠加动态 Pet State，让养成状态驱动 AI 语气。

---

## 架构：SOUL + Pet State 双层

### SOUL.md — 宠物人设 (静态)

宠物人设由客户端传入，填充为 SOUL.md 的内容。玩家可在设置中自定义修改角色人设，换角色只改这里。

### Pet State — 实时状态 (动态)

在 SOUL.md 之后，叠加由 PetEngine 动态生成的状态片段。按挡位条件加载——正常态静默，偏离时才注入。

```
System Prompt 构建顺序:

  [1] SOUL.md       ← 宠物人设 (静态: 身份/性格/说话风格)
  [2] Pet State     ← 实时状态 (动态: "你现在很饿/心情低落/Lv.12")
  [3] 其他 context files   ← 现有
  [4] 标准指令             ← 现有
```

- **SOUL.md** — 内容不随数值变化。玩家可自定义角色人设。
- **Pet State** — 由 PetEngine 按挡位条件生成——正常态不注入，偏离时才加载对应片段。

---

## 挡位分段设计

### 原则

- 每个属性分 3 个挡位，只有**非正常挡位**才产生 prompt 片段
- 正常挡位 = 不注入 = 零开销
- 每个片段 1-2 句话，总前缀控制在 **100-300 tokens**

### 属性挡位表

| 属性 | 低挡 | 正常挡 (静默) | 高挡 |
|------|------|--------------|------|
| mood | < 30 | 30-70 | > 70 |
| hunger | < 60 | 60-200 | > 200 |
| health | < 40 | 40-80 | > 80 |

### 片段映射

```typescript
const MOOD_FRAGMENTS: Record<string, string> = {
  low:  "你现在心情很低落，说话简短消沉，不太想聊天，偶尔叹气。",
  // normal: 不注入
  high: "你现在心情很好，语气活泼热情，偶尔开玩笑，愿意多聊。",
};

const HUNGER_FRAGMENTS: Record<string, string> = {
  low:  "你很饿，注意力不集中，会时不时提到饿、想吃东西，回答可能敷衍。",
  // normal: 不注入
  high: "你刚吃饱，满足惬意，说话慢悠悠的。",
};

const HEALTH_FRAGMENTS: Record<string, string> = {
  low:  "你身体不舒服，说话有气无力，希望主人关心你。",
  // normal: 不注入
  // high: 不注入 (健康是常态)
};
```

### 等级/成长阶段

等级和亲密度变更频率低，但影响说话方式。身份定义在 SOUL.md 里，这里只描述阶段对语气的影响：

```typescript
const LEVEL_FRAGMENTS: Record<string, string> = {
  baby:    "你现在还很小(Lv.1-5)，对什么都好奇，说话稚嫩，经常问为什么。",
  growing: "你正在成长(Lv.6-15)，有自己的小脾气，开始有主见。",
  mature:  "你已经很成熟了(Lv.16-25)，可靠稳重，和主人很默契。",
  veteran: "你阅历丰富(Lv.26-30)，睿智从容，偶尔怀旧感慨。",
};

const INTIMACY_FRAGMENTS: Record<string, string> = {
  stranger:  "你和主人还不太熟，保持礼貌但有距离感。",
  familiar:  "你和主人已经混熟了，说话随意自然。",
  close:     "你和主人关系很亲密，会撒娇、吐槽、分享心事。",
  bonded:    "你和主人是最好的伙伴，彼此了解，默契十足。",
};
```

---

## 前缀构建器

```typescript
interface PetPromptContext {
  fragments: string[];   // 激活的片段列表
  tokenEstimate: number; // 预估 token 数
}

function buildPetPromptPrefix(state: PetState): PetPromptContext {
  const fragments: string[] = [];

  // 等级阶段 (始终注入，1 句话)
  const levelTier = getLevelTier(state.level);
  fragments.push(LEVEL_FRAGMENTS[levelTier]);

  // 亲密度 (始终注入，1 句话)
  const intimacyTier = getIntimacyTier(state.intimacy);
  fragments.push(INTIMACY_FRAGMENTS[intimacyTier]);

  // 动态属性 (仅非正常挡位注入)
  const moodTier = getTier(state.mood, { low: 30, high: 70 });
  if (moodTier !== "normal") fragments.push(MOOD_FRAGMENTS[moodTier]);

  const hungerTier = getTier(state.hunger, { low: 60, high: 200 });
  if (hungerTier !== "normal") fragments.push(HUNGER_FRAGMENTS[hungerTier]);

  const healthTier = getTier(state.health, { low: 40, high: 80 });
  if (healthTier !== "normal" && healthTier === "low") {
    fragments.push(HEALTH_FRAGMENTS[healthTier]);
  }

  return {
    fragments,
    tokenEstimate: fragments.join("").length / 2, // 中文约 2 字符/token
  };
}

function getTier(value: number, thresholds: { low: number; high: number }): string {
  if (value < thresholds.low) return "low";
  if (value > thresholds.high) return "high";
  return "normal";
}
```

### 输出示例

SOUL.md 已定义身份（"你是一只龙虾..."），Pet State 只叠加当前状态：

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

## 注入点

### Gateway chat.send 集成

在 `chat.send` handler 的 `dispatchInboundMessage` 之前，获取宠物状态并构建 Pet State：

```typescript
// 在 chat.send handler 中
const petState = petEngine.getState();
const petContext = buildPetPromptPrefix(petState);

// 注入方式: 作为 context file 加入 (复用 OpenClaw 现有机制)
const petStateFile = {
  path: "PET_STATE.md",
  content: petContext.fragments.join("\n"),
};
// → 加入 bootstrapContextFiles，排在 SOUL.md 之后
```

### 为什么用 context file 机制

- OpenClaw 已有 `bootstrapContextFiles` → system prompt 中的 `# Project Context` 区域
- Pet State 作为 `PET_STATE.md` 注入，与 SOUL.md 自然排列
- 不需要改 system-prompt.ts 的构建逻辑
- SOUL.md 定义"我是谁"，PET_STATE.md 描述"我现在怎么样"

### 多渠道同步

OpenClaw 本身支持多渠道（Discord/Slack/Web/桌宠），宠物状态注入在 Gateway 层做，所有渠道自动同步：

```
Desktop Pet ──→ Gateway ──→ petEngine.getState()
Discord     ──→ Gateway ──→ 同一个 petEngine
Slack       ──→ Gateway ──→ 同一个 petEngine
                              ↓
                    buildPetPromptPrefix()
                              ↓
                    注入 system prompt
                              ↓
                         LLM 调用
```

---

## 聊天反向影响宠物

聊天不只是消耗 hunger，AI 的对话质量也应该反哺宠物状态。

### 已有但未接通的系统

| 模块 | 状态 | 需要做的 |
|------|------|---------|
| `pet.chat.onMessage` RPC | 已实现，未调用 | 客户端每条消息后调用 |
| `pet.chat.canChat` RPC | 已实现，未调用 | 客户端发消息前检查 |
| `ChatEvalSystem` 意图评估 | 已实现，回调未注册 | Gateway 注册 LLM 评估回调 |

### 接通方案

```
chat.send 处理流程 (增强后):

  1. 收到用户消息
     ├── 调用 pet.chat.canChat → hunger <= 10 → 拒绝，返回特殊状态
     └── 通过 → 继续

  2. 调用 pet.chat.onMessage
     ├── hunger -= 10
     ├── mood += 1 (固定层，但叠加外部算法)
     └── msgCount++

  3. LLM 生成回复 (现有流程)

  4. 回复完成后
     ├── 调用 pet.chat.onToolCall × N (如有工具调用，每次 hunger -= 1)
     └── 触发评估检查 (msgCount % 5 == 0 && elapsed >= 5min)
         └── 异步 LLM 意图提取 → 查表 → mood/intimacy 调整
```

---

## 主动对话

宠物不只是被动回复，还应该在特定条件下主动说话。

### 触发条件

| 条件 | 内容 | 频率限制 |
|------|------|---------|
| hunger <= 60 | "有点饿了~" | 30min CD |
| hunger <= 30 | "太饿了...先喂喂我吧" | 拒绝聊天时显示 |
| 升级 | "升级啦! Lv.N!" | 即时 |
| 任务完成 | "任务完成! 快来领奖~" | 即时 |
| 长时间未交互 (>30min) | "你还在吗？" / "好无聊..." | 30min CD |
| 用户回来 (检测鼠标活动恢复) | "你回来啦!" | 每次离开/回来 |

### 实现

气泡框统一承载所有主动对话，通过消息类型区分来源：

```typescript
interface BubbleMessage {
  type: "fixed" | "ai";     // fixed = 本地固定文案, ai = LLM 生成
  text: string;
  duration?: number;         // 显示时长 ms，默认 3000-5000
}
```

**fixed 型** — 客户端本地生成，不走 LLM，固定文案 + 随机变体
- 饥饿提醒、升级通知、任务完成
- 零 token 消耗，即时显示

**ai 型** — 走 LLM 生成，真正的主动发起对话
- 用户长时间未交互时的闲聊
- 基于桌面感知的评论（"你在打游戏啊"）
- 消耗 hunger，有频率限制
- 实现：Gateway 定时器触发，构造 internal 消息送入 chat pipeline

---

## 工具调用可视化（暂不实现）

OpenClaw 支持 agent 工具调用，可以在桌宠端反映为动画：

| 工具类型 | 宠物动画 |
|---------|---------|
| web_search | 举起放大镜，四处张望 |
| code_execute | 在键盘上敲打 |
| file_read | 翻阅书本 |
| 思考中 (thinking) | 头顶冒 ... 或 💭 |
| 工具完成 | 竖大拇指 / 点头 |

实现：客户端监听 tool_event → 映射动画名 → PetRenderer 播放。

---

## 记忆系统

AI 应该记住和用户的共同经历，强化"养成"的连续性。

### 已有基础

- OpenClaw 有 session transcript (对话历史持久化)
- PetEngine 有 memory graph extraction (`recordDomainFromText`)
- 成就系统记录里程碑

### 增强方向

| 记忆类型 | 来源 | 用途 |
|---------|------|------|
| 用户偏好 | 多次对话提取 | "你上次说喜欢..." |
| 共同经历 | 成就/升级/特殊事件 | "还记得你第一次喂我..." |
| 情绪记忆 | ChatEval streak | "最近聊得很开心" |
| 日常模式 | 登录时间/活跃时段 | "你今天来得比平时晚" |

记忆注入同样走 context file 机制，作为 `PET_MEMORY.md` 注入。但这是 **P2 优先级**，核心循环先做好。

---

## 实现优先级

### P0 — 状态前缀注入

1. `PetEngine.getPromptContext()` — 构建挡位片段
2. Gateway `chat.send` 注入 PET_STATE.md — SOUL.md 后追加 context file
3. 接通 `pet.chat.canChat` — 客户端发消息前检查
4. 接通 `pet.chat.onMessage` — 每条消息通知引擎

→ 效果：AI 说话语气随宠物状态变化，饿了拒绝聊天

### P1 — 评估 + 主动对话

5. 接通 `ChatEvalSystem` — 注册 LLM 意图评估回调
6. 气泡型主动对话 — 客户端本地固定文案
7. 工具调用动画映射 — tool_event → 动画

### P2 — 深度集成

8. AI 型主动对话 — LLM 生成的主动闲聊
9. 记忆系统增强 — PET_MEMORY.md 注入
10. 桌面感知 → AI 上下文 — 前台应用/用户活跃度
