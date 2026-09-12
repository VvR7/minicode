# TypeScript 编码规范

## 1. 工具链

- Bun 是唯一的包管理器、脚本运行器和测试运行器；提交 `bun.lock`。
- TypeScript 使用仓库固定版本，不使用全局 `tsc`。
- Biome 统一格式、lint 和 import 排序；不要同时引入 ESLint 或 Prettier。
- CI 和本地使用相同命令：format check、lint、typecheck、test、build。
- 新依赖必须有明确用途并添加到实际使用它的 workspace，避免全部放在根包。

## 2. TypeScript 严格性

保持根 `tsconfig.json` 中的严格选项。代码不得通过降低全局规则来绕过错误。

- 禁止显式 `any`；外部输入先视为 `unknown`。
- 对索引访问和可选字段做显式空值处理。
- 使用 `import type` 表达纯类型依赖。
- 公共函数和跨包导出写明确返回类型；局部简单表达式允许推导。
- 使用 discriminated union 表达状态，配合穷尽检查；不要用多个互相矛盾的 boolean。
- 不使用 TypeScript `enum`；使用字面量 union 或 `as const` 对象。
- 不滥用类型断言、非空断言或 `@ts-ignore`。确需使用时必须就地说明边界事实。

推荐的穷尽检查：

```ts
export const assertNever = (value: never): never => {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
};
```

## 3. Zod 是边界类型的事实来源

以下数据在使用前必须经过 Zod：

- IPC 请求、响应和事件；
- 环境变量与用户配置；
- 持久化文件和历史版本迁移结果；
- LLM tool call、结构化输出与 provider 响应；
- MCP server 描述、工具参数和工具结果；
- CLI 参数解析后的领域输入。

schema 与类型必须放在一起，并从 schema 推导类型：

```ts
import { z } from "zod";

export const SessionMetadataSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z.string().max(200),
  })
  .strict();

export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;
```

不要再手写一份等价 `interface`。领域内部已经校验过的数据可以直接使用推导类型，不要在每层重复
parse。对 ID 使用 branded schema，避免把 `runId`、`sessionId` 和普通字符串混用。

## 4. 协议设计

- JSON 字段使用 `camelCase`，事件和命令名称使用 `domain.action`。
- request/response/event 使用可判别联合；新增 variant 时必须添加解析和测试。
- 所有 schema 默认 `.strict()`，避免拼写错误被静默丢弃。
- 会话相关命令和事件必须携带 branded `sessionId`；运行事件还必须携带 `runId`。
- 权限相关消息必须携带足以验证归属的 session、run 和 tool call 标识符。
- 公开错误使用稳定 code 和安全 message；内部 stack、绝对路径和密钥不得进入 IPC。
- 破坏性 schema 修改需要协议版本升级和迁移说明。

## 5. 模块和依赖

- 一个文件聚焦一个主要职责；公共入口由 `src/index.ts` 明确导出。
- 禁止跨包导入另一个包的 `src/` 深层路径，只能使用包的公开 exports。
- `protocol` 不导入任何其他内部包；CLI/TUI 不导入 Core。
- 领域逻辑依赖接口或函数参数，不读取进程级 singleton。
- 文件名使用 `kebab-case.ts`；源码放在 `src/`，测试放在独立的 `test/` 或根 `tests/` 目录，
  并命名为 `*.test.ts`。
- 为初学者也难以直接看出的协议约束、并发控制、资源释放和安全判断写简短注释，优先解释
  “为什么”；不为名称和控制流已清晰的语句逐行重复代码含义。
- 避免 `utils.ts`、`helpers.ts` 等无边界集合；按领域能力命名。

## 6. 异步与资源生命周期

- 所有可能阻塞的 I/O 使用异步 API。
- 长操作接收 `AbortSignal`，超时与用户取消必须可区分。
- 不创建无人持有的 Promise；后台任务必须注册、观察异常并在 shutdown 时回收。
- 同一 session 的可变操作通过队列或锁串行化；不要使用一个全局锁阻塞其他会话。
- stream consumer 必须处理背压、断连和有界缓冲；禁止无限积压 token/event。
- 资源的创建者负责释放；socket、文件、子进程和 MCP 连接都必须有明确的关闭路径。

## 7. 错误与日志

- 领域内使用可判别的结果或专用 Error 子类，不依赖解析错误字符串做控制流。
- 只在能够增加上下文或完成协议映射的边界捕获异常。
- catch 变量保持 `unknown`，通过守卫安全提取信息。
- 日志必须包含相关的 `sessionId`、`runId` 或 `toolCallId`，但不得包含 prompt 全文和密钥。
- 用户可恢复错误与程序缺陷使用不同错误码，并分别测试。

## 8. 测试要求

- 使用 `bun:test`；包级单元测试放在对应 package 的 `test/`，跨包/进程测试放在根 `tests/`。
- 每个 Zod 边界同时测试成功和拒绝路径。
- IPC 测试必须覆盖缺失/错误 session scope、跨会话事件泄漏和越权审批。
- 异步测试必须验证取消、超时、断连和资源清理，不使用不稳定的固定 sleep。
- Bug 修复优先先写可复现的失败测试。
- 测试不得读取开发者真实 `.env`、主目录状态或网络服务，集成测试需显式 opt-in。

## 9. 安全与配置

- `.env`、本地状态、日志、trace、coverage 和构建产物不得提交。
- `.env.example` 只列变量名和非敏感默认值。
- 外部路径在使用前规范化并检查工作区边界；shell 命令由权限层审批。
- 所有工具输入即使来自模型也视为不可信数据。
- 永久权限策略的写入必须原子化、可审计，并区分 session 级授权与全局授权。

## 10. 完成标准

每个开发 PR 除 Issue 的验收条件外，至少满足：

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run protocol:docs:check
bun run test
bun run build
```

不得用跳过检查、放宽类型或删除测试的方式获得绿色结果。
