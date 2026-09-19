# minicode

minicode 是一个本地运行的 TypeScript coding agent。目标形态包括常驻 Core daemon、CLI 与
TUI 前端、类型化 IPC、事件流、工具与权限系统、任务规划、会话记忆、上下文压缩、子 Agent
以及 MCP 外部工具接入。

当前版本实现了本地 coding agent 闭环：常驻 `mc-core`、一次性 `mc-ping`、用于单轮测试的
`mc --goal`，以及支持持久多轮会话、恢复和多窗口同步的 `mc-tui`。Core 统一拥有 AgentLoop、
历史、notes、run 级任务图、上下文压缩、Trace 和事件流。

Stage3 的 Core 权限层已接入。主 Agent 默认使用 `bypasspermission`，省略人工审批但仍执行
参数校验、路径约束和危险 Bash 强制拒绝；设置 `MINICODE_PERMISSION_MODE=alwaysask` 后，
`write`／`edit` 及非白名单 `bash` 会挂起等待 `permission.respond`。`mc --goal` 在交互终端支持
允许／拒绝一次及 session 内 always 决策；没有交互 TTY 时自动拒绝一次。
审批与进度写 stderr，assistant 输出仍写 stdout。
TUI 在 transcript 内展示审批摘要，支持方向键／Tab 加 Enter，以及 1–4 快捷键；Ctrl-C 仍可取消 run。
通用工具为 `read`、`write`、`edit`、`bash`，保留任务和笔记工具。工具参数先严格校验，
再审批、执行和有限重试。workspace 不是沙箱：允许外部绝对路径和符号链接目标；
Bash 权限规则是启发式检测，不能代替系统隔离。
详细行为见 [Core 工具权限生命周期](STAGE3_PERMISSIONS.md)。

Stage4 上下文管理已接入：每次模型调用前按需生成可恢复的增量摘要，TUI 支持 `/compact [focus]`，
模型超窗时压缩后重试一次。完整历史保持可审计，压缩事件与占用在多窗口同步。
默认 reserve 为 16384 token、近期原文保留目标为 20000 token。详见 [Stage4 上下文管理](STAGE4_CONTEXT.md)。

Stage5 已接入 Skills、同步/后台子 Agent、MCP 外部工具及工具批次并行。配置示例、隔离边界和完整验证矩阵见 [Stage5 扩展能力](STAGE5_EXTENSIONS.md)。

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

配置好 `.env` 中的 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 后，启动交互会话：

```bash
bun run tui
```

启动时的规范化当前目录固定为 session 的 `workspaceRoot`；恢复会话时也必须从同一 workspace
启动。符号链接会解析为真实路径，session 创建后不会随进程 cwd 改变。

需要单轮回归测试时，可使用 one-shot 入口（assistant 文本写 stdout，进度写 stderr）：

```bash
bun run mc --goal "Read README.md and summarize it"
```

`mc --goal` 不提供多轮会话；Ctrl-C 会取消 run 并以退出码 130 结束。退出码 0 表示成功、1
表示 run 失败、2 表示参数或配置错误。

Core 默认监听 `127.0.0.1:7437`。可通过 `.env` 中的 `MINICODE_CORE_HOST` 和
`MINICODE_CORE_PORT` 修改 loopback 地址；当前不允许监听非本机地址。
`MINICODE_PERMISSION_MODE` 可设为 `bypasspermission`（默认）或 `alwaysask`，在 Core 启动时固定。
子 Agent 始终默认 bypass，不继承主 Agent 的 `alwaysask`。
持久化数据默认写入 `~/.minicode`，可通过绝对路径 `MINICODE_HOME` 覆盖。模型上下文预算由
`LLM_CONTEXT_WINDOW_TOKENS` 和 `LLM_MAX_OUTPUT_TOKENS` 控制，省略时分别使用 200000 和 8192；
无法容纳的固定规则、工具定义或本轮提问会在创建 turn/run 前被拒绝。自动压缩开关与预算配置
见 `.env.example` 和 [Stage4 上下文管理](STAGE4_CONTEXT.md)。

## 终端界面（TUI）

启动 Core 并配置好 LLM 后，在目标 workspace 中选择一种启动方式：

```bash
bun run tui                         # 新建 chat
bun run tui --goal "Read README" # 新建 chat 并提交首条消息
bun run tui --continue           # 恢复当前 workspace 最近的 chat
bun run tui --session <uuid>     # 打开指定 session（one-shot 只读）
bun run tui --sessions           # 打开 session selector
```

两个 TUI 附着同一 session 时会重放同一持久事件并同步后续文本、工具、任务和终态；不同
session 的 history、事件、取消和磁盘数据相互隔离。中途附着也会将持久文本前缀与 live 后缀
按 sequence 去重合并。`corrupted` session 可在 selector 中诊断，但不可继续；当前没有
close/delete/rename 操作。

快捷键（纯键盘，不支持鼠标）：

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交输入 |
| `Ctrl+Enter` | 在输入框换行 |
| `Ctrl-C` | 有草稿时清空草稿；运行中请求取消 |
| `/new` | 当前 workspace 新建 chat |
| `/compact [focus]` | 空闲时压缩上下文，可指定摘要关注方向 |
| `/exit` | 空闲时退出 |
| `PgUp` / `PgDn` | 向上/向下翻页 |
| `Ctrl+Home` / `Ctrl+End` | 跳到日志开头/结尾 |

selector 使用 `↑/↓` 或 `j/k` 选择、Enter 打开、Tab 切换当前/全部 workspace、`O` 显示或隐藏
one-shot、Esc 退出。输入区中的普通 `q` 只是文本，不是退出键。底部固定显示 workspace、最近一次
模型请求的上下文占用/总窗口和当前模型；逐调用 Usage 不写入 transcript。Assistant 回复按 Markdown
渲染，终端标记以稳定文字和颜色区分 `YOU`、`ASSISTANT`、`TURN`、`TOOL`、`TASK` 与 `ERROR`。

详细说明见 [TUI 使用说明](TUI.md)。

## 用户维护的上下文

每个 run 开始时读取 `MINICODE_HOME/CONTEXT.md`（默认 `~/.minicode/CONTEXT.md`）和
当前 session 的 `workspaceRoot/CONTEXT.md`。提示词按基础规则、全局规则、项目规则和 session notes
顺序组装；项目与全局规则冲突时项目规则优先。不搜索祖先或子目录。
空文件和不存在的文件会跳过，其他读取错误会明确报错；修改将在下一次提问生效，运行中使用固定快照。

## 会话、任务与 Trace

所有中间文件都位于 `MINICODE_HOME`，不会写进 workspace：

```text
sessions/<sessionId>/meta.json
sessions/<sessionId>/history.jsonl
sessions/<sessionId>/notes.md
sessions/<sessionId>/session-events.jsonl
sessions/<sessionId>/runs/<runId>/{run.json,events.jsonl,trace.jsonl,tasks.json}
```

目录权限为 `0700`，文件权限为 `0600`。只有成功且工具消息配对完整的 turn 会进入下一轮上下文；
failed/cancelled/interrupted turn 保留用于审计。notes 属于 session，TaskManager 和 `tasks.json`
只属于单个 run，下一轮从空任务图开始。

Trace 默认开启，`summary` 只保留结构、名称、状态和用量；`full` 保留经容量限制后的业务 payload。
两种模式都会递归脱敏 credential。Trace 使用有界队列和文件上限，写入失败只丢弃 Trace，不改变
Agent 终态；当前没有 Trace viewer。配置项和完整设计见 [架构与持久化](ARCHITECTURE.md)。

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

- [架构与持久化（Stage2–Stage5）](ARCHITECTURE.md)
- [Stage2 验证矩阵](STAGE2_TEST_MATRIX.md)
- [Stage3 权限与工具](STAGE3_PERMISSIONS.md)
- [Stage3 验证矩阵](STAGE3_TEST_MATRIX.md)
- [Stage4 上下文管理与验证矩阵](STAGE4_CONTEXT.md)
- [Stage5 扩展能力、配置与验证矩阵](STAGE5_EXTENSIONS.md)
- [TUI 使用说明](TUI.md)
- [Wire protocol](WIRE_PROTOCOL.md)

## Skills

技能从项目 `.minicode/skills/<目录>/SKILL.md` 和全局 `$MINICODE_HOME/skills/<目录>/SKILL.md` 发现（默认 `~/.minicode/skills`）。文件以 YAML frontmatter 开头：

```markdown
---
name: explain
description: 解释项目代码
---
阅读相关代码，说明调用过程。
```

项目技能按 `name` 覆盖全局技能，无效文件跳过并显示诊断。每轮运行重新发现，system prompt 只列出名称、描述和路径。

TUI 输入 `/skill`，或运行 `mc --goal "/skill"` 列出目录，不调用模型。`/skill explain [参数]` 将正文及参数加入本轮用户消息；未知技能在创建轮次前拒绝。展开内容计入上下文预算并持久保存在模型历史中，后续修改技能文件不会改变历史。技能不会改变工具权限。

## 子 Agent 类型

主 Agent 通过 `list_subagent` 实时发现可用类型。内置 `planner` 和 `reviewer` 仅允许 `read`，返回文本计划或审核结果；`executor` 可以读写文件、运行 Shell 并管理自己的任务。项目 `.minicode/agents/<name>.toml` 覆盖同名内置类型，文件名决定名称：

```toml
[agent]
description = "读取并分析项目"
system_prompt = "阅读相关文件并返回分析结果。"
allowed_tools = ["read"]
```

三个字段均必填，`allowed_tools = []` 表示无工具。白名单使用完整工具名称（包括 `mcp__<server>__<tool>`），未知工具或嵌套委派工具会被拒绝。类型使用父 Agent 的模型。

MCP 配置可写入 `~/.minicode/config.toml`（或 `MINICODE_HOME/config.toml`）及项目的 `.minicode/config.toml`。项目同名服务器覆盖全局配置；全局配置在 Core 启动时固定，项目配置在首次使用工作区时固定，修改后需重启 Core。

```toml
[[mcp.servers]]
name = "local"
transport = "stdio"
command = "bun"
args = ["/absolute/path/to/server.ts"]
execute_mode = "parallel" # 可选，也可设为 serial

[[mcp.servers]]
name = "remote"
transport = "http" # Streamable HTTP
url = "http://127.0.0.1:8080/mcp"
[mcp.servers.headers]
Authorization = "Bearer ${MCP_TOKEN}"
```

stdio 服务器以当前工作区为 cwd，支持 `env` 字符串表；命令、参数、环境变量、HTTP 地址及 headers 支持 `${ENV_NAME}` 引用。发现的工具使用 `mcp__<server>__<tool>` 名称，保留原始 JSON Schema 并在本地校验。主 Agent 处于 `alwaysask` 时外部工具需要审批，Always 决策只作用于当前 session 的完整工具名，重启不保留；`bypasspermission` 及子 Agent 省略人工审批。工具调用遵循批次并行规则，不自动重试；文本与结构化结果进入模型上下文，图片、音频及嵌入资源以类型或地址摘要展示。

主 Agent 可先用 `list_subagent` 查找类型，再调用 `spawn_agent({ name, goal, context? })` 同步委派。子 Agent 使用相同模型及工作区，继承本轮固定的规则和 Skills 目录，仅接收显式任务和上下文，不继承父历史或 session notes。每个子 Agent 最多执行 20 步，工具来自类型文件中的完整名称白名单，禁止嵌套委派。

子历史、任务、私有 notes、压缩 checkpoint 和事件审计保存在 `sessions/<sessionId>/runs/<parentRunId>/subagents/<childRunId>/`。子 Agent 默认 bypass，不产生人工审批事件；父事件流仅收到生命周期摘要。取消和停机会排空子执行，重启将未结束的子记录标记为 interrupted，不自动续跑。

`spawn_agent({ name, goal, context?, background: true })` 在子执行启动后返回 `childRunId`，父 Agent 可继续其他工作。`agent_result({ childRunId, wait? })` 查询当前父 run 拥有的子任务；`wait: true` 等待终态，仍响应取消。后台结果默认在父模型下一次调用前以普通用户上下文交付一次，显式查询终态后不再自动重复交付。父 Agent 准备结束时会等待剩余子任务并继续综合结果，额外模型调用计入父步数限制。后台任务仅存活于本轮 run，不能跨 turn 查询；CLI/TUI 显示子身份、生命周期和终态摘要，多窗口重放按事件序列去重。

同步返回、后台查询和自动交付使用相同的结构化终态，包含 `childRunId`、`name`、`status`、
`reason`、可选 `errorCode`、`steps` 与有界 `content`。例如上下文溢出会保留
`errorCode=context_limit_exceeded`，达到步数上限会返回 `reason=max_steps`；父 Agent 应据此缩小
任务或调整已配置预算，不应原样盲目重试。
