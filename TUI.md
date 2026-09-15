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

TUI 包含状态栏、可滚动 transcript、Textarea 输入框和随状态变化的帮助栏。

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

## 标记与同步

即使终端关闭颜色，也可通过稳定标记识别内容：`YOU`、`ASSISTANT`、`TURN`、`MODEL`、`TOOL`、
`TASK`、`USAGE`、`RETRY`、`ERROR`。任务按 pending、in-progress、completed、blocked 使用不同
标记和颜色；历史任务图默认折叠显示。

多个 TUI 可以同时附着同一 session。Core 持久化文本 delta、工具、任务与终态，Controller 以
session/run sequence 去重重放，因此各窗口最终显示相同内容；任一窗口发出的取消也同步为同一
cancelled outcome。不同 session 不共享 transcript 或 busy/cancel 状态。

Core 暂时断开时状态栏显示 reconnecting，恢复后从最后成功消费的 cursor 继续。无法一致恢复的
session 会变为 corrupted，只能查询诊断，不能继续提交。

## CLI 边界

`mc --goal <text>` 创建隐藏于默认 chat 列表的 one-shot session，仅用于单轮测试和 Stage1 回归。
它不是多轮 CLI；需要对话、恢复和 session selector 时使用 TUI。
