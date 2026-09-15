# Stage2 架构与持久化

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
workspace 中进行；不同 session 的 active run、事件订阅、取消和文件路径都按 sessionId/runId
隔离。同一 session 只允许一个 active turn，不同 session 可以并行。

## 会话与上下文

chat 支持多轮，one-shot 仅供 `mc --goal` 单轮测试。`clientMessageId` 是提交幂等键：相同 ID
与内容重试返回原 turnId/runId；相同 ID 不同内容拒绝；其他消息在 active turn 期间返回
`session_busy`。

下一轮只继承 `includedInContext=true` 的成功消息以及当前 notes 快照。failed、cancelled 和
core 重启产生的 interrupted turn 仍在 history 中可审计，但不进入模型上下文。TaskManager
仅属于当前 run：`task_create`/`task_update` 生成 revision 单调递增的事件和 `tasks.json`，最终
快照写入 HistoryTurn；下一轮创建新的空 TaskManager。

预算在分配 turnId/runId 之前检查：

```text
estimated input + LLM_MAX_OUTPUT_TOKENS <= LLM_CONTEXT_WINDOW_TOKENS
```

超限返回 `-32013 context_limit_exceeded`，不会调用 provider，也不会创建 turn、run 或 run 目录。
当前没有自动压缩。

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
修改。Stage2 必须确认 `LLM_CONTEXT_WINDOW_TOKENS` 和 `LLM_MAX_OUTPUT_TOKENS` 与实际模型匹配，
且最大输出小于上下文窗口；缺失最大输出时仍兼容默认值 8192。Trace 新变量都可省略，默认开启
`summary`、队列 1024 条、单 run 32 MiB、停机等待 2000 ms。希望维持不生成 Trace 文件的旧行为
时显式设置 `MINICODE_TRACE_ENABLED=false`。

已有 `agent.run`/`mc --goal` 调用保持 one-shot 兼容。多轮前端应迁移到 `session.create`、
`session.sendMessage`、`session.getHistory`、`session.subscribe` 与 run subscription 组合，不应把
one-shot session 当作可恢复 chat。
