# Git 上游同步与 Fork 仓库开发规范

本文档说明如何维护一个 fork 仓库，同时保持与上游同步并进行自定义开发。

## 📋 分支结构

```
upstream/main (上游仓库 - moltbot/moltbot)
    ↓ 定期同步
origin/main (你的 fork 主分支 - 保持与上游一致)
    ↓ 创建功能分支
origin/feature/cn-providers (自定义开发分支)
    ├─ 国内模型适配
    ├─ 功能增强
    └─ Bug 修复
```

### 分支说明

- **`main`** - 干净的上游镜像，仅用于同步，不直接开发
- **`feature/*`** - 功能开发分支，包含所有自定义功能
- **`fix/*`** - 向上游贡献的修复分支（从 main 创建）
- **`main-backup`** - 备份分支（可选）

## 🔧 初始设置

### 1. 添加上游仓库

```bash
# 查看当前 remote
git remote -v

# 如果没有 upstream，添加上游仓库
git remote add upstream https://github.com/moltbot/moltbot.git

# 验证
git remote -v
# 应该看到：
# origin    https://github.com/YOUR_USERNAME/crayfish-bot.git
# upstream  https://github.com/moltbot/moltbot.git
```

### 2. 设置 Git 别名（推荐）

在 `~/.gitconfig` 中添加：

```ini
[alias]
    # 同步上游到 main
    sync = "!git checkout main && git fetch upstream && git merge upstream/main && git push origin main"

    # 从上游创建新的功能分支
    new-feature = "!f() { git fetch upstream && git checkout -b $1 upstream/main; }; f"

    # 更新当前分支到最新上游
    update = "!git fetch upstream && git rebase upstream/main"

    # 查看未合并到 main 的提交
    unmerged = "!git log --oneline main..HEAD"

    # 查看分支状态
    branches = "!git branch -vv"
```

使用方法：
```bash
git sync                          # 同步 main 分支
git new-feature fix/some-bug      # 创建新分支
git update                        # 更新当前分支
```

## 🔄 日常工作流程

### 同步上游更新到 main

定期（如每周）执行以下操作：

```bash
# 方法 1: 使用别名（推荐）
git sync

# 方法 2: 手动操作
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
```

**注意事项：**
- main 分支应该始终保持与 upstream/main 一致
- 如果 main 上有自定义提交，需要先清理（参考"分支重组"章节）

### 更新功能分支

在 main 同步后，更新你的功能分支：

```bash
# 切换到功能分支
git checkout feature/cn-providers

# 方法 1: Rebase（推荐，保持历史清晰）
git fetch upstream
git rebase upstream/main

# 如果有冲突，解决后继续
git add .
git rebase --continue

# 强制推送（因为 rebase 改变了历史）
git push origin feature/cn-providers --force-with-lease

# 方法 2: Merge（更安全，但历史复杂）
git fetch upstream
git merge upstream/main
git push origin feature/cn-providers
```

**何时使用 Rebase vs Merge：**
- **Rebase**: 保持线性历史，适合私有分支
- **Merge**: 保留完整历史，适合共享分支或不确定的情况

### 在功能分支上开发

```bash
# 确保在正确的分支
git checkout feature/cn-providers

# 进行开发
# ... 编辑文件 ...

# 提交更改
git add .
git commit -m "feat(provider): add new model support"

# 推送到远程
git push origin feature/cn-providers
```

## 🚀 向上游贡献

### 创建贡献分支

从**干净的 main** 创建分支：

```bash
# 1. 确保 main 是最新的
git checkout main
git pull upstream main

# 2. 创建贡献分支（使用别名）
git new-feature fix/oauth-type-safety

# 或手动创建
git checkout -b fix/oauth-type-safety upstream/main
```

### 进行修改并提交

```bash
# 进行修改
# ... 编辑代码 ...

# 提交（遵循上游的 commit 规范）
git add .
git commit -m "fix(oauth): improve type safety in provider resolution

- Add proper type validation with resolveOAuthProvider()
- Remove unsafe 'as any' type casting
- Fixes #123"

# 推送到你的 fork
git push origin fix/oauth-type-safety
```

### 创建 Pull Request

1. 访问 GitHub 上你的 fork 仓库
2. 点击 "Compare & pull request"
3. 确保方向正确：
   ```
   base repository: moltbot/moltbot
   base: main
   ←
   head repository: YOUR_USERNAME/crayfish-bot
   compare: fix/oauth-type-safety
   ```
4. 填写 PR 说明
5. 提交 PR

### PR 被合并后

```bash
# 1. 删除本地和远程的贡献分支
git branch -d fix/oauth-type-safety
git push origin --delete fix/oauth-type-safety

# 2. 同步 main（包含你的贡献）
git checkout main
git pull upstream main
git push origin main

# 3. 可选：更新功能分支以获取你的贡献
git checkout feature/cn-providers
git rebase main
git push origin feature/cn-providers --force-with-lease
```

## 🛠️ 高级操作

### 分支重组（清理 main）

如果你的 main 分支包含自定义提交，需要重组：

```bash
# 1. 创建备份
git branch main-backup main

# 2. 创建功能分支保存自定义代码
git checkout -b feature/my-work main

# 3. 重置 main 到上游
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease

# 4. Rebase 功能分支
git checkout feature/my-work
git rebase main
# 解决冲突...
git push origin feature/my-work --force-with-lease
```

### 选择性合并提交（Cherry-pick）

将特定提交从一个分支移到另一个：

```bash
# 查看要移动的提交
git log --oneline feature/cn-providers

# 切换到目标分支
git checkout fix/upstream-contribution

# 选择性合并提交
git cherry-pick abc123  # 使用实际的 commit hash

# 推送
git push origin fix/upstream-contribution
```

### 处理冲突

Rebase 时遇到冲突：

```bash
# 1. 查看冲突文件
git status

# 2. 编辑文件解决冲突（删除 <<<<<<< 等标记）

# 3. 标记为已解决
git add .

# 4. 继续 rebase
git rebase --continue

# 如果想放弃 rebase
git rebase --abort
```

### 撤销更改

```bash
# 撤销未提交的更改
git checkout -- file.txt

# 撤销最后一次提交（保留更改）
git reset --soft HEAD^

# 撤销最后一次提交（丢弃更改）
git reset --hard HEAD^

# 撤销已推送的提交（创建新提交）
git revert abc123
git push
```

## 📊 检查状态

### 查看分支状态

```bash
# 查看所有分支
git branch -a

# 查看本地分支与远程的关系
git branch -vv

# 查看未合并到 main 的分支
git branch --no-merged main
```

### 查看提交历史

```bash
# 查看当前分支的提交
git log --oneline -10

# 查看图形化历史
git log --oneline --graph --all

# 查看本地分支与上游的差异
git log --oneline upstream/main..main

# 查看功能分支特有的提交
git log --oneline main..feature/cn-providers
```

### 比较差异

```bash
# 比较工作区与最后一次提交
git diff

# 比较两个分支
git diff main..feature/cn-providers

# 查看上游有而本地没有的提交
git log HEAD..upstream/main --oneline
```

## 🎯 最佳实践

### ✅ 推荐做法

1. **保持 main 干净** - main 只用于镜像上游，不直接开发
2. **使用功能分支** - 所有自定义开发在 feature/* 分支进行
3. **定期同步** - 每周同步一次上游更新
4. **有意义的提交信息** - 遵循 [Conventional Commits](https://www.conventionalcommits.org/)
5. **小而频繁的提交** - 每个提交只做一件事
6. **使用 --force-with-lease** - 比 --force 更安全

### ❌ 避免的陷阱

1. **不要在 main 上开发** - 会导致同步困难
2. **不要使用 --force** - 使用 --force-with-lease 代替
3. **不要频繁 merge main 到 feature** - 优先使用 rebase
4. **不要提交敏感信息** - .env、密钥等不要提交
5. **不要创建过大的 PR** - 将大改动拆分成多个小 PR

## 📝 Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type 类型

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具链更新

### 示例

```bash
# 简单提交
git commit -m "feat(qwen): add Qwen TTS provider support"

# 详细提交
git commit -m "fix(oauth): improve type safety in provider resolution

- Add proper type validation with resolveOAuthProvider()
- Remove unsafe 'as any' type casting
- Ensures only valid OAuth providers are processed

Fixes #123"
```

## 🔍 故障排查

### 问题：main 分支领先上游

```bash
# 查看差异
git log upstream/main..main --oneline

# 如果这些提交不重要，重置 main
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease
```

### 问题：功能分支冲突太多

```bash
# 方法 1: 中止 rebase，使用 merge
git rebase --abort
git merge upstream/main
git push

# 方法 2: 重新创建分支
git checkout upstream/main
git checkout -b feature/cn-providers-new
git cherry-pick <commits>  # 选择性合并需要的提交
```

### 问题：推送被拒绝

```bash
# 错误: ! [rejected] main -> main (non-fast-forward)

# 确认远程状态
git fetch origin
git log origin/main..main --oneline

# 如果确认要覆盖远程
git push origin main --force-with-lease
```

## 📚 参考资源

- [Git 官方文档](https://git-scm.com/doc)
- [GitHub Flow](https://docs.github.com/en/get-started/quickstart/github-flow)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Git Rebase vs Merge](https://www.atlassian.com/git/tutorials/merging-vs-rebasing)

## 🆘 获取帮助

如果遇到问题：

1. 查看 Git 状态：`git status`
2. 查看分支关系：`git branch -vv`
3. 查看提交历史：`git log --oneline --graph`
4. 搜索错误信息
5. 在项目 Issues 中寻求帮助

---

**最后更新**: 2026-02-02
**维护者**: Crayfish Bot Team
