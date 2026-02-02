# 向上游项目贡献指南

本文档详细说明如何向 [moltbot/moltbot](https://github.com/moltbot/moltbot) 项目贡献代码，以及如何提高 PR 被接受的成功率。

## 📚 贡献前必读

### 1. 了解项目

在贡献前，花时间了解项目：

```bash
# 阅读项目文档
- README.md - 项目介绍和快速开始
- CONTRIBUTING.md - 贡献指南（如果有）
- AGENTS.md - 项目架构说明
- docs/ - 详细文档

# 浏览现有代码
- 了解代码结构和组织方式
- 阅读相关模块的代码
- 理解代码风格和惯例
```

### 2. 查看贡献规范

```bash
# 检查项目是否有贡献指南
cat CONTRIBUTING.md

# 查看 PR 模板
ls .github/PULL_REQUEST_TEMPLATE.md

# 了解提交规范
git log --oneline -20  # 学习现有提交消息格式
```

### 3. 加入社区

- 阅读已有的 Issues 和 PRs
- 了解项目的发展方向
- 关注维护者的反馈模式
- 加入项目的讨论渠道（如果有）

## 🎯 选择合适的贡献内容

### ✅ 容易被接受的贡献

#### 1. 修复明确的 Bug
```markdown
**最佳实践：**
- 有清晰的复现步骤
- 问题已被确认（有 Issue）
- 修复方案简单明确
- 包含测试用例

**示例：**
- 修复 OAuth token 刷新时的类型错误
- 解决特定场景下的崩溃问题
- 修正文档中的错误
```

#### 2. 改进现有功能
```markdown
**最佳实践：**
- 不改变现有 API
- 提升性能或稳定性
- 改进错误处理
- 优化用户体验

**示例：**
- 优化模型选择逻辑的性能
- 改进错误消息的可读性
- 添加缺失的类型定义
```

#### 3. 文档改进
```markdown
**最佳实践：**
- 修正拼写和语法错误
- 补充缺失的文档
- 改进代码示例
- 添加使用说明

**示例：**
- 更新安装指南
- 补充 API 文档
- 修正示例代码
```

#### 4. 测试增强
```markdown
**最佳实践：**
- 提高代码覆盖率
- 添加边界情况测试
- 改进测试可读性

**示例：**
- 为核心功能添加单元测试
- 添加集成测试
- 修复 flaky 测试
```

### ❌ 不容易被接受的贡献

#### 1. 大规模重构
```markdown
**问题：**
- 改动范围太大
- 风险高
- 难以审查
- 可能引入新问题

**替代方案：**
- 拆分成多个小 PR
- 先讨论方案
- 提供详细的理由和测试
```

#### 2. 不符合项目方向的功能
```markdown
**问题：**
- 与项目定位不符
- 增加维护负担
- 可能与规划冲突

**替代方案：**
- 先开 Issue 讨论
- 了解项目 Roadmap
- 考虑做成插件/扩展
```

#### 3. 仅改变代码风格
```markdown
**问题：**
- 不解决实际问题
- 可能引入冲突
- 审查成本高

**替代方案：**
- 与功能改进一起提交
- 等待项目统一进行
- 聚焦于实质性改进
```

## 🚀 PR 最佳实践

### 准备工作

#### 1. 创建 Issue（推荐）

在开始编码前，先创建或关联一个 Issue：

```markdown
**Issue 标题示例：**
- Bug: OAuth token refresh fails for qwen-portal provider
- Feature: Add support for Qwen embedding models
- Docs: Update installation guide for Windows users

**Issue 内容应包含：**
1. 问题描述或功能需求
2. 复现步骤（对于 Bug）
3. 期望的行为
4. 可能的解决方案（可选）
5. 愿意提交 PR（表明意愿）
```

**等待反馈：**
- 维护者确认问题
- 讨论解决方案
- 获得绿灯后再开始编码

#### 2. 创建干净的分支

```bash
# 确保从最新的上游创建
git checkout main
git pull upstream main
git checkout -b fix/oauth-type-safety

# 分支命名规范：
# - fix/description    - Bug 修复
# - feat/description   - 新功能
# - docs/description   - 文档更新
# - refactor/description - 重构
# - test/description   - 测试相关
# - chore/description  - 构建/工具链
```

### 编写代码

#### 1. 遵循项目规范

```typescript
// ✅ 好的代码
export function resolveOAuthProvider(provider: string): OAuthProvider | null {
  if (!OAUTH_PROVIDER_IDS.has(provider)) {
    return null;
  }
  return provider as OAuthProvider;
}

// ❌ 不好的代码
export function resolveOAuthProvider(provider: any): any {
  return provider as OAuthProvider;  // 不安全的类型转换
}
```

#### 2. 保持改动最小化

```markdown
**原则：**
- 一个 PR 只做一件事
- 不要包含不相关的改动
- 不要重新格式化无关代码
- 不要修改不必要的空白符

**示例：**
✅ 好的 PR：修复 OAuth 类型安全问题（3 个文件，50 行改动）
❌ 不好的 PR：修复 OAuth + 重构模型配置 + 更新文档（20 个文件，500 行改动）
```

#### 3. 添加测试

```typescript
// 为新功能添加测试
describe('resolveOAuthProvider', () => {
  it('should return null for invalid provider', () => {
    expect(resolveOAuthProvider('invalid')).toBeNull();
  });

  it('should return provider for valid provider', () => {
    expect(resolveOAuthProvider('anthropic')).toBe('anthropic');
  });
});
```

#### 4. 更新文档

```markdown
**需要更新的文档：**
- README.md（如果影响安装或使用）
- 相关的 docs/*.md 文件
- API 文档
- 代码注释（复杂逻辑）
- CHANGELOG.md（如果项目维护）
```

### 提交代码

#### 1. 写好的提交消息

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```bash
# 格式
<type>(<scope>): <subject>

<body>

<footer>

# 示例 1: 简单的 Bug 修复
git commit -m "fix(oauth): improve type safety in provider resolution

- Add resolveOAuthProvider helper function
- Remove unsafe 'as any' type casting
- Add validation for OAuth provider IDs

Fixes #123"

# 示例 2: 新功能
git commit -m "feat(embedding): add Qwen embedding provider

- Support Qwen embedding models
- Add configuration options
- Include tests for new provider

Related to #456"

# 示例 3: 文档更新
git commit -m "docs(install): update Windows installation guide

- Add PowerShell UTF-8 encoding setup
- Include troubleshooting section
- Update screenshot"
```

**提交消息最佳实践：**
- 使用英文
- 第一行不超过 72 字符
- 使用现在时态（"add" 而不是 "added"）
- 说明"为什么"而不只是"做了什么"
- 关联相关的 Issue

#### 2. 保持提交历史清晰

```bash
# 如果有多个小提交，考虑合并
git rebase -i HEAD~3  # 交互式 rebase 最近 3 个提交

# 选项：
# pick   - 保留提交
# squash - 合并到前一个提交
# reword - 修改提交消息
# drop   - 删除提交
```

### 创建 Pull Request

#### 1. PR 标题

```markdown
**好的标题：**
✅ fix(oauth): improve type safety in provider resolution
✅ feat(qwen): add Qwen embedding provider support
✅ docs(install): update Windows installation guide

**不好的标题：**
❌ Fixed a bug
❌ Update code
❌ [WIP] Various changes
```

#### 2. PR 描述模板

```markdown
## 描述
简短说明这个 PR 做了什么。

## 动机和上下文
为什么需要这个改动？解决了什么问题？

Fixes #123
Related to #456

## 改动类型
- [ ] Bug 修复（不破坏现有功能的改动）
- [ ] 新功能（不破坏现有功能的新增）
- [ ] 破坏性改动（修复或功能导致现有功能不工作）
- [ ] 文档更新

## 改动内容
- 添加了 resolveOAuthProvider 函数用于类型验证
- 移除了不安全的 'as any' 类型转换
- 更新了相关测试用例

## 测试
描述你如何测试这些改动：
- [ ] 通过了现有测试
- [ ] 添加了新的测试用例
- [ ] 手动测试了以下场景：
  - OAuth 登录流程
  - Token 刷新
  - 错误处理

## 屏幕截图（如果适用）
添加截图以帮助说明改动。

## 检查清单
- [ ] 代码遵循项目代码风格
- [ ] 进行了自我代码审查
- [ ] 添加了必要的注释（特别是难以理解的部分）
- [ ] 更新了相关文档
- [ ] 改动不产生新的警告
- [ ] 添加了证明修复有效或功能正常的测试
- [ ] 新测试和现有测试都通过
- [ ] 依赖的改动已经合并和发布
```

#### 3. PR 大小控制

```markdown
**理想的 PR 大小：**
- 小型：1-100 行改动（最容易审查）
- 中型：100-500 行改动（需要仔细审查）
- 大型：500+ 行改动（考虑拆分）

**如何拆分大 PR：**
1. 按功能拆分（重构 → 新功能 → 测试）
2. 按模块拆分（模块 A → 模块 B → 集成）
3. 按阶段拆分（第一阶段 → 第二阶段）
```

## 🎯 提高 PR 成功率的技巧

### 1. 响应式沟通

```markdown
**快速响应：**
- 24-48 小时内回复审查意见
- 主动说明需要时间的情况
- 保持礼貌和专业

**有效沟通：**
✅ "感谢审查！我会更新类型定义并添加测试用例。预计明天完成。"
✅ "这是个好建议。我有个替代方案：[说明方案]。你觉得哪个更好？"
❌ "这个改动是对的，不需要修改。"
❌ [无回应]
```

### 2. 虚心接受反馈

```markdown
**好的反应：**
✅ 理解审查意见的出发点
✅ 询问不清楚的地方
✅ 提出建设性的讨论
✅ 快速修改并解释改动

**避免：**
❌ 防御性反应
❌ 忽视反馈
❌ 争论代码风格
❌ 人身攻击
```

### 3. 主动改进

```markdown
**在审查之前：**
- 自己先审查一遍代码
- 运行所有测试
- 检查代码风格
- 更新相关文档
- 添加必要的注释

**在审查之后：**
- 逐一回应每个意见
- 标记已解决的问题
- 说明未采纳意见的原因
- 请求重新审查
```

### 4. 保持 PR 更新

```bash
# 如果上游有新的改动，及时 rebase
git fetch upstream
git rebase upstream/main

# 解决冲突
# ... 解决冲突 ...
git add .
git rebase --continue

# 强制推送更新的分支
git push origin fix/oauth-type-safety --force-with-lease
```

### 5. 耐心等待

```markdown
**理解维护者的时间：**
- 维护者可能很忙
- 审查需要时间和精力
- 可能在等待其他改动
- 可能在重新考虑方案

**合理的等待时间：**
- 小 PR：3-7 天
- 中等 PR：1-2 周
- 大 PR：2-4 周

**如果长时间无响应：**
- 礼貌地 ping 一下（2 周后）
- 询问是否需要改进
- 检查是否有遗漏的反馈
```

## 📝 PR 示例分析

### 示例 1: 优秀的 PR

```markdown
标题：fix(oauth): improve type safety in provider resolution

描述：
这个 PR 改进了 OAuth provider 解析的类型安全性。

**问题：**
当前代码使用 `as any` 进行类型转换，可能导致运行时错误。

**解决方案：**
- 添加 `resolveOAuthProvider` 辅助函数
- 使用 Set 进行 provider 验证
- 添加 null 检查

**测试：**
- 添加了单元测试覆盖正常和错误情况
- 所有现有测试通过
- 手动测试了 OAuth 流程

Fixes #123

**为什么优秀：**
✅ 清晰的问题描述
✅ 明确的解决方案
✅ 完整的测试
✅ 关联了 Issue
✅ 改动范围小且专注
```

### 示例 2: 需要改进的 PR

```markdown
标题：Update code

描述：
Fixed some bugs and added new features.

**问题：**
❌ 标题不清晰
❌ 描述太简短
❌ 没有说明具体改动
❌ 没有关联 Issue
❌ 可能包含多个不相关的改动

**改进建议：**
1. 使用清晰的标题
2. 详细描述每个改动
3. 拆分成多个 PR
4. 添加测试说明
5. 关联相关 Issue
```

## 🔍 常见问题

### Q1: PR 被拒绝了怎么办？

```markdown
**步骤：**
1. 理解拒绝的原因
2. 询问是否有改进空间
3. 考虑替代方案
4. 如果合理，接受决定

**记住：**
- 拒绝不是针对个人
- 可能不符合项目方向
- 时机可能不对
- 可以将来重新提出
```

### Q2: 需要多长时间才能被合并？

```markdown
**影响因素：**
- PR 质量
- 项目活跃度
- 维护者时间
- 改动复杂度
- 测试覆盖率

**加速合并：**
- 保持 PR 小而专注
- 快速响应反馈
- 提供完整的测试
- 清晰的文档
```

### Q3: 如何处理审查意见不一致？

```markdown
**处理方式：**
1. 理解双方观点
2. 提出数据或例子支持
3. 寻求第三方意见
4. 尊重最终决定

**示例回复：**
"我理解你的担心。这是我的考虑：[说明理由]。
不过如果你认为 [另一种方案] 更好，我很乐意采纳。"
```

### Q4: 可以直接提交大的重构 PR 吗？

```markdown
**答案：不推荐**

**更好的方式：**
1. 先开 Issue 讨论
2. 获得维护者同意
3. 制定重构计划
4. 拆分成小 PR
5. 逐步提交

**示例：**
Issue: "提议：重构 OAuth 模块"
→ PR1: "重构：提取 OAuth 类型定义"
→ PR2: "重构：简化 token 刷新逻辑"
→ PR3: "重构：统一错误处理"
```

## 📚 参考资源

### 必读文档
- [Conventional Commits](https://www.conventionalcommits.org/)
- [GitHub PR 最佳实践](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests)
- [如何写好提交消息](https://cbea.ms/git-commit/)

### 工具推荐
```bash
# 提交消息规范检查
npm install -g commitlint

# 代码风格检查
npm run lint

# 运行测试
npm test

# 类型检查
npm run type-check
```

## 🎓 学习路径

### 第一次贡献
1. 从小改动开始（文档、注释）
2. 修复简单的 Bug
3. 添加测试
4. 改进错误消息
5. 优化性能

### 进阶贡献
1. 实现新功能
2. 重构代码
3. 架构改进
4. 性能优化
5. 设计决策参与

## 💡 最后的建议

### 成功贡献者的特质
1. **耐心** - 审查需要时间
2. **谦虚** - 虚心接受反馈
3. **专注** - 小而精的改动
4. **负责** - 跟进到合并
5. **沟通** - 清晰友好的交流

### 记住
```markdown
一个好的 PR：
- 解决一个明确的问题
- 改动范围小且专注
- 包含完整的测试
- 文档齐全
- 响应迅速
- 遵循项目规范

贡献代码不仅是写代码，更是：
- 理解项目需求
- 与社区协作
- 学习和成长
- 建立信任
```

---

**祝你贡献顺利！🎉**

如果有任何问题，可以：
1. 查看项目的 Issues 和 Discussions
2. 礼貌地向维护者请教
3. 参考其他成功的 PR

记住：每个成功的开源贡献者都是从第一个 PR 开始的！
