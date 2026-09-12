# minicode 项目概览与原型调研

## 项目目标

minicode 计划使用 TypeScript 开发一个本地 coding agent，最终包含常驻 Core daemon、CLI 和
TUI 两种前端、类型化 IPC、事件流、工具调用、任务规划、会话记忆、权限审批、上下文压缩、
子 Agent 和 MCP 外部工具接入。

本文只记录启动项目所需的背景，不是完整架构设计。具体接口、技术选型和实现方案应在对应
GitHub Issue 中单独讨论。

## Python 原型中可参考的部分

已阅读 KamaClaude 的源码、测试和设计文档。原型提供了这些可复用的经验：

- Core daemon 与 CLI/TUI 分进程，前端通过本地 IPC 访问 Core；
- 命令使用 JSON-RPC 风格的请求/响应，运行过程通过事件流推送；
- Core 内有会话管理、Agent loop、工具注册、权限管理和事件持久化；
- 同一会话串行运行，不同会话可以并发；
- 上下文压缩、子 Agent 与 MCP 均由 Core 统一管理生命周期。

这些内容只作为后续设计的参考，不表示 minicode 必须逐项照搬 Python 实现。

## 必须避免的问题

Python 原型的会话历史虽然按 `session_id` 保存，但 TUI 默认订阅全局事件。因此一个会话产生的
token、工具调用、权限请求和状态事件可能被其他 TUI 收到，甚至影响其他界面的输入状态。

minicode 后续设计 IPC、事件和权限系统时，必须把会话隔离作为验收要求：服务端和客户端都要
验证事件归属，权限响应也不能只依赖一个工具调用 ID。具体方案留给相应 Issue 决定。

## 当前脚手架边界

仓库暂时建立 `protocol`、`core`、`cli`、`tui` 四个空 workspace，并配置 Bun、TypeScript、
Biome、Zod、基础环境变量模板和 CI。当前不包含协议 schema、daemon、Agent 或前端实现。
