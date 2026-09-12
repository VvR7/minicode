# 目标
使用Typescript开发一个本地运行的coding agent：minicode。它有常驻的Core daemon，有CLI和TUI两种前端，有类型化的IPC协议，有事件流，有工具调用、任务规划、会话记忆、权限审批、上下文压缩、子agent和MCP外部工具接入。

# 项目原型
@/home/david/project/KamaClaude 是本项目的python实现版本，它的通信协议、进程结构是我们需要参考的地方，但这个项目目前的一个很大的问题是没有进行对话隔离。

开发时应尽可能参考 KamaClaude 的代码架构和实现方式；其功能问题可以修正，但应优先沿用其标准的模块划分、职责边界与调用结构。

# AI Development Workflow

- 规划功能、拆分任务、创建 Issue/Milestone 时，先阅读：
  `docs/01_AI_Issue_Planning.md`

- 开发已有 Issue 时，先阅读：
  `docs/02_AI_Issue_Development.md`

- Issue 是任务范围的事实来源，不得擅自扩大范围。
- 开发完成后必须测试并创建 PR；创建 PR 后停止，不要自行 Merge。

# 用户偏好
编写代码时需要添加必要的中文注释
