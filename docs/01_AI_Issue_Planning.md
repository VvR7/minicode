# AI Issue Planning Guide

> 用途：让 AI 在**开始编码前**完成项目规划、拆分 Issue、建立依赖关系。
>
> 核心原则：**先把任务边界定义清楚，再开始写代码。Issue 是开发任务的事实来源。**

## 1. 先理解仓库

在建立 Issue 前，先检查：

- `README`、目录结构、主要入口
- 当前代码已经实现的能力
- 测试与 CI 命令
- 已有 Open/Closed Issues 和 PR
- 相关历史设计与接口约束

优先使用 `gh` 查看仓库状态，不要仅凭猜测规划。

```bash
gh repo view
gh issue list --state all --limit 100
gh pr list --state all --limit 100
```

## 2. 确定阶段目标

如果任务较大，可以先建立 Milestone；小项目可跳过。

Milestone 只描述一个阶段目标，例如：

```text
v0.1.0 - Minimal Coding Agent
v0.2.0 - Tool System
v0.3.0 - Context & Session
```

不要把实现细节写进 Milestone，细节放到 Issue。

## 3. 拆分 Issue

每个 Issue 应满足：

- 只解决一个明确问题
- 可以独立实现
- 可以独立测试和验收
- 尽量能由一个 PR 完成
- 有清晰的完成标准

不要创建类似“完成整个 Agent 系统”这种过大的 Issue。

## 4. Issue 标准格式

```markdown
# Goal

说明为什么要做，以及最终目标。

## Scope

本 Issue 必须完成：
- ...
- ...

## Out of Scope

本 Issue 明确不做：
- ...
- ...

## Dependencies

- #12
- #15

无依赖则写 `None`。

## Design / Constraints

- 需要保持的现有 API
- 允许修改的模块
- 不能破坏的行为
- 关键接口、数据结构或性能约束

## Acceptance Criteria

- [ ] 功能要求 1
- [ ] 功能要求 2
- [ ] 主要边界情况有测试
- [ ] 现有测试通过
- [ ] typecheck / lint / build 通过（若项目提供）
```

## 5. 建立 Issue 依赖

Issue 应按依赖形成开发顺序，例如：

```text
Core Types
   ↓
LLM Abstraction
   ↓
Tool System
   ↓
Simple Agent
   ↓
ReAct Agent
```

只有前置依赖已经完成的 Issue 才算 Ready。

如果一个 Issue 依赖另一个 Issue，要在 `Dependencies` 中明确写出编号。

## 6. 使用 gh 创建 Issue

创建前先准备好完整正文，再通过 GitHub CLI 建立：

```bash
gh issue create \
  --title "feat: implement tool registry" \
  --body-file /tmp/issue.md
```

如果使用 Milestone，将 Issue 关联到对应 Milestone。

## 7. 规划完成条件

规划阶段结束前，确认：

- 每个 Issue 都有明确边界
- Issue 之间没有明显职责重叠
- 依赖关系合理
- 每个 Issue 都有 Acceptance Criteria
- 没有把未知设计问题留给实现阶段临时决定

完成规划后，**不要直接同时开发多个 Issue**。从一个 Ready Issue 开始逐个推进。
