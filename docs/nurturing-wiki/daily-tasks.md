# 每日任务系统

> 更新: 2026-03-09

[← 返回首页](index.md)

## 核心原则

```
LLM 负责:
  - 生成任务名称和描述文案 (趣味化/拟人化)
  - 根据后端给的 difficulty 档位生成对应描述

LLM 不碰:
  - 奖励类型、奖励数量
  - 任务完成条件的数值阈值
  - 任何影响游戏经济的参数

后端负责:
  - 决定难度档位 + 从奖励池随机抽取 + 检测完成 + 发放奖励
```

---

## 难度档位与奖励池

每日 **2 easy + 1 medium + 1 hard = 4 个任务**。

```typescript
interface DifficultyTier {
  id: "easy" | "medium" | "hard";
  conditionTemplates: TaskCondition[];
  rewardPool: TaskReward[];
}

const DIFFICULTY_TIERS: DifficultyTier[] = [
  {
    id: "easy",
    conditionTemplates: [
      { type: "chat_count", threshold: 3 },
      { type: "feed_count", threshold: 1 },
      { type: "online_minutes", threshold: 15 },
      { type: "click_count", threshold: 5 },
    ],
    rewardPool: [
      { exp: 8,  coins: 12, items: [] },
      { exp: 5,  coins: 10, items: [{ id: "fish_snack", qty: 1 }] },
      { exp: 10, coins: 15, items: [] },
      { exp: 6,  coins: 10, items: [{ id: "cat_food_premium", qty: 1 }] },
    ],
  },
  {
    id: "medium",
    conditionTemplates: [
      { type: "chat_count", threshold: 10 },
      { type: "feed_count", threshold: 3 },
      { type: "online_minutes", threshold: 60 },
      { type: "tool_use_count", threshold: 5 },
      { type: "domain_activity", threshold: 3 },
      { type: "mood_above", threshold: 70, duration_min: 30 },
    ],
    rewardPool: [
      { exp: 15, coins: 25, items: [] },
      { exp: 10, coins: 20, items: [{ id: "fish_snack", qty: 2 }] },
      { exp: 12, coins: 22, items: [{ id: "nutrition_paste", qty: 1 }] },
      { exp: 18, coins: 30, items: [] },
      { exp: 10, coins: 20, items: [{ id: "cold_medicine", qty: 1 }] },
    ],
  },
  {
    id: "hard",
    conditionTemplates: [
      { type: "chat_count", threshold: 25 },
      { type: "all_stats_above", threshold: 60 },
      { type: "online_minutes", threshold: 180 },
      { type: "learning_complete", threshold: 1 },
      { type: "achievement_unlock", threshold: 1 },
    ],
    rewardPool: [
      { exp: 25, coins: 45, items: [{ id: "premium_can", qty: 1 }] },
      { exp: 20, coins: 50, items: [{ id: "fish_snack", qty: 3 }] },
      { exp: 30, coins: 60, items: [] },
      { exp: 20, coins: 40, items: [{ id: "nutrition_paste", qty: 2 }] },
      { exp: 25, coins: 45, items: [{ id: "cold_medicine", qty: 1 }, { id: "fish_snack", qty: 1 }] },
    ],
  },
];
```

---

## 生成流程

```
每日首次上线 / 跨日时:
  1. 后端从每个档位的 conditionTemplates 随机选条件 + rewardPool 随机选奖励
     → 4 个 { difficulty, condition, reward } 骨架
  2. 调用 LLM: "为以下 4 个宠物任务生成名称和描述(20字内)"
     → [{name:"话痨时间", desc:"和主人聊上几句吧"}, ...]
  3. 组装完整任务，持久化到 daily-tasks.json
  4. LLM 失败时，使用 fallback 名称/描述
```

---

## 数据结构

```typescript
interface DailyTask {
  id: string;                   // "task-20260307-001"
  date: string;
  difficulty: "easy" | "medium" | "hard";
  name: string;                 // LLM 生成
  description: string;          // LLM 生成
  condition: TaskCondition;     // 后端决定
  reward: TaskReward;           // 后端决定
  status: "active" | "completed" | "claimed";
  progress?: number;
}

interface TaskCondition {
  type: string;
  threshold: number;
  duration_min?: number;
}

interface TaskReward {
  exp: number;
  coins: number;
  items: Array<{ id: string; qty: number }>;
}
```

---

## 完成检测

```typescript
function checkTaskCompletion(task: DailyTask, counters: DailyCounters): boolean {
  switch (task.condition.type) {
    case "chat_count":         return counters.chatCount >= task.condition.threshold;
    case "feed_count":         return counters.feedCount >= task.condition.threshold;
    case "online_minutes":     return counters.onlineMinutes >= task.condition.threshold;
    case "click_count":        return counters.clickCount >= task.condition.threshold;
    case "tool_use_count":     return counters.toolUseCount >= task.condition.threshold;
    case "domain_activity":    return counters.domainActivityCount >= task.condition.threshold;
    case "all_stats_above":    return engine.attributes.getAll().every(a => a.value >= task.condition.threshold);
    case "mood_above":         return counters.moodAboveDuration >= (task.condition.duration_min ?? 0);
    case "learning_complete":  return counters.learningCompleteCount >= task.condition.threshold;
    case "achievement_unlock": return counters.achievementUnlockCount >= task.condition.threshold;
    default: return false;
  }
}
```

完成 → status = "completed"，用户手动领取 → 发放奖励 → "claimed"。

---

## See also

- [经济与道具](economy.md) — 任务奖励道具定义、星币获取来源
- [等级系统](level-system.md) — 任务 EXP 对升级的贡献
- [核心循环](core-loop.md) — 完整经济模型
- [AI 系统](ai-system.md) — Cron 每日刷新机制
