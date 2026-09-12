# AI Issue Development Guide

> 用途：让 AI 根据一个已经定义好的 GitHub Issue 完成编码、自测，并创建 PR。
>
> 核心原则：**严格按 Issue 开发，不自行扩大范围。代码完成后必须验证，再提出 PR。**

## 1. 开始前先读取 Issue

开始编码前必须确认：

1. 当前 Issue 的 Goal
2. Scope / Out of Scope
3. Dependencies
4. Design / Constraints
5. Acceptance Criteria
6. 相关现有代码和测试

推荐：

```bash
gh issue view <issue-number> --comments
```

如果 Issue 边界不完整、存在冲突或依赖尚未完成，**先停止编码并说明问题**，不要自行猜测需求。

## 2. 建立工作分支

从最新目标分支创建独立分支：

```bash
git switch main
git pull --ff-only
git switch -c feat/<short-name>
```

常用命名：

```text
feat/<name>
fix/<name>
refactor/<name>
test/<name>
docs/<name>
```

## 3. 按 Issue 实现

实现时遵守：

- 只修改当前 Issue 必需的内容
- 不顺手进行无关重构
- 不擅自改变公共 API 或架构
- 新功能补测试
- Bug 修复尽量先补失败测试
- 发现额外问题时，不扩大当前 Issue；记录并另建 Issue

如果实现过程中必须修改原设计，应先更新 Issue 或说明原因，再继续。

## 4. 主动验证

代码写完后，AI 必须自己运行项目已有的验证命令。

根据项目实际情况执行，例如：

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

或 Bun 项目：

```bash
bun test
bun run typecheck
bun run lint
bun run build
```

不要只说“应该能运行”。必须实际执行并处理失败。

同时检查 Issue 的每一条 Acceptance Criteria。

## 5. 提交代码

确认 `git diff` 只包含当前 Issue 相关改动：

```bash
git status
git diff
```

然后提交：

```bash
git add <files>
git commit -m "feat: implement ..."
git push -u origin HEAD
```

提交信息保持简洁并描述本次改动。

## 6. 创建 PR

PR 必须关联当前 Issue。

如果该 PR 完整实现 Issue，在正文中使用：

```text
Closes #123
```

如果只是阶段性 PR，使用：

```text
Refs #123
```

推荐 PR 正文：

```markdown
## Summary

- 实现了什么
- 关键设计点

## Validation

- `bun test` ✅
- `bun run typecheck` ✅
- `bun run lint` ✅
- `bun run build` ✅

## Issue

Closes #123
```

创建：

```bash
gh pr create \
  --title "feat: implement ..." \
  --body-file /tmp/pr.md
```

## 7. 提出 PR 后停止

PR 创建完成后：

- 输出 PR 编号和链接
- 简要说明实现内容
- 列出执行过的验证命令及结果
- 指出仍存在的已知限制（如有）

**不要自行 Merge。**

后续 Review、修改和 Merge 由外部 Reviewer 或后续流程处理。

## Definition of Done

只有满足以下条件，才可以提出 PR：

- [ ] Issue Scope 已完成
- [ ] 没有越过 Out of Scope
- [ ] Acceptance Criteria 已逐项检查
- [ ] 必要测试已增加
- [ ] 测试通过
- [ ] typecheck / lint / build 通过（若项目提供）
- [ ] PR 已正确关联 Issue
