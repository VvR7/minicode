# Stage4 上下文管理

Core 负责规则加载、占用估算、摘要生成、持久化与恢复。完整审计原文和模型使用的上下文分开维护，
压缩只替换模型视图。CLI 与 TUI 通过同一类型化 IPC 和会话事件观察进度。

## 规则与配置

每个 run 开始读取 `MINICODE_HOME/CONTEXT.md`（默认 `~/.minicode/CONTEXT.md`）及该 session 的
`workspaceRoot/CONTEXT.md`，不搜索祖先或子目录。提示词按基础规则、全局规则、项目规则、notes
顺序组装，项目规则与全局规则冲突时项目优先。缺失或空白文件忽略，其他读取失败明确报错。
运行中使用固定快照，修改在下一轮生效；手动压缩使用空闲时的规则和 notes 快照。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LLM_CONTEXT_WINDOW_TOKENS` | `200000` | 当前模型的上下文窗口 |
| `LLM_MAX_OUTPUT_TOKENS` | `8192` | 普通调用最大输出 |
| `MINICODE_COMPACTION_ENABLED` | `true` | 自动阈值检查及上下文错误压缩重试开关 |
| `MINICODE_COMPACTION_RESERVE_TOKENS` | `16384` | 自动压缩触发预留量 |
| `MINICODE_COMPACTION_KEEP_RECENT_TOKENS` | `20000` | 最近原文的保留目标 |

数字必须为正整数，开关只接受 `true` / `false`。reserve 必须不小于最大输出，且 reserve +
keepRecent 必须小于窗口。关闭自动压缩仍校验配置，手动 `/compact` 继续可用；不会自动缩小参数。
配置的模型窗口应与实际 provider 一致。

## 压缩主流程

分配 turn/run ID 前检查不可压缩的 system prompt、工具定义及本轮提问能否容纳最大输出。
历史无需在此阶段拒绝，随后每次普通模型调用前检查：

```text
contextTokens > contextWindow - reserveTokens
```

第一次调用、压缩后或新规则快照使用完整 UTF-8 字节 / 3 向上取整估算，覆盖 system、notes、
消息及工具 schema。拿到有效 usage 后，采用最近一次调用的普通输入、cache read、cache creation
与输出之和，再估算后续新增消息；run 的累计计费 usage 不代表当前占用。

摘要使用当前 provider/model，工具 schema 为空，摘要 delta 不作为助手回答发布。历史摘要把旧摘要
与本次新增淘汰原文增量合并；如果切点在一个 run 内，其前缀另行摘要以保留用户意图。仅有新前缀
时仍保留旧摘要。read/write/edit 文件路径清单确定性累积，近期工具调用与工具结果成对保留。
keepRecent 是保留目标，工具配对可能使保留量超过目标，不会截断消息来强行满足它。

历史摘要输出预算为 `min(floor(reserve * 0.8), maxOutput)`，前缀摘要为
`min(floor(reserve * 0.5), maxOutput)`。普通摘要失败最多调用两次，不叠加 adapter 重试；取消不重试。
空摘要、未完成输出及摘要工具调用视为失败，不安装部分摘要。摘要超窗时保留旧摘要和近期原文，
并加上早期对话已隐藏且未摘要的明确标记；隐藏的 run 前缀仍保留原请求意图。

压缩后的完整 system + tools + messages 仍无法容纳最大输出时明确报超限，不递归缩小近期保留量。
普通调用因上下文超限失败时，自动压缩后重试同一调用一次，不增加 step，也不再次执行工具。
第二次仍超限直接结束。普通工具结果可能在下一次模型调用前触发阈值压缩。

## 手动操作与显示

TUI 空闲会话可输入 `/compact` 或 `/compact 保留下一步任务`，后面的文字作为 focus 同时传给
历史与前缀摘要。该操作使用 `session.compact`，不创建普通 user turn；没有可淘汰原文时返回 unchanged。
运行或压缩期间其他请求返回 session busy。客户端不在响应不确定时重复发起手动摘要。

开始、完成与失败使用 durable 的 `session.compaction_started`、`session.compaction_finished`、
`session.compaction_failed`，有独立会话序列，不伪造 run ID。附着或重连按成功消费 cursor 回放，
多窗口同步进度。TUI 的 CONTEXT 行与 footer 显示结果，fallback 明确说明未摘要的隐藏；
CLI 自动压缩进度只写 stderr，回答保留在 stdout，CLI 没有新增手动压缩入口。

## 持久化与工具预算

既有 `history.jsonl` 追加 `context.compacted` 记录，原始消息保持完整。checkpoint 保存摘要或
fallback、首个保留消息 ID、原因、占用、用量与文件清单。模型视图中的摘要带内部 metadata，
发送 provider 时只包含 role/content。运行期的原始消息 ID 在终态审计提交时复用。

恢复时倒序找最新有效 checkpoint，再拼接该 ID 起的成功原文。手动 checkpoint 立即有效；run 内
checkpoint 只在所属 run 成功后进入后续上下文。失败、取消及进程中断时恢复此前有效上下文，
保留失效记录供审计。旧版没有 checkpoint 的会话继续使用完整成功历史，无需迁移。

read 与 bash 同时受 2000 行、50 KiB 限制，截断标记计入预算。read 保留头部，bash 保留尾部；
不生成完整输出临时文件。其他工具保留既有通用结果保护。

## 验证矩阵

| 验收能力 | 自动化验证 |
| --- | --- |
| 全局/项目规则、快照、读取错误 | `packages/core/test/run/context-loader.test.ts`、session manager 测试 |
| 配置关系、typed 协议与旧 metadata | protocol compaction contracts、core compaction config 测试 |
| read 头部、bash 尾部、字节/行预算 | core tools output-budget 与 builtin 测试 |
| 近期保留、配对、增量及独立 run 前缀 | core compact compactor 测试、`tests/integration/stage4-lifecycle.test.ts` |
| usage 占用、工具后触发、一次重试且不重放工具 | core agent compaction、Stage4 lifecycle 集成 |
| 真实 provider 超窗、普通摘要失败及显式 fallback | Stage4 lifecycle 集成 |
| 压缩后不可容纳、focus 同时进入两类摘要 | Stage4 lifecycle 集成 |
| 重启续航、稳定 ID、完整原文和累计文件清单 | core run-lifecycle 与 Stage4 lifecycle 集成 |
| 失败/取消/真实 SIGKILL 后 checkpoint 回退 | checkpoint-store 与 Stage4 lifecycle 集成 |
| 手动 focus/busy、多窗口、附着与重连回放 | `tests/integration/stage4-client-compaction.test.ts`、client/TUI 测试 |
| CLI stdout/stderr 分离、订阅等待期间审批可响应 | CLI goal 与 client agent-run-client 测试 |
| 会话隔离、旧版磁盘 fixture 兼容 | Stage4 lifecycle 与 `tests/integration/stage3-lifecycle.test.ts` |

本地和 CI 使用以下验证命令，覆盖率要求所有源码被统计，行/函数均至少 81%：

```bash
bun run format:check
bun run lint
bun run typecheck
bun run protocol:docs:check
bun run build
bun run test:unit
bun run test:integration
bun run test:coverage
bun run coverage:check
```

本阶段不实现 skills、子 agent、MCP 或额外 CLI 手动入口。token 估算仍是字节启发式；provider
报告明确上下文超限时使用一次压缩重试来补充处理。
