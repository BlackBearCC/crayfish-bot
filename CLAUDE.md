# Fork 分支结构

```
upstream-main              # 跟踪 upstream/main，只同步不修改
main                       # 主开发分支 = upstream + 本地功能
feature/for-upstream-*     # 向上游 PR 的分支（干净、规范）
feature/crayfish-*         # 仅本项目需要的功能分支
```

## 远程仓库

- `origin` - https://github.com/BlackBearCC/crayfish-bot.git
- `upstream` - https://github.com/moltbot/moltbot.git

## 工作流程

### 同步上游
1. `git fetch upstream`
2. `git checkout upstream-main && git merge upstream/main`
3. `git checkout main && git merge upstream-main`

### 开发新功能
- **向上游贡献**: 从 `upstream-main` 创建 `feature/for-upstream-*`
- **本地功能**: 从 `main` 创建 `feature/crayfish-*`，完成后合并到 `main`
