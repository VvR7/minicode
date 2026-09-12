# minicode

minicode 是一个本地运行的 TypeScript coding agent。目标形态包括常驻 Core daemon、CLI 与
TUI 前端、类型化 IPC、事件流、工具与权限系统、任务规划、会话记忆、上下文压缩、子 Agent
以及 MCP 外部工具接入。

当前仓库只包含工程脚手架，尚未实现业务能力。

## 环境要求

- macOS 或 Linux
- Bun 1.4.2

## 开始开发

```bash
git clone https://github.com/VvR7/minicode.git
cd minicode
bun install --frozen-lockfile
cp .env.example .env
```

提交前运行：

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

需要自动修复格式时运行 `bun run format`。

## Workspace

| 包 | 职责 |
| --- | --- |
| `@minicode/protocol` | 预留给 IPC schema 和共享协议类型 |
| `@minicode/core` | 预留给 daemon 与 Agent 能力 |
| `@minicode/cli` | 预留给命令行前端 |
| `@minicode/tui` | 预留给终端 UI 前端 |

## 文档

- [项目概览与原型调研](docs/03_Project_Overview.md)
- [TypeScript 编码规范](docs/04_TypeScript_Coding_Standards.md)
- [AI Issue 规划流程](docs/01_AI_Issue_Planning.md)
- [AI Issue 开发流程](docs/02_AI_Issue_Development.md)
