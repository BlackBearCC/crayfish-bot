# 宠物养成系统设计文档

> 版本: v2.0 | 日期: 2026-03-07

## 一、现状问题分析

### 当前引擎拥有的系统

| 系统 | 状态 | 问题 |
|------|------|------|
| 属性系统 (mood/hunger/health) | 有衰减，值域 0-100 | 只降不升，无主动恢复手段 |
| 成长系统 (intimacy) | 只增不减，驱动阶段进化 | 仅靠交互获取，无养成感 |
| 技能系统 (5维属性+7领域) | 通过对话/工具使用积累 XP | 与养成脱节，无法影响宠物状态 |
| 学习系统 (课程+碎片) | 在线计时，完成得 XP | 独立封闭，不影响核心循环 |
| 成就系统 (12枚徽章) | 条件检测 + 解锁 | 奖励仅是亲密度，无实质激励 |

### 核心缺失

1. **数值只降不升** — mood 0.4/min、hunger 0.6/min 持续衰减，interact 给的恢复量杯水车薪，离线8小时后数值见底
2. **没有宠物等级** — intimacy 的阶段（幼猫 -> 朋友 -> 亲密伙伴 -> 心灵契合）更像关系阶段，不是成长等级
3. **没有养成循环** — 用户无法通过"照顾"行为获得正反馈，缺乏核心 loop

---

## 二、核心经济模型

### 2.1 Token 即饱腹

聊天消耗 token，token 消耗映射为**饱腹值 (hunger) 下降**。喂食 = 补充 token = 回复饱腹。

```
┌──────────────────────────────────────────────────┐
│                  核心循环                          │
│                                                    │
│   喂食(补充 token)  ─→  饱腹值上升                  │
│         ↑                    ↓                     │
│     获得食物道具         聊天消耗 token              │
│         ↑                    ↓                     │
│     每日任务/升级       饱腹值下降 + 亲密度/心情变化   │
│         ↑                    ↓                     │
│      EXP 增长  ←─── LLM 评估(每5条) ──→ mood/intimacy │
└──────────────────────────────────────────────────┘
```

**设计意图:** 聊天本身是有"成本"的（消耗饱腹/token），但也是有"收益"的（亲密度和心情由 LLM 评估）。用户需要通过喂食来维持宠物的"聊天能力"，形成自然的养成循环。

### 2.2 聊天消耗规则

```typescript
// hunger 上限 300 (非默认的 100)
const HUNGER_MAX = 300;
// 每条用户消息消耗的 hunger
const CHAT_HUNGER_COST = 10;
// hunger <= 30 时，宠物拒绝聊天（太饿了说不动话）
const MIN_HUNGER_TO_CHAT = 30;
// 设计目标: 满饱腹出发，20 轮聊天(~30min) 后剩余 ~30%
// 300 - 20*10 - 0.3*30 = 91 ≈ 30%
```

- 用户每发一条消息 -> hunger -10
- 当 hunger <= 30 时，宠物气泡提示"太饿了...先喂喂我吧"，拒绝回复
- 工具调用额外消耗 hunger -1

### 2.3 LLM 对话状态提取 + 程序侧二次函数处理

**两层系统叠加作用:**

```
第一层: 固定程序数值 (每次交互立即生效)
  click → mood +3, intimacy +1
  longpress → mood +15, intimacy +5
  feed → hunger +35, mood +20, intimacy +10
  chat → mood +1 (基础值，每条消息固定给)
  file_drop → mood +5, intimacy +8

第二层: LLM 意图提取 (用户输入计数，5轮一次，最小间隔 5 分钟，异步叠加)
  LLM 分析最近对话 → 输出意图标签 → 程序查表 + 连续性加成
```

两层独立运行、效果叠加。LLM 掉线不影响基础数值，程序数值保底。

#### 架构: LLM 只做意图识别

LLM 不输出任何数值，只输出**意图标签**。程序根据标签查表执行。

```
用户发消息 → 聊天正常进行 → 用户输入计数 msgCount++
                ↓
        msgCount % 5 == 0 且 距上次评估 >= 5min ?
        (双条件: 每5轮 + 最小间隔5分钟)
                ↓ 两者都满足
        组装 prompt (最近对话摘要)
                ↓
        调用 LLM → 返回意图标签
                ↓
        程序查意图-效果表 → 计算连续性加成 → adjust
```

**单次 LLM 调用处理所有状态**(mood / intimacy / 未来扩展的状态)，不为每个属性单独调用。

#### 意图类型定义

```typescript
// LLM 只能输出以下预定义意图，程序不接受任何自定义意图
type ChatIntent =
  | "praise"        // 用户夸奖/肯定宠物
  | "deep_talk"     // 深度交流/情感倾诉/谈心
  | "playful"       // 调皮/玩闹/开玩笑
  | "gratitude"     // 感谢/感恩
  | "cold"          // 冷漠/敷衍/纯工具性指令
  | "impatient"     // 不耐烦/催促
  | "angry"         // 骂人/发火/攻击性语言
  | "sad_share"     // 分享负面情绪/倾诉烦恼 (用户难过但信任宠物)
  | "neutral";      // 普通工作对话/无明显情感倾向
```

#### LLM 评估 Prompt

```
你是对话意图分类器。根据最近的对话内容，从预定义类别中选择最匹配的意图。

预定义意图:
- praise: 用户夸奖、肯定、说"你真棒"等
- deep_talk: 深度交流、情感倾诉、谈心事
- playful: 调皮、玩闹、开玩笑
- gratitude: 表达感谢
- cold: 冷漠、敷衍、纯指令式对话(如"翻译这段""总结一下")
- impatient: 不耐烦、催促、"快点""怎么这么慢"
- angry: 骂人、发火、攻击性语言
- sad_share: 用户分享负面情绪(难过/焦虑)，但信任宠物愿意倾诉
- neutral: 普通工作对话，无明显情感倾向

最近对话:
{recentMessages}

只输出 JSON:
{"intent": "<意图标签>"}
```

#### 意图-效果查表 (程序硬编码，LLM 不可修改)

```typescript
// 每种意图对应的基础效果值
const INTENT_EFFECTS: Record<ChatIntent, { mood: number; intimacy: number }> = {
  praise:     { mood: +5,  intimacy: +3 },
  deep_talk:  { mood: +3,  intimacy: +5 },
  playful:    { mood: +6,  intimacy: +2 },
  gratitude:  { mood: +4,  intimacy: +4 },
  cold:       { mood: -2,  intimacy: 0  },
  impatient:  { mood: -4,  intimacy: -1 },
  angry:      { mood: -6,  intimacy: -2 },
  sad_share:  { mood: -1,  intimacy: +4 },  // 用户难过但愿意倾诉=信任
  neutral:    { mood: +1,  intimacy: +1 },
};
```

#### 连续性二次函数加成

连续出现同方向意图时，效果递增(正面越来越开心，负面越来越伤心):

```typescript
// streak: 连续同方向次数 (正面连续 or 负面连续)
// 效果倍率 = 1 + 0.15 * (streak - 1)^2，上限 3.0
//
// streak=1 → x1.0  (首次，原始值)
// streak=2 → x1.15 (第二次连续)
// streak=3 → x1.6  (第三次连续)
// streak=4 → x2.35 (第四次连续)
// streak=5 → x3.0  (封顶)

function streakMultiplier(streak: number): number {
  if (streak <= 1) return 1.0;
  return Math.min(3.0, 1 + 0.15 * Math.pow(streak - 1, 2));
}

// 方向判定: mood 基础值 > 0 为正面，< 0 为负面，== 0 不计入连续
// 方向翻转时 streak 重置为 1
```

#### 完整处理流程

```typescript
// 状态
let lastEvalAt = 0;
let msgCount = 0;
let streak = 0;
let lastDirection: "positive" | "negative" | null = null;

// 每条用户消息后调用
function onUserMessage(): void {
  msgCount++;
  if (msgCount % 5 !== 0) return;                          // 每 5 轮才检查
  if (Date.now() - lastEvalAt < 5 * 60 * 1000) return;    // 最小间隔 5min
  triggerEval();
}

function triggerEval(): void {
  lastEvalAt = Date.now();

  // 调用 LLM (异步，不阻塞聊天)
  const recentMessages = getRecentMessages();
  callLLM(buildEvalPrompt(recentMessages)).then(result => {
    // 3. 解析意图，不在预定义列表中则 fallback 为 neutral
    const intent = INTENT_EFFECTS[result.intent] ? result.intent : "neutral";

    // 4. 查表得到基础效果
    const base = INTENT_EFFECTS[intent];

    // 5. 计算连续性方向
    const direction = base.mood > 0 ? "positive" : base.mood < 0 ? "negative" : null;
    if (direction && direction === lastDirection) {
      streak++;
    } else {
      streak = 1;
      lastDirection = direction;
    }

    // 6. 应用二次函数倍率
    const multiplier = streakMultiplier(streak);
    const finalMood = Math.round(base.mood * multiplier);
    const finalIntimacy = Math.round(base.intimacy * multiplier);

    // 7. Clamp 安全上限 (单次最大影响)
    const clampedMood = Math.max(-15, Math.min(15, finalMood));
    const clampedIntimacy = Math.max(-5, Math.min(12, finalIntimacy));

    // 8. 执行调整
    engine.attributes.adjust("mood", clampedMood);
    if (clampedIntimacy > 0) engine.growth.gain(clampedIntimacy);
    // intimacy 负值: 亲密度只增不减，但 streak 重置

    // 9. 发出事件供 UI 展示
    engine.bus.emit("chat:eval", { intent, moodDelta: clampedMood, intimacyDelta: clampedIntimacy, streak });
  }).catch(() => {
    // LLM 调用失败，静默跳过
  });
}
```

#### 连续性效果示例

```
场景 A: 用户连续夸宠物 (praise x4)
  第1次: mood +5, intimacy +3        (x1.0)
  第2次: mood +6, intimacy +3        (x1.15)
  第3次: mood +8, intimacy +5        (x1.6)
  第4次: mood +12, intimacy +7       (x2.35)
  → 宠物越来越开心，形成正反馈

场景 B: 用户持续发火 (angry x3)
  第1次: mood -6, intimacy -2        (x1.0)
  第2次: mood -7, intimacy -2        (x1.15)
  第3次: mood -10, intimacy -3       (x1.6)
  → 宠物越来越伤心，用户需要转变态度

场景 C: 骂完之后道歉 (angry → gratitude)
  angry:    mood -6, intimacy -2     (streak=1)
  gratitude: mood +4, intimacy +4   (streak 重置=1，重新开始)
  → 方向翻转，streak 归1，不会延续负面加成
```

#### 设计要点

- **LLM 只做分类，不做数值决策**: 输出一个意图标签，程序查表执行
- **一次调用覆盖所有状态**: mood + intimacy + 未来扩展字段，一个 prompt 搞定
- **最小间隔 5 分钟**: 控制 LLM 调用成本
- **固定交互奖励依然存在**: click/longpress/feed 等的固定数值不受影响，LLM 评估是叠加层
- **二次函数惩奖**: 连续正面加速开心，连续负面加速伤心，翻转则重置
- **安全兜底**: 未知意图 fallback 为 neutral; LLM 失败静默跳过; clamp 保底

---

## 三、宠物等级系统

### 3.1 等级定义

宠物拥有一个统一的 **等级 (Lv.1 ~ Lv.30)**，代表整体成长。

| 等级段 | 称号 | 解锁内容 |
|--------|------|----------|
| 1-5 | 小萌新 | 基础功能 |
| 6-10 | 小帮手 | Lv.6 自动提醒喂食; Lv.8 新待机动画 |
| 11-15 | 好伙伴 | Lv.11 衰减速度 -15%; Lv.13 新互动动作 |
| 16-20 | 老搭档 | Lv.16 自动照顾(离线属性不低于35); Lv.18 新外观 |
| 21-25 | 灵魂伴侣 | Lv.21 衰减速度 -30%; Lv.23 专属表情 |
| 26-30 | 传说之猫 | Lv.26 离线衰减上限减半; Lv.30 终极外观进化 |

### 3.2 经验值来源

```
总 EXP = 聊天 EXP + 养护 EXP + 任务 EXP + 成就 EXP
```

| 来源 | 获取方式 | EXP |
|------|----------|-----|
| 聊天 | 每次 LLM 状态评估触发时(>=5min 间隔) | +5 |
| 喂食 | 使用食物道具 | +5 |
| 玩耍 | 执行玩耍动作 | +4 |
| 学习完成 | 完成一节课 | +15 |
| 每日任务 | 完成任务领取奖励 | 按难度档位 |
| 连续登录 | 连续 N 天在线 | +5 x N (上限 +50) |
| 成就解锁 | 每解锁一个成就 | +25 |

### 3.3 升级经验表

```typescript
const LEVEL_EXP = [
  0,     // Lv.1
  50,    // Lv.2
  120,   // Lv.3
  220,   // Lv.4
  360,   // Lv.5
  550,   // Lv.6
  800,   // Lv.7
  1120,  // Lv.8
  1520,  // Lv.9
  2000,  // Lv.10
  2600,  // Lv.11
  3300,  // Lv.12
  4100,  // Lv.13
  5000,  // Lv.14
  6000,  // Lv.15
  7200,  // Lv.16
  8600,  // Lv.17
  10200, // Lv.18
  12000, // Lv.19
  14000, // Lv.20
  16500, // Lv.21
  19500, // Lv.22
  23000, // Lv.23
  27000, // Lv.24
  31500, // Lv.25
  36500, // Lv.26
  42000, // Lv.27
  48000, // Lv.28
  55000, // Lv.29
  63000, // Lv.30
];
```

设计意图: 前10级快速升(1-2天)，中间段稳定(每级2-3天)，高等级需要持续陪伴(每级4-5天)。

---

## 四、喂食系统 (Token 补充)

### 4.1 食物 = Token 充值

喂食的核心意义是**补充 token（饱腹值）**，让宠物能继续聊天。

| 食物 | 饱腹(token)恢复 | 约等于消息数 | 心情附加 | 健康附加 | 获取方式 |
|------|-----------------|-------------|----------|----------|----------|
| 42号口粮 | +75 | ~8条 | +3 | - | 免费，无限使用，冷却 20min |
| 巴别鱼罐头 | +45 | ~5条 | +12 | - | 每日任务奖励 |
| 泛银河爆破饮 | +120 | ~12条 | +8 | +5 | 升级奖励 / 成就奖励 |
| 不要恐慌胶囊 | +30 | ~3条 | +5 | +15 | 连续登录奖励 |

**设计要点:**
- 42号口粮免费保底 (+75, ~8条消息)，用户永远能喂食，不会被卡死
- 高级食物给更多 token + 附加效果，通过任务/成就获得
- 冷却机制防止无限刷 token，但 20min 间隔足够宽松
- 上限 300，满饱腹可支撑 ~28 条消息(不含时间衰减)

### 4.2 饱腹值经济计算

```
hunger 上限: 300
聊天: 每条消息 -10，工具调用额外 -1
时间衰减: 0.3/min

满饱腹 (300) 出发:
  → 20 轮聊天 (~30min): 消耗 200+9 = 209, 剩余 91 (30%)  ✓ 设计目标
  → 中途喂一次猫粮 (+75): 可延长 ~8 条

42号口粮 (CD 20min, +75):
  → 支撑 ~8 条消息
  → 20min 内用户通常发 5-10 条
  → 轻度聊天: 口粮基本够用
  → 重度聊天: 搭配巴别鱼罐头(+45)/泛银河爆破饮(+120) 补充
```

---

## 五、玩耍 / 休息 / 治疗

### 5.1 玩耍 (Play)

主要恢复心情，消耗少量饱腹。

| 动作 | 心情恢复 | 饱腹消耗 | 亲密度 | 触发方式 |
|------|----------|----------|--------|----------|
| 抚摸 | +8 | - | +2 | 长按宠物 (已有 longpress) |
| 无限非概率逗猫器 | +15 | -5 | +5 | 右键菜单 -> 玩耍 |
| 捉迷藏 | +20 | -8 | +8 | 宠物跑到屏幕随机位置，用户点击 |
| 晒太阳 | +10 | -2 | +3 | 拖拽到屏幕顶部边缘 |

### 5.2 休息 (Rest)

当健康值偏低时的恢复手段。

- **小憩** (15min): 健康 +10，心情 +5。宠物进入 sleep 动画。
- **深度睡眠** (60min): 健康 +30，心情 +10。宠物进入 sleep 动画，期间不接受互动。
- 触发: 右键菜单 -> 休息，或 health < 40 时气泡提示。

### 5.3 治疗 (Heal)

| 道具 | 健康恢复 | 冷却 | 获取方式 |
|------|----------|------|----------|
| 马文牌退烧贴 | +20 | 4h | 每日任务 |
| 深思重启针 | 恢复至满 | 24h | 等级奖励 (Lv.10/20/30) |

---

## 六、每日任务系统

### 6.1 核心原则: 后端控制奖励，LLM 只生成描述

```
┌─────────────────────────────────────────────────┐
│  LLM 负责:                                       │
│    - 生成任务的名称和描述文案(趣味化/拟人化)        │
│    - 根据后端给的 difficulty 档位生成对应难度的描述   │
│                                                   │
│  LLM 不碰:                                       │
│    - 奖励类型、奖励数量                            │
│    - 任务完成条件的数值阈值                         │
│    - 任何影响游戏经济的参数                         │
│                                                   │
│  后端负责:                                        │
│    - 决定今日任务的难度档位                         │
│    - 根据档位从奖励池随机抽取奖励                    │
│    - 检测任务完成条件                              │
│    - 发放奖励                                     │
└─────────────────────────────────────────────────┘
```

### 6.2 难度档位与奖励池

后端定义 3 个难度档位，每个档位有固定的奖励池，档内随机:

```typescript
// ─── 难度档位定义 ───

interface DifficultyTier {
  id: "easy" | "medium" | "hard";
  // 完成条件模板 (后端硬编码，LLM 不可修改)
  conditionTemplates: TaskCondition[];
  // 奖励池 (档内随机一组)
  rewardPool: TaskReward[];
}

const DIFFICULTY_TIERS: DifficultyTier[] = [
  {
    id: "easy",
    conditionTemplates: [
      { type: "chat_count", threshold: 3 },      // 聊天 3 次
      { type: "feed_count", threshold: 1 },       // 喂食 1 次
      { type: "online_minutes", threshold: 15 },  // 在线 15min
      { type: "click_count", threshold: 5 },      // 点击 5 次
    ],
    rewardPool: [
      { exp: 8,  items: [] },
      { exp: 5,  items: [{ id: "fish_snack", qty: 1 }] },
      { exp: 10, items: [] },
      { exp: 6,  items: [{ id: "cat_food_premium", qty: 1 }] },
    ],
  },
  {
    id: "medium",
    conditionTemplates: [
      { type: "chat_count", threshold: 10 },       // 聊天 10 次
      { type: "feed_count", threshold: 3 },         // 喂食 3 次
      { type: "online_minutes", threshold: 60 },    // 在线 1h
      { type: "tool_use_count", threshold: 5 },     // 使用工具 5 次
      { type: "domain_activity", threshold: 3 },    // 触发 3 次领域活动
      { type: "mood_above", threshold: 70, duration_min: 30 }, // 心情>70 持续 30min
    ],
    rewardPool: [
      { exp: 15, items: [] },
      { exp: 10, items: [{ id: "fish_snack", qty: 2 }] },
      { exp: 12, items: [{ id: "nutrition_paste", qty: 1 }] },
      { exp: 18, items: [] },
      { exp: 10, items: [{ id: "cold_medicine", qty: 1 }] },
    ],
  },
  {
    id: "hard",
    conditionTemplates: [
      { type: "chat_count", threshold: 25 },         // 聊天 25 次
      { type: "all_stats_above", threshold: 60 },    // 三项属性均 > 60
      { type: "online_minutes", threshold: 180 },    // 在线 3h
      { type: "learning_complete", threshold: 1 },   // 完成一节课
      { type: "achievement_unlock", threshold: 1 },  // 解锁一个成就
    ],
    rewardPool: [
      { exp: 25, items: [{ id: "premium_can", qty: 1 }] },
      { exp: 20, items: [{ id: "fish_snack", qty: 3 }] },
      { exp: 30, items: [] },
      { exp: 20, items: [{ id: "nutrition_paste", qty: 2 }] },
      { exp: 25, items: [{ id: "cold_medicine", qty: 1 }, { id: "fish_snack", qty: 1 }] },
    ],
  },
];
```

### 6.3 每日任务生成流程

```
每日 00:00 (或首次上线时) 触发任务生成:

1. 后端决定今日任务组合:
   - 固定 2 个 easy + 1 个 medium + 1 个 hard = 4 个任务
   - 从每个档位的 conditionTemplates 中随机选一个条件
   - 从每个档位的 rewardPool 中随机选一组奖励
   → 得到 4 个 { difficulty, condition, reward } 骨架

2. 调用 LLM 批量生成任务描述:
   prompt: "为以下 4 个宠物任务生成有趣的名称和描述(20字内)。
            任务条件: [聊天3次, 喂食3次, 在线1h, 完成一节课]
            只输出 JSON 数组: [{name, desc}, ...]"
   → LLM 返回: [{name:"话痨时间", desc:"和主人聊上几句吧"}, ...]

3. 后端组装完整任务:
   { id, name(LLM), desc(LLM), condition(后端), reward(后端), difficulty, status }

4. 持久化到 daily-tasks.json
```

### 6.4 任务数据结构

```typescript
interface DailyTask {
  id: string;                   // "task-20260307-001"
  date: string;                 // "2026-03-07"
  difficulty: "easy" | "medium" | "hard";
  name: string;                 // LLM 生成
  description: string;          // LLM 生成
  condition: TaskCondition;     // 后端决定，不可篡改
  reward: TaskReward;           // 后端决定，不可篡改
  status: "active" | "completed" | "claimed";
  progress?: number;            // 当前进度 (用于 UI 展示)
}

interface TaskCondition {
  type: string;       // "chat_count" | "feed_count" | "online_minutes" | ...
  threshold: number;  // 目标值
  duration_min?: number; // 持续时长要求(可选)
}

interface TaskReward {
  exp: number;
  items: Array<{ id: string; qty: number }>;
}
```

### 6.5 任务完成检测

后端在以下时机自动检测任务完成:

```typescript
// 在 pet-engine tick() 或相关事件中:

function checkTaskCompletion(task: DailyTask, counters: DailyCounters): boolean {
  switch (task.condition.type) {
    case "chat_count":
      return counters.chatCount >= task.condition.threshold;
    case "feed_count":
      return counters.feedCount >= task.condition.threshold;
    case "online_minutes":
      return counters.onlineMinutes >= task.condition.threshold;
    case "click_count":
      return counters.clickCount >= task.condition.threshold;
    case "tool_use_count":
      return counters.toolUseCount >= task.condition.threshold;
    case "domain_activity":
      return counters.domainActivityCount >= task.condition.threshold;
    case "all_stats_above":
      return engine.attributes.getAll().every(a => a.value >= task.condition.threshold);
    case "mood_above":
      return counters.moodAboveDuration >= (task.condition.duration_min ?? 0);
    case "learning_complete":
      return counters.learningCompleteCount >= task.condition.threshold;
    case "achievement_unlock":
      return counters.achievementUnlockCount >= task.condition.threshold;
    default:
      return false;
  }
}
```

任务完成后状态变为 "completed"，用户手动"领取"后发放奖励并变为 "claimed"。

---

## 七、数值再平衡

### 7.1 Hunger 新语义

hunger 不再仅靠时间衰减，增加聊天主动消耗:

```
hunger 消耗来源:
  - 时间衰减: 0.3/min (从 0.6 降低，因为聊天已在大量消耗)
  - 聊天消耗: 每条用户消息 -10
  - 工具调用: 额外 -1 (每次工具调用)
  - 玩耍消耗: 无限非概率逗猫器 -5，捉迷藏 -8，晒太阳 -2

hunger 恢复来源:
  - 42号口粮: +75 (免费, CD 20min)
  - 巴别鱼罐头: +45 (道具)
  - 泛银河爆破饮: +120 (道具)
  - 不要恐慌胶囊: +30 (道具)
```

### 7.2 衰减速度调整 (等级系数)

```
实际衰减 = 基础衰减 x 等级系数

等级系数:
  Lv.1-10:  1.0
  Lv.11-15: 0.85
  Lv.16-20: 0.75
  Lv.21-25: 0.70
  Lv.26-30: 0.60
```

### 7.3 离线保护

```
新规则:
  - 离线衰减上限: 4 小时 (替代 8 小时)
  - 离线底线: mood/health 不低于 20; hunger 不低于 60 (满足开机能聊几句)
  - 离线期间 hunger 仅按时间衰减(无聊天消耗)
  - Lv.16+ "自动照顾": 离线时 mood/health 不低于 35, hunger 不低于 90
  - Lv.26+ 离线衰减上限降至 2 小时
```

### 7.4 被动恢复 (在线时)

```
当宠物在线时:
  - mood >= 78 (joyful): health +0.1/min
  - hunger >= 225 (full): mood +0.05/min
  - health >= 70 (healthy) + mood >= 52 (happy): 时间衰减 -20%
```

---

## 八、道具背包系统

### 8.1 数据结构

```typescript
interface InventoryItem {
  id: string;           // "fish_snack", "cat_food", "cold_medicine"
  name: string;         // "小鱼干"
  icon: string;         // emoji
  category: "food" | "toy" | "medicine" | "special";
  description: string;
  quantity: number;      // 当前持有数量
  effects: {
    hunger?: number;
    mood?: number;
    health?: number;
    intimacy?: number;
    exp?: number;
  };
  cooldownMs?: number;   // 使用冷却
  lastUsedAt?: number;
}
```

### 8.2 道具定义表

```typescript
const ITEM_DEFS = {
  ration_42:        { name: "42号口粮",       icon: "🧊", category: "food",     effects: { hunger: 75, mood: 3 },          cooldownMs: 20*60*1000, unlimited: true },
  babel_fish_can:   { name: "巴别鱼罐头",     icon: "🐠", category: "food",     effects: { hunger: 45, mood: 12 } },
  gargle_blaster:   { name: "泛银河爆破饮",   icon: "🌌", category: "food",     effects: { hunger: 120, mood: 8, health: 5 } },
  dont_panic:       { name: "不要恐慌胶囊",   icon: "💊", category: "food",     effects: { hunger: 30, mood: 5, health: 15 } },
  marvin_patch:     { name: "马文牌退烧贴",   icon: "🤖", category: "medicine", effects: { health: 20 },                    cooldownMs: 4*3600*1000 },
  deep_thought:     { name: "深思重启针",     icon: "💉", category: "medicine", effects: { health: 100 },                   cooldownMs: 24*3600*1000 },
  improbability:    { name: "无限非概率逗猫器", icon: "🎲", category: "toy",     effects: { mood: 15, hunger: -5 },          permanent: true },
};
```

### 8.3 背包容量

- 初始: 20 格
- Lv.10 扩展至 30 格
- Lv.20 扩展至 40 格
- 同种物品堆叠上限 99

---

## 九、成长系统与等级系统的关系

### 现有的 intimacy 成长系统保留

intimacy (亲密度) 代表**关系深度**，等级代表**成长进度**，两者独立但互相促进:

```
  ┌─── 亲密度阶段 (关系质量) ───┐
  │ 幼猫 -> 朋友 -> 亲密伙伴 -> 心灵契合 │
  │ (由 LLM 评估聊天质量驱动)           │
  └────────────────────────────┘
               ↕ 互相加成
  ┌─── 宠物等级 (成长进度) ───┐
  │ Lv.1 -> Lv.10 -> Lv.20 -> Lv.30  │
  │ (由 EXP 驱动: 喂食/任务/成就)      │
  └─────────────────────────┘
```

- 亲密度阶段升级时，赠送大量 EXP (+100/+200/+500)
- 宠物等级提升时，亲密度获取加成 (+10%/级)
- 两者共同影响 persona prompt

---

## 十、技术实现规划

### 10.1 新增引擎模块

```
src/pet/
  ├── level-system.ts          # 等级系统 (EXP/升级/等级奖励)
  ├── care-system.ts           # 养护系统 (喂食/玩耍/休息/治疗 + 冷却)
  ├── daily-task-system.ts     # 每日任务 (档位/条件/奖励池/计数器)
  ├── chat-eval-system.ts      # 聊天评估 (消息计数/LLM 评估/clamp)
  ├── inventory-system.ts      # 背包系统 (道具管理/使用)
  └── login-tracker.ts         # 登录追踪 (连续登录/在线时长)
```

### 10.2 修改现有模块

| 文件 | 改动 |
|------|------|
| `pet-engine.ts` | 组合新子系统; tick() 驱动被动恢复; chat 交互改为消耗 hunger |
| `attribute-engine.ts` | 新增等级系数接口，支持动态衰减倍率 |
| `presets.ts` | hunger max 改 300, initial 改 210, decayPerMinute 降至 0.3; 离线上限改 4h; 底线改 60; hunger levels 按比例调整 |
| `growth-system.ts` | 新增 intimacy -> EXP 联动事件 |
| `persona-engine.ts` | 根据等级注入更丰富的 prompt 片段 |

### 10.3 新增 RPC 方法

| 方法 | 功能 |
|------|------|
| `pet.level.info` | 获取等级、EXP、下一级进度 |
| `pet.care.feed` | 使用食物道具喂食(补充 token) |
| `pet.care.play` | 执行玩耍动作 |
| `pet.care.rest` | 开始休息 |
| `pet.care.heal` | 使用治疗道具 |
| `pet.chat.eval` | 触发聊天状态评估(内部调用，>=5min 间隔自动触发) |
| `pet.chat.canChat` | 检查是否有足够 hunger 聊天 |
| `pet.inventory.list` | 获取背包道具列表 |
| `pet.inventory.use` | 使用道具 |
| `pet.daily.tasks` | 获取今日任务列表(含 LLM 生成的描述) |
| `pet.daily.claim` | 领取已完成任务奖励 |
| `pet.daily.streak` | 获取连续登录信息 |

### 10.4 聊天评估集成点

```
现有聊天流程:
  客户端 -> chat.send -> Gateway -> LLM API -> stream 回复

新增逻辑 (在 Gateway chat handler 中):

  1. chat.send 收到用户消息时:
     a. hunger 检查: hunger <= 30 则拒绝聊天，返回特殊状态码
     b. hunger 消耗: engine.attributes.adjust("hunger", -10)
     c. 固定奖励: engine.interact("chat") -> mood +1 (基础值)
     d. 缓存消息摘要到 recentMessages 队列
     e. msgCount++ (用户输入计数)

  1.5. 工具调用时:
     - engine.attributes.adjust("hunger", -1) (额外消耗)

  2. 评估触发检查 (双条件):
     a. msgCount % 5 != 0 -> 跳过 (每5轮才检查)
     b. 距上次评估 < 5min -> 跳过 (最小间隔)
     c. 两者都满足 -> 异步调用 LLM 意图提取 (不阻塞聊天流)
     c. LLM 返回意图标签 -> 程序查表 + streak 二次函数 -> adjust
     d. 同一个 LLM 调用处理 mood + intimacy + 未来扩展状态

  3. hunger <= 30 时:
     - chat.send 返回特殊状态码 + reason
     - 客户端显示"太饿了"气泡，引导喂食
```

### 10.5 每日任务 LLM 集成点

```
每日首次上线 / 跨日时:
  1. 后端生成 4 个任务骨架 { difficulty, condition, reward }
  2. 异步调用 LLM 生成 4 个 { name, desc }
  3. 组装完整任务列表，持久化
  4. LLM 调用失败时，使用预设的 fallback 名称/描述
```

### 10.6 数据持久化

新增 JSON 文件 (`~/.openclaw/store/pet/`):

```
level-system.json      — { exp, level, unlockedRewards }
inventory.json         — { items: [...], capacity }
daily-tasks.json       — { date, tasks, streak, lastLoginDate, counters }
chat-eval.json         — { msgCount, lastEvalAt, streak, lastDirection, recentMessages }
care-cooldowns.json    — { feed: timestamp, play: timestamp, ... }
```

---

## 十一、实现优先级

### P0 -- 核心循环 (第一期)

1. **等级系统** -- EXP + 升级 + 等级显示
2. **聊天消耗 hunger** -- 每条消息 -10 hunger，工具调用额外 -1，hunger 不足时拒绝聊天
3. **基础喂食(猫粮)** -- 免费补充 token，冷却 20min
4. **数值再平衡** -- hunger max 300, 衰减降至 0.3/min, 离线保护, 底线 60
5. **右键菜单改造** -- 显示等级 + 喂食按钮

完成后效果: 聊天消耗饱腹，喂食补充饱腹，宠物有等级。核心经济循环成立。

### P1 -- LLM 评估 + 任务 (第二期)

6. **聊天 LLM 意图提取** -- 每5轮+间隔>=5min 双条件触发，程序侧查表+二次函数
7. **每日任务系统** -- 后端档位 + LLM 生成描述 + 奖励发放
8. **道具背包** -- 道具数据结构 + 背包 UI + 多种食物
9. **玩耍/休息/治疗** -- 更多养护手段

### P2 -- 长线内容 (第三期)

10. **连续登录** -- 签到 + 累计奖励
11. **等级解锁内容** -- 新动画/外观/自动照顾
12. **等级 x 亲密度联动** -- persona 增强

---

## 十二、体验节奏设计

```
用户一天的典型体验:

08:00  开机，宠物上线
       -> 离线 8h，hunger 底线 60，mood/health 底线 20
       -> 气泡: "主人早上好~ 我有点饿了..."
       -> 右键 -> 喂食(42号口粮) -> hunger 60->135
       -> 刷出今日任务(LLM 生成趣味描述)

09:00  开始工作，和宠物聊天
       -> 每条消息: hunger -10 (token 成本) + mood +1 (固定基础值)
       -> 口粮给了 +75，可以连聊 ~8 条不用喂
       -> 聊到第 5 条，触发 LLM 意图评估(5轮 + >=5min)
       -> LLM 识别为 "neutral" -> 程序查表: mood +1, intimacy +1
       -> 第 8 条左右 hunger 偏低

09:30  右键 -> 喂食(42号口粮，CD 已好) -> hunger +75
       -> 完成 easy 任务"和主人说说话"(聊天3次)
       -> 领取奖励: EXP +8

12:00  午休，使用巴别鱼罐头(每日任务获得) -> hunger +45, mood +12
       -> 完成 medium 任务"美食鉴赏家"(喂食3次)
       -> 领取奖励: EXP +15

14:00  继续工作，长按宠物 -> 抚摸 -> mood +15 (固定值)
       -> 跟宠物夸了几句，LLM 连续识别为 praise
       -> 第1次 praise: mood +5 (x1.0)
       -> 第2次 praise: mood +6 (x1.15, streak=2)
       -> 宠物越来越开心

18:00  查看任务: 3/4 完成
       -> hard 任务"全能管家"(三项属性>60) 还差一点
       -> 再喂一次 -> 属性全部 > 60 -> 完成!
       -> 领取: EXP +25, 高级罐头 x1

       今日总 EXP ~ 80-100, 约 1-2 天升一级(前期)

23:00  关机，宠物离线
       -> 明天属性不会归零，继续养成
```

---

## 十三、与现有系统的兼容性

- **固定交互数值保留**: click/longpress/feed/file_drop/drag 的固定 mood/intimacy 奖励不变，LLM 评估是叠加层
- **chat 交互调整**: 基础 mood+1 保留(固定层)，额外的 mood/intimacy 变化由 LLM 意图识别驱动(评估层)
- **LLM 角色明确**: 只做意图分类(输出标签)，不做数值决策; 程序查表+二次函数处理连续性
- **不影响 skill/learning/achievement**: 保持独立，但产出 EXP 和道具作为联动
- **安全兜底**: 未知意图 fallback neutral; LLM 失败静默跳过; clamp 单次上限; 奖励和道具完全后端控制
- **渐进式实现**: 每期独立可交付，不需要全部完成才能上线
