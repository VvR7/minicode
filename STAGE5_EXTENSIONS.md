# Stage5 扩展能力与验证矩阵

## 能力快照和职责

Core 为每个接受的父 run 固定 system prompt、规则文件、Skills 目录及工具 JSON Schema。
预检在分配 turn/run ID 前使用实际目录；Runner、Trace、自动压缩及手动压缩共用该目录。
新父 run 重新读取规则与 Skills；MCP 配置和发现结果固定至 Core 重启。子执行继承父轮规则
和 Skills 快照，用自己的 profile system prompt 和工具白名单创建独立上下文。

| 模块 | 职责 |
| --- | --- |
| `agent/system-prompt.ts`、`skills/loader.ts` | 发现技能元数据、读取正文快照、组合 available skills 区块 |
| `skills/command.ts`、`handlers/skill-list-handler.ts` | Core 展开命名技能；提供无需模型调用的类型化目录查询 |
| `subagents/profiles.ts`、`spawn-tool.ts`、`executor.ts` | 发现类型、同步或后台委派、隔离执行和私有审计 |
| `subagents/registry.ts`、`result-tool.ts` | 父 run 拥有者校验、查询等待、结果交付与取消排空 |
| `mcp/config.ts`、`server-manager.ts`、`client.ts`、`tool.ts` | 配置快照、工作区连接、官方 SDK、Schema 与标准工具适配 |
| `tools/invoker.ts`、`agent/loop.ts`、`permissions/manager.ts` | 参数校验、审批、批次调度、观察结果及缓存 |

## Skills

发现位置为 `<workspace>/.minicode/skills/<目录>/SKILL.md` 和
`$MINICODE_HOME/skills/<目录>/SKILL.md`，默认 home 为 `~/.minicode`。
项目按 frontmatter 中的 name 覆盖全局同名技能，目录名不决定元数据 name。
无效文件跳过并返回有界诊断。

```markdown
---
name: review-change
description: 检查工作区改动并给出审核结果
---
读取相关文件，检查主流程，列出阻塞问题和验证证据。
```

system prompt 的 `available skills:` 只列 name、description 与 SKILL.md 绝对路径，
默认不包含正文。`/skill` 列表使用 `skill.list` RPC，CLI/TUI 不创建模型 run。
`/skill review-change 额外参数` 在 Core 预检时把固定正文及参数加入本轮 user content；
原始命令用于展示、幂等和审计，展开内容参加预算与成功历史。未知技能在分配 ID 前拒绝。
技能不会改写工具白名单或权限策略。

## 子 Agent

`list_subagent({})` 每次发现内置及项目 `.minicode/agents/<name>.toml`，返回名称、描述和诊断。
不存在全局 Agent 类型目录；名称由文件名决定。项目同名类型覆盖内置；无效覆盖文件不回退。
`spawn_agent` 调用时重新读取类型，严格校验必填字段与完整工具名称。

```toml
[agent]
description = "只读审核及外部查询"
system_prompt = "检查显式任务，返回文本结论及证据。"
allowed_tools = ["read", "mcp__local__search"]
max_steps = 30
```

内置 planner/reviewer 仅允许 read，返回文本计划或审核。executor 允许
read/write/edit/bash/task_create/task_update/task_list/task_get。
`max_steps` 可选，接受 1–100 的整数，默认 20；内置 executor 使用 40。
空白名单表示没有工具；未知工具及 spawn_agent/agent_result/list_subagent 拒绝，禁止嵌套。
白名单中的工具仍经过参数和固定安全策略，但子 Agent 默认 bypass，不产生人工审批。
模型、工作区和规则继承父 run，不配置独立模型。

```text
spawn_agent({ name: "reviewer", goal: "检查指定改动", context: "必须提供的背景" })
spawn_agent({ name: "executor", goal: "完成独立任务", background: true })
agent_result({ childRunId: "返回的 UUID", wait: true })
```

默认同步返回文本，不使用普通工具的 10 秒时限。后台在启动后返回 childRunId；查询仅允许
当前 session + 父 run 的子身份，wait=true 可取消等待。每个子执行采用 profile 步数上限，没有额外并发
上限或 run 总时限，provider 请求仍有自己的超时。父失败、取消及停机中断并排空子任务。
后台任务不跨 turn 存活，终态后释放 Registry。

完成未交付的后台结果在下一父模型调用前作为普通 user context 交付一次，显式终态查询
在对应 tool_result 里交付后不再自动重复注入。父准备结束时等待剩余子任务，再继续模型循环
综合结果，额外调用计入父步数限制。不会伪造没有对应 tool_use 的 tool_result。
同步、查询及自动交付共用结构化终态，包含身份、status、reason、errorCode、steps 和有界正文；
`max_steps` 与 `context_limit_exceeded` 不再折叠为缺少原因的通用失败。
子 Agent 的单步并行工具结果正文总量限制为 64 KiB；截断保持调用顺序、tool use ID、
错误标志及明确提示。主 Agent 和串行批次不使用该子执行专用总量限制。

子执行不创建主 session turn，不改变主 activeRun，且不继承父历史或 session notes。
独立 TaskManager、私有 note_save、压缩 checkpoint、历史、Trace 和事件审计布局如下：

```text
sessions/<sessionId>/runs/<parentRunId>/subagents/<childRunId>/
  state.json
  history.json
  tasks.json           # 使用任务工具时产生
  notes.md             # 显式 note_save 时产生
  compaction.json      # 发生压缩时产生
  events.jsonl
  trace.jsonl          # 按 Trace 配置产生
```

父 durable 流只记录 subagent.started/finished 身份与有界摘要。子 Agent 默认 bypass，
不会向父通道发布 permission.requested。CLI/TUI 展示生命周期及摘要，
不展开子聊天；客户端和 TUI 按 sequence 重放去重。重启把未结束子记录标 interrupted，
补偿独立审计终态；不自动恢复模型调用、后台执行、审批 Promise 或 Always 缓存。

## MCP

采用官方 TypeScript SDK v2，支持 stdio 与 Streamable HTTP。全局
`$MINICODE_HOME/config.toml` 在启动时读取，项目 `.minicode/config.toml` 在工作区首次使用时读取；
项目同名服务器覆盖全局，修改需重启 Core。连接按规范化工作区隔离，stdio cwd 为该工作区。
一个服务器连接或发现失败生成诊断，其他服务器继续发现；工具完整名称冲突拒绝覆盖。

```toml
[[mcp.servers]]
name = "local"
transport = "stdio"
command = "bun"
args = ["/absolute/path/server.ts"]
execute_mode = "parallel"
[mcp.servers.env]
API_KEY = "${LOCAL_API_KEY}"

[[mcp.servers]]
name = "remote"
transport = "http"
url = "http://127.0.0.1:8080/mcp"
execute_mode = "serial"
[mcp.servers.headers]
Authorization = "Bearer ${REMOTE_TOKEN}"
```

name 允许 ASCII 字母、数字、下划线和连字符。stdio 支持 command/args/env；HTTP 支持
url/headers，url 为 HTTP(S)。字符串字段支持 `${ENV_NAME}`，缺失变量生成不包含密钥值的诊断。
不实现 OAuth、裸 TCP、热更新或外部工具的自动重试。

分页发现使用 SDK 聚合，首次省略 cursor。工具名称为 `mcp__<server>__<tool>`，原始 inputSchema
提供给模型，Zod 边界加 AJV 本地校验在审批前执行；支持 draft-07、2019-09、2020-12 及常用格式。
不合法参数和被拒绝审批不会发送请求。MCP 默认审批，Always 缓存按 session + 完整工具名，
不同工具不会互相授权。审批摘要有界、脱敏，前端安全转义显示。

文本与 structuredContent 保留，图片、音频及嵌入资源只提供类型或资源地址摘要，二进制与
base64 不进入模型。isError、请求失败、工具超时与取消转换为统一失败 observation，保持请求
结果关联。daemon shutdown 关闭连接并回收 stdio 子进程。

## 工具批次执行

executeMode 可选 serial/parallel，默认 parallel。write/edit/bash/task_create/task_update/note_save
设为 serial；读取和查询、子 Agent 工具为 parallel；MCP 继承服务器 execute_mode。

全为 parallel 时，先按请求顺序完成所有参数校验与审批，再用 Promise.all 执行已放行工具。
任何工具为 serial 时，整批按请求顺序校验、审批、执行。单调用失败形成自己的 observation；
模型结果保持请求顺序，tool.finished 按真实完成顺序发布。取消不启动新副作用，基础设施错误
取消并排空已启动执行。审批等待不占用工具执行超时。

## 验证矩阵

所有 fixtures 使用临时 home/工作区、本地 HTTP 和测试 stdio 子进程，无真实外部服务要求。

| 行为 | 验证文件 |
| --- | --- |
| 四能力组合、两个工作区、Skill 覆盖与展开、真实 MCP 并发关联、后台综合、审批镜像、取消、shutdown 和 interrupted 恢复 | `tests/integration/stage5-lifecycle.test.ts`、`fixtures/stage5-mcp.ts` |
| Skills 元数据、正文快照、预算、原始命令幂等及 CLI/TUI 列表 | `packages/core/test/skills/*`、`tests/integration/stage5-skills.test.ts`、CLI/TUI 测试 |
| 类型实时发现、无效覆盖不回退、完整名称白名单 | `packages/core/test/subagents/profiles.test.ts` |
| 同步隔离 history/tasks/notes/压缩、profile 步数、权限 bypass、父取消和审计 | `packages/core/test/subagents/execution.test.ts` |
| 后台继续父工作、结束前等待与计步、父失败排空 | `packages/core/test/subagents/background.test.ts` |
| 查询/等待、归属验证、一次交付、失败观察、释放 Registry | `packages/core/test/subagents/registry.test.ts` |
| 真实 Core 同步/后台 bypass、agent_result wait、单一主 turn、shutdown | `tests/integration/stage5-subagents.test.ts` |
| MCP 配置覆盖、工作区连接隔离、失败诊断及固定快照 | `packages/core/test/mcp/server-manager.test.ts` |
| MCP JSON Schema、审批拒绝、完整名缓存、结果转换、取消超时、不重试 | `packages/core/test/mcp/tool.test.ts`、`packages/core/test/run/runner.test.ts` |
| SDK stdio/HTTP、分页、headers、cwd、Core preflight、进程回收 | `tests/integration/stage5-mcp-manager.test.ts` |
| 并行屏障、审批顺序、serial 混合批次、失败及取消排空 | `packages/core/test/agent/tool-batch.test.ts` |
| CLI stderr 子摘要与安全转义、TUI 多窗口生命周期重放 | `packages/cli/test/commands/goal.test.ts`、`packages/tui/test/model.test.ts` |
| Stage2/3 冻结持久记录及 Stage4 上下文兼容 | 既有 Stage2/3/4 验证矩阵和全量回归 |

提交 gate：`bun install --frozen-lockfile`、`format:check`、`lint`、`typecheck`、
`protocol:docs:check`、`test:unit`、`test:integration`、`test:coverage`、`coverage:check`、`build`。
生产代码整体行和函数覆盖率门槛均为 81%。
