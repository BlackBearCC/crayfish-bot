# 用户游玩路径

> 更新: 2026-03-11

[← 返回首页](index.md)

本文描述一个典型用户从第一次打开到长期留存完整旅程，并标注各环节的系统支撑。

---

## 新用户旅程（Day 1）

### 1. 首次启动

```
用户打开客户端
  → 宠物出现（Lv.1，陌生人阶段）
  → 播放欢迎动画
  → 显示新手引导
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 初始化宠物状态 | `CharacterEngine` 构造函数 | ✅ |
| Lv.1 默认值 | `LevelSystem` | ✅ |
| 陌生人阶段 | `GrowthSystem` stage=0 | ✅ |
| 新手引导 | ❓ 客户端 | 📝 |

---

### 2. 第一次聊天

```
用户: "你好啊"
  → 宠物回复（结合 Lv.1 稚嫩语气 + 陌生人距离感）
  → hunger -= 10
  → msgCount++
  → 记忆提取（异步）
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 状态注入 prompt | `agent:bootstrap` hook → CHARACTER_STATE.md | ✅ |
| hunger 消耗 | `ChatEvalSystem.onMessage()` | ✅ |
| 消息计数 | `DailyTaskSystem` chatCount | ✅ |
| 记忆提取 | `MemoryGraphSystem.enqueueExtraction()` | ✅ |
| 聊天门控 | `character.chat.canChat` | ✅ |

---

### 3. 宠物饿了

```
聊天 5-10 轮后
  → hunger 降到 30 以下
  → 下次用户发消息被拒绝
  → 宠物显示饥饿气泡: "好饿...先喂喂我吧"
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 聊天门控 | `canChat()` 返回 `{canChat: false, reason: "hunger_low"}` | ✅ |
| 气泡提示 | ❓ 客户端 | 📝 |

---

### 4. 第一次喂食

```
用户: "喂你吃东西"
  → AI 调用 character_self_care 或用户点击喂食按钮
  → 使用 42号口粮（免费，20min 冷却）
  → hunger += 75, mood += 3
  → 显示吃东西动画
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 免费口粮 | `InventorySystem` ration_42 unlimited | ✅ |
| 喂食效果 | `CareSystem.feed()` | ✅ |
| 冷却检查 | `InventorySystem` cooldownMs | ✅ |
| AI 主动喂食 | `character_self_care` tool | ✅ |

---

### 5. 完成第一个每日任务

```
聊天 5 轮 + 在线 10 分钟
  → 完成 easy 档任务
  → 显示任务完成提示
  → 用户点击领取奖励
  → 获得 EXP + 星币 + 道具
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 任务生成 | `DailyTaskSystem.ensureTodayTasks()` | ✅ |
| 进度追踪 | `DailyTaskSystem.tick()` + counters | ✅ |
| 完成检测 | `_checkCompletion()` | ✅ |
| 奖励领取 | `claimTask()` | ✅ |
| 完成提示 | ❓ 客户端 | 📝 |

---

### 6. 第一次升级

```
积累足够 EXP
  → 升级到 Lv.2
  → 显示升级动画 + 提示
  → 解锁新功能（如果有）
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| EXP 积累 | `LevelSystem.gainExp()` | ✅ |
| 升级检测 | `LevelSystem` 内部 | ✅ |
| 升级事件 | `EventBus.emit('level:up')` | ✅ |
| 升级提示 | ❓ 客户端 | 📝 |

---

### 7. 下线休息

```
用户关闭客户端
  → 保存所有状态
  → 记录离线时间
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 状态持久化 | `PersistenceStore.save()` | ✅ |
| 离线时间 | `lastOnlineAt` 记录 | ✅ |

---

## 第二天回归（Day 2）

### 8. 连续登录奖励

```
用户第二天打开
  → 连续登录天数 +1
  → 发放星币奖励 (5 × N)
  → 显示登录提示
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 登录追踪 | `LoginTracker._checkLogin()` | ✅ |
| 连续判断 | `isYesterday()` 检查 | ✅ |
| 星币发放 | `EventBus.emit('login:streak')` → `shop.earnCoins()` | ✅ |
| EXP 奖励 | `LevelSystem.gainExp()` | ✅ |

---

### 9. 离线属性衰减

```
离线 8 小时
  → 属性按离线时间衰减（有下限保护）
  → 等级越高，下限越高
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 离线衰减 | `AttributeEngine.applyOfflineDecay()` | ✅ |
| 等级下限 | `LevelSystem.getOfflineFloor()` | ✅ |

---

### 10. Soul Agent 主动问候

```
用户回来时
  → Soul Agent 检测到用户活跃
  → 结合心情/记忆决定是否说话
  → "你回来啦！昨天聊的那个项目怎么样了？"
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| Soul Agent | Cron agentTurn（每30min） | ✅ |
| 状态注入 | CHARACTER_STATE.md | ✅ |
| 记忆搜索 | `memory_search` | ✅ |
| 输出广播 | `message:sent` hook → `_broadcast()` | ✅ |

---

## 长期留存（Week 1+）

### 11. 成长阶段变化

```
亲密度积累
  → 从陌生人 → 熟悉 → 亲密 → 羁绊
  → 说话风格变化
  → 解锁新互动
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 亲密度积累 | `GrowthSystem.gain()` | ✅ |
| 阶段检测 | `GrowthSystem` stage | ✅ |
| 风格注入 | CHARACTER_STATE.md intimacy 片段 | ✅ |

---

### 12. 技能领悟

```
多次使用同一工具
  → 领域 XP 积累
  → 触发领悟
  → 解锁新技能
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 工具记录 | `after-tool-call` hook → `SkillSystem.recordTool()` | ✅ |
| 领域 XP | `SkillSystem.recordDomainActivity()` | ✅ |
| 领悟检测 | `SkillSystem.checkEpiphany()` | ✅ |
| 领悟事件 | `EventBus.emit('skill:epiphany')` | ✅ |

---

### 13. World Agent 世界事件

```
每周一
  → World Agent 生成"新的一周"事件
  → Soul Agent 消费事件
  → 宠物主动说"新的一周开始啦！这周有什么计划？"
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| World Agent | Cron agentTurn（每小时） | ✅ |
| 事件生成 | LLM 输出 JSON 事件 | ✅ |
| 事件存储 | `WorldEventSystem.addEvent()` | ✅ |
| Soul Agent 消费 | 读取 pendingEvents | ✅ |

---

### 14. 成就解锁

```
累计聊天 20 次
  → 解锁"话痨伙伴"成就
  → 亲密度 +10
  → 显示成就弹窗
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 成就检测 | `AchievementSystem.incrementChatCount()` | ✅ |
| 成就解锁 | `checkAll()` | ✅ |
| 亲密度奖励 | `intimacyBonus` | ✅ |

---

### 15. 探险系统

```
宠物想去探险
  → Soul Agent 决定发起探险
  → 用户选择地点
  → 挂机等待
  → 探险完成，获得奖励
```

**系统支撑：**
| 环节 | 代码 | 状态 |
|------|------|------|
| 探险发起 | `AdventureSystem.startAdventure()` | ✅ |
| 挂机计时 | `AdventureSystem.tick()` | ✅ |
| 奖励发放 | `completeAdventure()` | ✅ |

---

## 核心循环总结

```
┌─────────────────────────────────────────────────────┐
│                    用户核心循环                       │
│                                                     │
│   聊天 ──→ 消耗 hunger ──→ 喂食 ──→ 获得道具         │
│    │                              │                 │
│    ▼                              ▼                 │
│   任务进度 ──────────────→ 领奖励 (EXP/星币/道具)    │
│    │                              │                 │
│    ▼                              ▼                 │
│   升级/成长 ─────────────→ 解锁新功能/新风格         │
│    │                              │                 │
│    ▼                              ▼                 │
│   技能/成就 ─────────────→ 更深互动                 │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 断点/缺失清单

| 环节 | 问题 | 优先级 |
|------|------|--------|
| 新手引导 | 客户端未实现 | P1 |
| 气泡提示系统 | 客户端未实现 | P1 |
| 任务完成推送 | 客户端未实现 | P1 |
| 升级动画 | 客户端未实现 | P2 |
| 等级解锁特权 | 服务端部分实现 | P2 |
| Session 集成 | 未实现 | P2 |

---

## 下一步

1. **客户端实现**：气泡系统、任务推送、升级动画
2. **服务端完善**：等级解锁特权、Session 集成
3. **文档同步**：更新道具奖励池描述