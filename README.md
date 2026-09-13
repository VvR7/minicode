# minicode

minicode 是一个本地运行的 TypeScript coding agent。目标形态包括常驻 Core daemon、CLI 与
TUI 前端、类型化 IPC、事件流、工具与权限系统、任务规划、会话记忆、上下文压缩、子 Agent
以及 MCP 外部工具接入。

当前版本实现了第一阶段通信闭环：`mc-core` 前台进程与一次性 `mc-ping` 健康检查。

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

启动 Core：

```bash
bun run core
```

在另一个终端验证连通：

```bash
bun run ping
# pong server=0.0.1 uptime=12ms latency=2ms
```

Core 默认监听 `127.0.0.1:7437`。可通过 `.env` 中的 `MINICODE_CORE_HOST` 和
`MINICODE_CORE_PORT` 修改 loopback 地址；当前不允许监听非本机地址。

提交前运行：

```bash
bun run format:check
bun run lint
bun run typecheck
bun run protocol:docs:check
bun run test:unit
bun run test:integration
bun run test:coverage
bun run coverage:check
bun run build
```

`test:coverage` 会生成 text 与 LCOV 报告；`coverage:check` 要求所有生产源码进入
LCOV，并要求整体行覆盖率和函数覆盖率均不低于 81%。`bun run test` 仍可用于一次运行全部
单元测试和集成测试。

需要自动修复格式时运行 `bun run format`。

## Workspace

| 包 | 职责 |
| --- | --- |
| `@minicode/protocol` | JSON-RPC、Ping/Pong 和 Core 地址的 Zod schema |
| `@minicode/core` | Bun TCP/NDJSON server 与 `mc-core` 入口 |
| `@minicode/cli` | 一次性 `mc-ping` 客户端 |
| `@minicode/tui` | 预留给终端 UI 前端 |

## 文档

- [Wire protocol](WIRE_PROTOCOL.md)
