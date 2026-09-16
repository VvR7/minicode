# TUI 使用说明

## 启动模式

先启动 Core，再从目标 workspace 目录启动 TUI：

```bash
bun run core
bun run tui
```

| 命令 | 行为 |
| --- | --- |
| `bun run tui` | 在当前 workspace 新建 chat |
| `bun run tui --goal <text>` | 新建 chat 并自动提交首条消息 |
| `bun run tui --continue` | 恢复当前 workspace 最近更新的可继续 chat |
| `bun run tui --session <uuid>` | 打开指定 session；one-shot 以只读方式审计 |
| `bun run tui --sessions` | 打开分页 session selector |

session 的 workspaceRoot 在创建时固定为规范化 cwd。selector 默认只显示当前 workspace 的 chat；
Tab 切换当前/全部 workspace，`O` 切换 one-shot，`↑/↓` 或 `j/k` 选择，Enter 打开，Esc 退出。
其他 workspace 的条目只提示应切换到哪个路径，corrupted 条目只提示诊断状态。

## 聊天操作

TUI 主体是可滚动 transcript；底部固定显示带上下边框的多行输入框、规范化 workspace、
session/连接状态、上下文占用和当前模型。Assistant 内容按 Markdown 渲染，标题、列表、强调、
代码块和表格不再作为普通纯文本显示。

| 操作 | 行为 |
| --- | --- |
| `Enter` | 提交非空消息 |
| `Ctrl+Enter` | 插入换行 |
| `Ctrl-C` | 有草稿时清空；无草稿且运行中时取消；空闲时提示使用 `/exit` |
| `/new` | 空闲时创建并切换到同 workspace 的新 chat |
| `/exit` | 空闲时退出；运行中先要求取消 |
| `PgUp` / `PgDn` | 滚动一个 viewport |
| `Ctrl+Home` / `Ctrl+End` | 跳到 transcript 开头/末尾 |

运行中输入被冻结，直到 Core 发布权威终态。用户消息只有在 Core 返回 accepted 后才进入
transcript。普通 `q` 是输入字符。

## 权限审批

`PERMISSION` 内联块显示工具、风险类别和有界参数摘要。`↑/↓` 或 Tab 选择，Enter 提交；
`1/y` 允许一次、`2/a` 始终允许、`3/n` 拒绝一次、`4/d` 始终拒绝。
Always 仅作用于本 session 的同类风险；复合风险会禁用这两个选项。
提交后等待 Core 的权威决策，不提前收起审批。其他窗口先作出的决定也会同步显示。
断线时暂停响应，重连恢复未决审批；发送失败展示错误，不自动重发。Ctrl-C 仍可取消
运行，PgUp/PgDn 仍可查看摘要和 transcript。

Always 按风险类别缓存，而非仅授权当前显示的文件／命令，daemon 重启后清空。
workspace 不是工具访问沙箱，外部绝对路径和符号链接目标同样可访问；Bash 规则是启发式
检测，不保证识别全部危险命令。完整限制见 [Stage3 权限与工具](STAGE3_PERMISSIONS.md)。
取消或重启后的终态关闭遗留审批，不伪造用户拒绝，也不恢复中断的工具执行。

## 上下文与标记

左下角 `context used/limit percent` 表示最近一次模型调用结束后的实际上下文占用，其中 used
包含普通输入、cache read、cache creation 和本次输出 token；它不是跨调用累计计费量。模型调用
工具后会再次请求 provider，因此该值会随最新上下文更新。逐调用 Usage 和重复 Model 事件不写入
transcript，当前模型固定显示在右下角。

即使终端关闭颜色，也可通过稳定标记识别 transcript 内容：`YOU`、`ASSISTANT`、`TURN`、`TOOL`、
`TASK`、`RETRY`、`ERROR`。任务按 pending、in-progress、completed、blocked 使用不同标记和颜色；
历史任务图默认折叠显示。

多个 TUI 可以同时附着同一 session。Core 持久化文本 delta、工具、任务与终态，Controller 以
session/run sequence 去重重放，因此各窗口最终显示相同内容；任一窗口发出的取消也同步为同一
cancelled outcome。不同 session 不共享 transcript 或 busy/cancel 状态。

Core 暂时断开时 workspace 行右侧显示 reconnecting，恢复后从最后成功消费的 cursor 继续。无法一致恢复的
session 会变为 corrupted，只能查询诊断，不能继续提交。

## CLI 边界

`mc --goal <text>` 创建隐藏于默认 chat 列表的 one-shot session，仅用于单轮测试和 Stage1 回归。
它不是多轮 CLI；需要对话、恢复和 session selector 时使用 TUI。
