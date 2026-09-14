# minicode

minicode 是一个本地运行的 TypeScript coding agent。目标形态包括常驻 Core daemon、CLI 与
TUI 前端、类型化 IPC、事件流、工具与权限系统、任务规划、会话记忆、上下文压缩、子 Agent
以及 MCP 外部工具接入。

当前版本实现了本地 coding agent 闭环：常驻 `mc-core` 前台进程、一次性 `mc-ping` 健康检查，
`mc --goal` 流式 AgentLoop（只读工具调用 + 事件流 + 断线恢复），以及 `mc-tui` 交互式终端界面。

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
# pong server=0.1.0 uptime=12ms latency=2ms
```

配置好 `.env` 中的 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 后，以当前目录为 workspace
发起一次 run（assistant 文本写 stdout，进度写 stderr）：

```bash
bun run mc --goal "Read README.md and summarize it"
```

Ctrl-C 会取消当前 run 并以退出码 130 结束；退出码 0 表示成功、1 表示 run 失败、2 表示参数或配置错误。

Core 默认监听 `127.0.0.1:7437`。可通过 `.env` 中的 `MINICODE_CORE_HOST` 和
`MINICODE_CORE_PORT` 修改 loopback 地址；当前不允许监听非本机地址。
持久化事件默认写入 `~/.minicode`，可通过绝对路径 `MINICODE_HOME` 覆盖。

## 终端界面（TUI）

启动 Core 并配置好 LLM 后，以目标目录作为 workspace 启动交互式 TUI：

```bash
bun run tui --goal "Read README.md and summarize it"
```

TUI 以启动目录作为 workspaceRoot，连接正在运行的 Core，实时展示本次 run 的
run/step/tool/LLM 事件流与 assistant 流式输出；Core 未运行时持续重试并在顶部状态栏显示连接状态。
界面为顶部状态栏 + 可滚动事件日志 + 底部快捷键提示。

快捷键（纯键盘，不支持鼠标）：

| 按键 | 作用 |
| --- | --- |
| `q` | 空闲/结束后退出；运行中首次按下请求取消，再次按下强制退出 |
| `Ctrl-C` | 运行中取消当前 run |
| `↑` / `↓` | 向上/向下滚动事件日志 |
| `PgUp` / `PgDn` | 向上/向下翻页 |
| `Home` / `End` | 跳到日志开头/结尾 |

退出码：`0` 成功、`1` run 失败、`2` 参数/配置错误或非 TTY 环境、`130` 用户取消或中断。

当前限制：一次 TUI 进程只发起并展示一个隔离 run，结束后按 `q` 退出；不支持交互聊天、
多 run 列表、历史 run 回放和鼠标操作。需要这些能力时请另建 Issue。

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
| `@minicode/client` | CLI/TUI 共用的持久 RPC client 与 typed Agent run controller |
| `@minicode/cli` | `mc-ping` 健康检查与 `mc --goal` 客户端 |
| `@minicode/tui` | `mc-tui` 交互式终端界面 |

## 文档

- [Wire protocol](WIRE_PROTOCOL.md)
