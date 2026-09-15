# Stage2 验证矩阵

Stage2 的系统合同由跨模块测试和更靠近故障注入点的单元/集成测试共同验证。系统测试使用真实
Core、TCP/NDJSON、类型化 SessionController、TUI reducer、真实 ToolInvoker 与可编程 mock
provider；不要求付费模型。

| 合同 | 主要测试位置 |
| --- | --- |
| 多轮 history、notes、run 级 TaskManager | `tests/integration/stage2-lifecycle.test.ts` |
| 同 session 多客户端、中途加入、文本去重 | `tests/integration/stage2-lifecycle.test.ts`、`packages/client/test/session-controller.test.ts` |
| 不同 session/workspace、取消与事件隔离 | `tests/integration/stage2-lifecycle.test.ts`、`packages/core/test/events/event-bus.test.ts` |
| clientMessageId 幂等、session_busy、预算拒绝 | `tests/integration/stage2-lifecycle.test.ts`、`packages/core/test/session/manager.test.ts` |
| accepted/response/history/terminal 切点 | `packages/core/test/session/manager.test.ts` |
| journal 重放、冲突与 isolated corruption | `packages/core/test/session/manager.test.ts`、`packages/core/test/session/session-store.test.ts` |
| replay/live 原子切换、断线、slow consumer | `packages/core/test/events/*.test.ts`、`packages/client/test/session-controller.test.ts` |
| daemon shutdown 与唯一终态 | `packages/core/test/session/manager.test.ts`、`tests/integration/tui.test.ts` |
| Trace 正常/错误/取消、summary/full 脱敏 | `tests/integration/stage2-lifecycle.test.ts`、`packages/core/test/trace/*.test.ts` |
| Trace 溢出、上限、序列化和写盘旁路 | `packages/core/test/trace/writer.test.ts` |
| 私有权限、固定布局、workspace 无污染 | `tests/integration/stage2-lifecycle.test.ts`、各模块 `filesystem.test.ts` |
| one-shot 默认隐藏、显式审计且不可继续 | `tests/integration/agent-run-lifecycle.test.ts`、`packages/core/test/session/manager.test.ts` |
| Stage1 CLI 与真实 TUI 回归 | `tests/integration/goal-cli.test.ts`、`tests/integration/tui.test.ts` |

provider barrier 通过 Promise 明确通知“已经到达切点”，再由测试释放；新增系统 case 不用固定
sleep 推测并发时序。每个 case 使用独立临时 `MINICODE_HOME` 和 workspace，完成后清理，可并行运行。
