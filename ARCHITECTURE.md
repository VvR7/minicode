# 架构与持久化（Stage2 / Stage3）

## 进程与数据流

TUI 不直接调用模型。`SessionController` 通过类型化 JSON-RPC 连接常驻 Core；Core 的
`SessionManager` 负责 admission、上下文预算、每个 session 的串行执行与终态提交，
`AgentRunner` 为每个 run 创建独立 AgentLoop、工具注册表和 TaskManager。provider 只接收
provider-neutral messages，因此底层模型由 Core 的环境配置屏蔽。

```text
TUI -> SessionController -> IPC -> SessionManager -> AgentRunner -> LLM provider
                                  |                  |
                                  |                  +-> run tools / TaskManager
                                  +-> history / notes / session events
```

启动 TUI 时，规范化的 `cwd` 成为新 session 的固定 `workspaceRoot`。恢复只允许在相同
workspace 中进行；不同 session 的 active run、事件订阅、取消和持久数据都按 sessionId/runId
隔离。同一 session 只允许一个 active turn，不同 session 可以并行。工具文件路径不是沙箱：
不同 session 可以访问同一个文件，也允许访问 workspace 外的绝对路径与符号链接目标。

## Stage3 工具与权限

每个 run 注册四个通用工具 `read`、`write`、`edit`、`bash`，保留 `task_*` 与 `note_save`。
旧 `read_file` 等名称只在历史记录中兼容，不再暴露给模型或提供执行别名。

```text
AgentLoop -> ToolInvoker -> strict schema -> PermissionManager
                                               | policy / session cache
                                               +-> durable permission.requested
                                                   -> IPC -> CLI / TUI
                                                   <- permission.respond
                                                   -> durable permission.resolved
            <- observation <- execute / bounded retry <- pending Promise
```

CoreApp 创建 daemon 共享 PermissionManager，AgentRunner 注入每轮 ToolInvoker。挂起 Promise
绑定 Core 生成的审批 ID 与 session/run/tool call。响应连接须附着相同 session 或 run；首个
有效响应先占位，持久化决定后才放行，重复响应返回 `already_resolved`。前端只有消费决策
事件才更新 resolved 投影，不从 RPC `accepted` 推导已批准，也不拥有权限策略。

read/task/note 默认允许，write/edit 请求审批；bash 固定危险规则优先于 always 缓存，
简单白名单允许，其余请求审批。always 在 daemon 内存按 session + 单一风险类别保存，
不是对某一个文件／命令的授权；复合命令或多风险请求不可缓存，没有持久化策略文件。

审批无超时、不占执行预算。read/write/edit 统一 10 秒，bash 默认／最大 120 秒，可传
1–120 秒。没有 run 全程超时，provider 仍保留独立请求超时。工具失败作为 observation
继续模型循环；只有取消、provider 或 Core 基础设施错误结束 run。显式瞬时 runtime_error
和 rate_limited 最多执行三次，退避 2／4 秒可取消；参数错误、拒绝、超时、非零退出和
确定性文件错误不重试。

权限 requested/resolved 与工具 retry/terminal 持久化、广播、重放。取消／shutdown 释放
Promise，不伪造 deny。重启仅补中断终态，不恢复审批 Promise、工具执行或 always 缓存。
完整契约与安全边界见 [Stage3 权限说明](STAGE3_PERMISSIONS.md)。

## 会话与上下文

chat 支持多轮，one-shot 仅供 `mc --goal` 单轮测试。`clientMessageId` 是提交幂等键：相同 ID
与内容重试返回原 turnId/runId；相同 ID 不同内容拒绝；其他消息在 active turn 期间返回
`session_busy`。

下一轮只继承 `includedInContext=true` 的成功消息以及当前 notes 快照。failed、cancelled 和
core 重启产生的 interrupted turn 仍在 history 中可审计，但不进入模型上下文。TaskManager
仅属于当前 run：`task_create`/`task_update` 生成 revision 单调递增的事件和 `tasks.json`，最终
快照写入 HistoryTurn；下一轮创建新的空 TaskManager。

分配 turnId/runId 前检查不可压缩的 system prompt、工具定义与本轮提问是否能容纳最大输出。
每次普通模型调用前，当 `contextTokens > contextWindow - reserveTokens` 时自动压缩；默认
reserveTokens 为 16384，keepRecentTokens 为 20000。当前占用采用最近一次调用的输入、缓存与
输出 usage 加后续消息估算；首次调用、压缩后及新 prompt 快照使用完整 UTF-8 字节 / 3 估算。
普通调用遇到上下文超限时压缩并重试同一个调用一次，既不增加 step，也不重放工具；再次超限
直接失败。压缩后保留内容仍无法容纳最大输出时返回明确的 context_limit_exceeded。

## 持久化与恢复

`MINICODE_HOME` 默认为 `~/.minicode`。固定布局如下：

```text
sessions/<sessionId>/
  meta.json
  history.jsonl
  notes.md
  session-events.jsonl
  runs/<runId>/
    run.json
    events.jsonl
    trace.jsonl
    tasks.json
```

目录收紧为 `0700`，文件收紧为 `0600`；原子替换产生的临时文件只会短暂存在于目标文件同目录。
workspace 不保存任何 session/run/trace/task 中间文件。

Core 启动时扫描 session journal。accepted 但未完成的 turn 被确定性补偿为
`interrupted/core_restarted`；history 已完成但缺失 run/session 终态时补齐唯一终态。如果记录
身份、sequence 或终态彼此冲突，只把对应 session 标记为 `corrupted`。corrupted session 和
one-shot 均可显式查询；前者不可继续，后者只读且默认不出现在 chat 列表。当前没有
close/delete/rename。

## 事件合并与多客户端

session event 使用 `sessionSequence`，run event 使用各 run 独立的 `sequence`。Controller 按
ID 和 sequence 合并 history snapshot、session journal、run journal 与 live notification，不能
用时间戳或文本相等判断重复。中途加入的客户端先取得 history 和 active run，再从 cursor 重放
持久 delta，最后原子切换到 live；因此前缀与后缀恰好组成 `finalText`。

同一 session 的多个 TUI 会看到相同 clientMessageId、turnId、runId、文本、工具、任务和终态。
任一客户端取消的是 Core 中该 session/run 的权威执行，所有观察者都会收到同一 cancelled 终态。

## Trace

每个 run 的 `trace.jsonl` 记录 CLIENT、CORE、LLM 边界，覆盖 IPC request/response/error、持久事件、
LLM request/delta/response/error/cancelled。配置：

| 变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `MINICODE_TRACE_ENABLED` | `true` | 是否记录 Trace |
| `MINICODE_TRACE_PAYLOAD` | `summary` | `summary` 或 `full` |
| `MINICODE_TRACE_QUEUE_EVENTS` | `1024` | 有界内存队列，范围 16..65536 |
| `MINICODE_TRACE_MAX_BYTES` | `33554432` | 单 run 文件上限，最小 1 MiB |
| `MINICODE_TRACE_SHUTDOWN_MS` | `2000` | 停机刷盘等待，范围 100..30000 ms |

`summary` 剥离 prompt、正文和工具输入输出；`full` 保留业务 payload。两者都递归屏蔽 API key、
token、secret、password、authorization、cookie 与认证字符串，并限制单字段/单记录大小。队列
溢出、序列化错误、文件达到上限或写盘失败只影响 Trace；必要时写入 `trace.truncated`，Agent
outcome 保持不变。当前没有 Trace viewer。

## 从 Stage1 配置迁移

已有 `.env` 的 Core 地址、`MINICODE_HOME`、`LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL` 无需
修改。`LLM_CONTEXT_WINDOW_TOKENS` 和 `LLM_MAX_OUTPUT_TOKENS` 可省略并分别默认使用 200000 和
8192；显式配置时应与实际模型匹配，且最大输出小于上下文窗口。Trace 新变量都可省略，默认开启
`summary`、队列 1024 条、单 run 32 MiB、停机等待 2000 ms。希望维持不生成 Trace 文件的旧行为
时显式设置 `MINICODE_TRACE_ENABLED=false`。

已有 `agent.run`/`mc --goal` 调用保持 one-shot 兼容。多轮前端应迁移到 `session.create`、
`session.sendMessage`、`session.getHistory`、`session.subscribe` 与 run subscription 组合，不应把
one-shot session 当作可恢复 chat。

## Stage4 compact journal

`history.jsonl` 在既有 turn 记录之外追加 `context.compacted`，原始消息保持完整。记录包含摘要或
fallback、首个保留消息 ID、触发原因、token 估算、摘要用量及文件清单。内部摘要消息带 metadata，
provider 仅接收 role/content。旧版无 compact 的日志仍按完整成功历史恢复。

恢复时倒序查找最新有效 compact，组装摘要与从该消息 ID 起的最近原文。手动 compact 立即有效；
带 ownerRunId 的 run 内 compact 仅在所属 run 成功后有效，失败、取消或中断均回退此前有效记录。
纯压缩服务不改写会话状态，调用方先保存 checkpoint，再替换模型上下文。SessionManager 负责
自动压缩与互斥的手动压缩，客户端暴露 typed compact，TUI 提供 `/compact [focus]`，CLI 观察自动进度。

`ExecutionContext` 分别维护当前 provider 消息和带稳定 ID 的 run 原文审计；压缩后仅更新前者，
`RunCompletion.messageIds` 确保后者终态提交时的身份与 checkpoint 引用一致。Compactor 只生成结果，
SessionManager 负责执行权、不可容纳校验、journal 和独立会话压缩事件。SessionController 附着时
从已成功消费的 session cursor 回放，避免只依靠 turn history 水位漏掉压缩进度。完整流程与配置
见 [Stage4 上下文管理](STAGE4_CONTEXT.md)。
