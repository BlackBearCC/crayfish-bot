# 经济与道具系统

> 更新: 2026-03-09

[← 返回首页](index.md)

## 统一道具表

| ID | 名称 | 图标 | 类型 | 饱腹 | 心情 | 健康 | 价格 | 获取途径 | 备注 |
|----|------|------|------|------|------|------|------|----------|------|
| `ration_42` | 42号口粮 | 🧊 | food | +75 | +3 | — | 免费 | 保底，CD 20min | `unlimited: true` |
| `babel_fish_can` | 巴别鱼罐头 | 🐠 | food | +45 | +12 | — | 30 星币 | 商城(日限5) / 每日任务 | |
| `gargle_blaster` | 泛银河爆破饮 | 🌌 | food | +120 | +8 | +5 | 80 星币 | 商城(日限2) / 升级/成就 | |
| `dont_panic` | 不要恐慌胶囊 | 💊 | food | +30 | +5 | +15 | 25 星币 | 商城(日限3) / 连续登录 | |
| `marvin_patch` | 马文牌退烧贴 | 🤖 | medicine | — | — | +20 | 40 星币 | 商城(日限3) / 每日任务 | CD 4h |
| `deep_thought` | 深思重启针 | 💉 | medicine | — | — | 满血 | 200 星币 | 商城(周限1) / 等级奖励(Lv.10/20/30) | CD 24h |
| `improbability` | 无限非概率逗猫器 | 🎲 | toy | -5 | +15 | — | — | 等级/成就解锁 | `permanent: true` |

**设计要点:** 42号口粮免费保底，用户永远不会被卡死。无限非概率逗猫器是永久道具，不进商城。

---

## 货币: 星币

整个养成经济的通用货币。**不可充值购买**，只能通过游戏行为赚取。

### 获取来源

| 来源 | 星币 | 频率 |
|------|------|------|
| 简单任务完成 | 10~15 | 每日 2 个 |
| 中等任务完成 | 20~30 | 每日 1 个 |
| 困难任务完成 | 40~60 | 每日 1 个 |
| 升级奖励 | 20 × 当前等级 | 升级时 |
| 成就解锁 | 50 | 解锁时 |
| 连续登录 (第 N 天) | 5 × N (上限 50) | 每日 |
| 每日在线满 30min | 10 | 每日 |
| 聊天里程碑 (每日第 20 条) | 5 | 每日 |

日均收入: ~120–170 星币 (轻度) / ~200+ (重度)

---

## 喂食 (Token 补充)

喂食 = 补充 token(饱腹值)，让宠物能继续聊天。

### 饱腹值经济

```
hunger 上限: 300 | 聊天: 每条 -10 | 工具调用: 额外 -1 | 时间衰减: 0.3/min

满饱腹 (300) 出发:
  20 轮聊天 (~30min): 消耗 200+9 = 209, 剩余 91 (30%) ✓
  中途喂一次口粮 (+75): 可延长 ~8 条

42号口粮 (CD 20min, +75):
  轻度聊天: 口粮基本够用
  重度聊天: 搭配巴别鱼罐头(+45) / 泛银河爆破饮(+120)
```

---

## 玩耍 / 休息 / 治疗

### 玩耍 (Play)

主要恢复心情，消耗少量饱腹。

| 动作 | 心情 | 饱腹消耗 | 亲密度 | 触发 |
|------|------|---------|--------|------|
| 抚摸 | +8 | — | +2 | 长按宠物 |
| 无限非概率逗猫器 | +15 | -5 | +5 | 养成面板 → 玩耍 |
| 捉迷藏 | +20 | -8 | +8 | 宠物跑到随机位置，点击 |
| 晒太阳 | +10 | -2 | +3 | 拖拽到屏幕顶部 |

### 休息 (Rest)

- **小憩** (15min): 健康 +10，心情 +5，sleep 动画
- **深度睡眠** (60min): 健康 +30，心情 +10，期间不接受互动
- 触发: 养成面板 → 休息，或 health < 40 时气泡提示

### 治疗 (Heal)

马文牌退烧贴 (+20 健康，CD 4h) 和深思重启针 (满血，CD 24h) 见上方道具表。

---

## 商城

| 商品 | 价格 | 每日限购 | 说明 |
|------|------|----------|------|
| 巴别鱼罐头 | 30 星币 | 5 | +45 饱腹 +12 心情 |
| 泛银河爆破饮 | 80 星币 | 2 | +120 饱腹 +8 心情 +5 健康 |
| 不要恐慌胶囊 | 25 星币 | 3 | +30 饱腹 +15 健康 |
| 马文牌退烧贴 | 40 星币 | 3 | +20 健康 |
| 深思重启针 | 200 星币 | 1/周 | 满血复活 |

- 42号口粮不进商城，永远免费保底
- 任务/升级/成就 = 白嫖渠道，商城 = 主动购买渠道

---

## 经济平衡

```
日收入 (中度活跃):
  2 easy 任务:         ~25 星币
  1 medium 任务:       ~25 星币
  1 hard 任务:         ~50 星币
  登录 + 在线 + 聊天:  ~25 星币
  ≈ 125 星币/日

日支出 (中度消耗):
  2x 巴别鱼罐头:       60
  1x 不要恐慌胶囊:     25
  1x 马文牌退烧贴:     40
  ≈ 125 星币/日

  → 收支基本平衡
  → 结余攒深思重启针 (200 星币/周)
  → 升级时一次性获得大量星币 (20 x Lv)
```

---

## 道具背包

### 容量

- 初始: 20 格
- Lv.10: 30 格
- Lv.20: 40 格
- 堆叠上限 99

### 数据结构

```typescript
interface InventoryItem {
  id: string;
  name: string;
  icon: string;
  category: "food" | "toy" | "medicine" | "special";
  description: string;
  quantity: number;
  effects: { hunger?: number; mood?: number; health?: number; intimacy?: number; exp?: number; };
  cooldownMs?: number;
  lastUsedAt?: number;
}

const ITEM_DEFS = {
  ration_42:        { name: "42号口粮",       icon: "🧊", category: "food",     effects: { hunger: 75, mood: 3 },          cooldownMs: 20*60*1000, unlimited: true },
  babel_fish_can:   { name: "巴别鱼罐头",     icon: "🐠", category: "food",     effects: { hunger: 45, mood: 12 } },
  gargle_blaster:   { name: "泛银河爆破饮",   icon: "🌌", category: "food",     effects: { hunger: 120, mood: 8, health: 5 } },
  dont_panic:       { name: "不要恐慌胶囊",   icon: "💊", category: "food",     effects: { hunger: 30, mood: 5, health: 15 } },
  marvin_patch:     { name: "马文牌退烧贴",   icon: "🤖", category: "medicine", effects: { health: 20 },                    cooldownMs: 4*3600*1000 },
  deep_thought:     { name: "深思重启针",     icon: "💉", category: "medicine", effects: { health: 100 },                   cooldownMs: 24*3600*1000 },
  improbability:    { name: "无限非概率逗猫器", icon: "🎲", category: "toy",     effects: { mood: 15, hunger: -5 },          permanent: true },
};

interface ShopItem {
  id: string;              // 对应 ITEM_DEFS 的 key
  price: number;
  dailyLimit: number;      // 0 = 不限
  weeklyLimit?: number;
  unlockLevel?: number;    // 默认 Lv.1
}

interface PlayerWallet {
  coins: number;
  totalEarned: number;     // 用于成就检测
  totalSpent: number;
}
```

---

## See also

- [核心循环](core-loop.md) — hunger 消耗/恢复公式、LLM 评估
- [每日任务](daily-tasks.md) — 任务奖励来源
- [等级系统](level-system.md) — 升级奖励星币、背包扩容
