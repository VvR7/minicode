# Stage3 验证矩阵

系统合同使用真实 Core、TCP/NDJSON、客户端与工具；provider 为本地 Anthropic SSE mock，
不需要付费模型。每个系统 case 使用独立临时 home/workspace。

| 合同 | 主要测试位置 |
| --- | --- |
| 四工具、严格参数、字面 edit、原子 write、外部路径 | `packages/core/test/tools/builtin.test.ts`、`packages/core/test/tools/registry.test.ts` |
| 模型参数错误先于审批、危险拒绝、错误 observation 后正常终态 | `tests/integration/stage3-lifecycle.test.ts` |
| 批准／拒绝一次，审批持久化先于文件执行 | `tests/integration/permission-flow.test.ts`、`tests/integration/cli-permission-flow.test.ts` |
| always allow 跨 turn，always deny 无执行 | `tests/integration/cli-permission-flow.test.ts`、`tests/integration/stage3-lifecycle.test.ts` |
| 同 session 多客户端首个回应获胜、唯一决定与终态 | `tests/integration/permission-flow.test.ts` |
| 跨 session 事件、request ID、响应与风险缓存隔离（共享 workspace） | `tests/integration/stage3-lifecycle.test.ts` |
| 瞬时 runtime/rate-limit 真实 IPC 重试、2 秒退避、成功 observation | `tests/integration/stage3-lifecycle.test.ts` |
| 最多三次、2／4 秒退避、退避可取消、禁止分类不重试 | `packages/core/test/tools/invoker.test.ts` |
| 真实 IPC 在退避事件后取消、不执行第二次、cancelled 工具与 run 终态 | `tests/integration/stage3-lifecycle.test.ts` |
| 已批准 bash 模型超时执行一次，失败 journal 与终态 replay | `tests/integration/stage3-lifecycle.test.ts` |
| 进程组取消／超时、输出容量、凭据环境过滤 | `packages/core/test/tools/builtin.test.ts` |
| 审批不占执行预算、强制拒绝先于缓存、复合风险不可 always | `packages/core/test/permissions/manager.test.ts`、`packages/core/test/tools/invoker.test.ts` |
| 取消审批不落假 deny、不写入 | `tests/integration/permission-flow.test.ts`、`tests/integration/cli-permission-flow.test.ts` |
| CLI 四种决定、非 TTY 子进程 deny、EOF、stdout/stderr 分离 | `tests/integration/cli-permission-flow.test.ts`、`packages/cli/test/commands/permission-prompt.test.ts` |
| TUI 四决定、禁用 always、取消与滚动、其他窗口决定、发送错误 | `packages/tui/test/app.test.ts`、`packages/tui/test/permissions.test.ts` |
| 真实 TUI 审批断线／重新附着／批准／实际写入 | `tests/integration/tui-permission-flow.test.ts` |
| cursor 去重、accepted 不乐观解决、断线不自动重发 | `packages/client/test/agent-run-client.test.ts`、`packages/client/test/session-controller.test.ts` |
| 正常关闭释放审批、重启唯一终态 | `tests/integration/permission-flow.test.ts` |
| 异常遗留审批启动补 core_restarted、不恢复执行 | `tests/integration/agent-run-lifecycle.test.ts` |
| always 缓存关闭后清空、不跨 session | `packages/core/test/permissions/manager.test.ts` |
| 冻结 Stage2 history／旧工具事件原样读取、上下文配对 | `tests/integration/stage3-lifecycle.test.ts`、`tests/integration/helpers/stage2-*.jsonl` |
| 权限 schema、RPC、旧事件兼容、生成文档无漂移 | `packages/protocol/test/permissions.test.ts`、`bun run protocol:docs:check` |

重试故障仅在测试内替换只读 execute 切点并恢复；注册表、schema、权限、默认退避、AgentLoop、
journal 与 IPC 均保持真实实现。冻结 JSONL 原样复制，不通过当前 schema 生成，避免兼容测试
自证。仍运行 [Stage2 回归矩阵](STAGE2_TEST_MATRIX.md)，不穷举 shell 语法，也不声称路径沙箱。

提交 gate：format:check、lint、typecheck、protocol:docs:check、test:unit、test:integration、
test:coverage、coverage:check、build。生产代码整体行／函数覆盖率门槛均为 81%。
