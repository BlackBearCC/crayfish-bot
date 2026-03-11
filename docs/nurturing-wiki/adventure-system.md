# 探险系统

> 状态：后端已实现，前端已开发
> 更新：2026-03-11

---

## 当前状态

| 层级 | 状态 |
|------|------|
| **后端** | ✅ `adventure-system.ts` 已实现 |
| **RPC** | ✅ `character.adventure.*` 已暴露 |
| **UI** | ✅ 养成面板 Tab 已实现 |

---

## 后端实现

### RPC 接口

| 方法 | 说明 |
|------|------|
| `character.adventure.start` | 开始探险 |
| `character.adventure.choice` | 做选择（交互式探险） |
| `character.adventure.complete` | 完成探险 |
| `character.adventure.cancel` | 取消探险 |
| `character.adventure.active` | 获取当前探险 |
| `character.adventure.history` | 历史记录 |

### 探险类型

| 类型 | 说明 |
|------|------|
| `idle` | 闲置探险，宠物自己出去逛 |
| `interactive` | 交互式，需要玩家做选择 |
| `explore` | 探索，主动搜索 |

### 风险等级

| 等级 | 成功率 | 奖励 |
|------|--------|------|
| `safe` | 90% | EXP 20, Coins 10 |
| `moderate` | 70% | EXP 50, Coins 25 |
| `dangerous` | 50% | EXP 100, Coins 50 |

### 流程

```
startAdventure({ type, location, duration, risk })
    │
    ▼
等待 duration 分钟
    │
    ▼（如果是 interactive）
makeChoice(adventureId, choiceId)
    │
    ▼
completeAdventure(adventureId, result)
    │
    ▼
发放奖励：EXP + Coins + 可能掉落物品
```

---

## 缺失部分

### 前端 UI

- 没有探险面板（`AdventurePanel.js`）
- 没有触发入口
- 无法查看探险状态/历史

---

## 待设计

1. **触发入口**
   - 右键菜单？
   - 养成面板 Tab？
   - 点击宠物？

2. **界面设计**
   - 探险选择（类型/地点/风险）
   - 进行中状态展示
   - 交互式选择界面
   - 结果展示

3. **与养成系统的联动**
   - 探险消耗 hunger？
   - 探险影响 mood？
   - 探险获得领域 XP？