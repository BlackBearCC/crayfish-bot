# 核心经济模型 + LLM 评估 + 数值平衡

> 更新: 2026-03-09

[← 返回首页](index.md)

## Token 即饱腹

聊天消耗 token → 映射为 **hunger 下降**。喂食 = 补充 token = 恢复饱腹。

```typescript
const HUNGER_MAX = 300;
const CHAT_HUNGER_COST = 10;
const MIN_HUNGER_TO_CHAT = 30;
// 设计目标: 满饱腹出发，20 轮聊天(~30min) 后剩余 ~30%
// 300 - 20*10 - 0.3*30 = 91 ≈ 30%
```

- 每条用户消息 → hunger -10
- hunger <= 30 → 拒绝聊天，气泡"太饿了...先喂喂我吧"
- 工具调用 → 额外 hunger -1

---

## 两层系统

```
第一层: 固定程序数值 (每次交互立即生效)
  click → mood +3, intimacy +1
  longpress → mood +15, intimacy +5
  feed → hunger +35, mood +20, intimacy +10
  chat → mood +1 (基础值，每条消息固定给)
  file_drop → mood +5, intimacy +8

第二层: LLM 意图提取 (5轮一次，最小间隔 5 分钟，异步叠加)
  LLM 分析最近对话 → 输出意图标签 → 程序查表 + 连续性加成
```

两层独立运行、效果叠加。LLM 掉线不影响基础数值。

---

## LLM 意图识别

### 流程

```
用户发消息 → msgCount++
        ↓
msgCount % 5 == 0 且 距上次评估 >= 5min ?
        ↓ 两者都满足
组装 prompt (最近对话摘要)
        ↓
调用 LLM → 返回意图标签
        ↓
程序查意图-效果表 → 计算连续性加成 → adjust
```

单次 LLM 调用处理所有状态 (mood / intimacy / 未来扩展)。

### 意图类型

```typescript
type ChatIntent =
  | "praise"        // 夸奖/肯定
  | "deep_talk"     // 深度交流/谈心
  | "playful"       // 调皮/玩闹
  | "gratitude"     // 感谢
  | "cold"          // 冷漠/敷衍/纯工具性指令
  | "impatient"     // 不耐烦/催促
  | "angry"         // 骂人/发火
  | "sad_share"     // 分享负面情绪 (信任宠物)
  | "neutral";      // 普通工作对话
```

### 评估 Prompt

```
你是对话意图分类器。从预定义类别中选择最匹配的意图。

预定义意图:
- praise: 用户夸奖、肯定
- deep_talk: 深度交流、情感倾诉
- playful: 调皮、玩闹
- gratitude: 表达感谢
- cold: 冷漠、纯指令式对话
- impatient: 不耐烦、催促
- angry: 骂人、攻击性语言
- sad_share: 用户分享负面情绪，但信任宠物
- neutral: 普通工作对话

最近对话:
{recentMessages}

只输出 JSON:
{"intent": "<意图标签>"}
```

### 意图-效果查表

```typescript
const INTENT_EFFECTS: Record<ChatIntent, { mood: number; intimacy: number }> = {
  praise:     { mood: +5,  intimacy: +3 },
  deep_talk:  { mood: +3,  intimacy: +5 },
  playful:    { mood: +6,  intimacy: +2 },
  gratitude:  { mood: +4,  intimacy: +4 },
  cold:       { mood: -2,  intimacy: 0  },
  impatient:  { mood: -4,  intimacy: -1 },
  angry:      { mood: -6,  intimacy: -2 },
  sad_share:  { mood: -1,  intimacy: +4 },
  neutral:    { mood: +1,  intimacy: +1 },
};
```

### 连续性二次函数

```typescript
// 效果倍率 = 1 + 0.15 * (streak - 1)^2，上限 3.0
// streak=1 → x1.0 | streak=2 → x1.15 | streak=3 → x1.6 | streak=4 → x2.35 | streak=5 → x3.0
function streakMultiplier(streak: number): number {
  if (streak <= 1) return 1.0;
  return Math.min(3.0, 1 + 0.15 * Math.pow(streak - 1, 2));
}
// 方向判定: mood > 0 正面, < 0 负面, == 0 不计入
// 方向翻转时 streak 重置为 1
```

### 完整处理流程

```typescript
let lastEvalAt = 0;
let msgCount = 0;
let streak = 0;
let lastDirection: "positive" | "negative" | null = null;

function onUserMessage(): void {
  msgCount++;
  if (msgCount % 5 !== 0) return;
  if (Date.now() - lastEvalAt < 5 * 60 * 1000) return;
  triggerEval();
}

function triggerEval(): void {
  lastEvalAt = Date.now();
  callLLM(buildEvalPrompt(getRecentMessages())).then(result => {
    const intent = INTENT_EFFECTS[result.intent] ? result.intent : "neutral";
    const base = INTENT_EFFECTS[intent];
    const direction = base.mood > 0 ? "positive" : base.mood < 0 ? "negative" : null;
    if (direction && direction === lastDirection) { streak++; }
    else { streak = 1; lastDirection = direction; }
    const m = streakMultiplier(streak);
    const clampedMood = Math.max(-15, Math.min(15, Math.round(base.mood * m)));
    const clampedIntimacy = Math.max(-5, Math.min(12, Math.round(base.intimacy * m)));
    engine.attributes.adjust("mood", clampedMood);
    if (clampedIntimacy > 0) engine.growth.gain(clampedIntimacy);
    engine.bus.emit("chat:eval", { intent, moodDelta: clampedMood, intimacyDelta: clampedIntimacy, streak });
  }).catch(() => { /* LLM 失败，静默跳过 */ });
}
```

### 效果示例

```
场景 A: 连续夸宠物 (praise x4)
  第1次: mood +5, intimacy +3  (x1.0)
  第2次: mood +6, intimacy +3  (x1.15)
  第3次: mood +8, intimacy +5  (x1.6)
  第4次: mood +12, intimacy +7 (x2.35)

场景 B: 持续发火 (angry x3)
  第1次: mood -6, intimacy -2  (x1.0)
  第2次: mood -7, intimacy -2  (x1.15)
  第3次: mood -10, intimacy -3 (x1.6)

场景 C: 骂完道歉 (angry → gratitude)
  angry:    mood -6 (streak=1)
  gratitude: mood +4 (streak 重置=1)
```

---

## 数值平衡

### Hunger 消耗/恢复

```
消耗:
  - 时间衰减: 0.3/min (降低，因为聊天已在大量消耗)
  - 聊天: 每条消息 -10
  - 工具调用: 额外 -1
  - 玩耍: 无限非概率逗猫器 -5, 捉迷藏 -8, 晒太阳 -2

恢复:
  - 42号口粮: +75 (免费, CD 20min)
  - 巴别鱼罐头: +45 (道具)
  - 泛银河爆破饮: +120 (道具)
  - 不要恐慌胶囊: +30 (道具)
```

### 等级衰减系数

```
实际衰减 = 基础衰减 × 等级系数
  Lv.1-10:  1.0
  Lv.11-15: 0.85
  Lv.16-20: 0.75
  Lv.21-25: 0.70
  Lv.26-30: 0.60
```

### 离线保护

```
  - 离线衰减上限: 4h (替代 8h)
  - 离线底线: mood/health >= 20; hunger >= 60
  - 离线期间 hunger 仅按时间衰减 (无聊天消耗)
  - Lv.16+ "自动照顾": mood/health >= 35, hunger >= 90
  - Lv.26+ 离线衰减上限降至 2h
```

### 被动恢复 (在线时)

```
  - mood >= 78 (joyful): health +0.1/min
  - hunger >= 225 (full): mood +0.05/min
  - health >= 70 + mood >= 52: 时间衰减 -20%
```

---

## See also

- [经济与道具](economy.md) — 道具恢复量、商城价格、经济平衡
- [等级系统](level-system.md) — 等级衰减系数来源
- [AI 系统](ai-system.md) — 挡位片段注入 prompt 的完整架构
- [每日任务](daily-tasks.md) — 任务奖励 EXP/星币
