# Core 工具权限生命周期

Core 为整个 daemon 创建一个 `PermissionManager`，跨 turn 复用，同一 session 的
always 决策仅保存在内存。独立 session 和 daemon 重启均不会继承该缓存。

调用顺序为：注册表查找 → schema 校验 → 权限策略与缓存 → 用户审批（如需）→ 工具执行与重试。
审批等待不计入工具执行超时，也没有单独的审批超时。拒绝时尝试次数为 0，不重试。

`read`、任务和笔记工具自动允许；`write`、`edit` 请求审批。`bash` 使用共用的固定
策略分类器：危险命令直接拒绝，只读白名单自动允许，其余请求审批。强制拒绝先于缓存，
复合命令或多风险请求不读取／写入 always 缓存，只接受 once 决策。

审批事件通过既有 run 事件流持久化、广播和 replay，write/edit 仅包含有界内容摘要。
客户端需订阅 run 事件流来接收审批；响应连接必须附着相同 run 或 session。
`permission.respond` 校验 session、run、Core 生成的 request ID 和 decision。
首个有效响应先占位，再持久化 `permission.resolved`，成功后才放行调用和写入缓存。
重复响应返回 `already_resolved`，未知、外国或未附着连接统一返回 `not_found`。
不可缓存请求的 always 响应同样返回 `not_found`，保留请求等待合法 once 决策。

取消或 shutdown 会释放挂起 Promise，不伪造用户审批决定；`tool.finished`／`run.finished`
关闭本轮交互状态。异常退出后的遗留 `permission.requested` 可以 replay，但启动恢复会补
`run.finished`（`core_restarted`），不会重建审批 Promise 或恢复工具执行。

## 客户端与 CLI

`AgentRunClient.respondPermission(requestId, decision)` 使用已订阅的单轮 run 连接；
`SessionController.respondPermission(runId, requestId, decision)` 使用已附着的 session 连接。
两者均校验请求参数和 Core 响应，并通过 `permissions` 快照和可选 `onPermissions` 回调
提供 `pending`／`resolved`／`closed` 状态。`resolved` 只来自 durable 决策事件，RPC 的
`accepted` 不会乐观改写决策；`already_resolved`／`not_found` 结束本地提示，随后仍可由
journal 补齐真实决策。工具或 run 终态关闭未完成审批，不伪造用户拒绝。

重连沿用既有 cursor 去重；重新附着会重新通知 pending 快照。发送失败会抛给调用方并
关闭旧连接，由既有连接流程重新附着；不自动重发审批决定，前端可再次提示仍 pending 的请求。
会话切换清空客户端投影，不把 always 缓存复制到前端。

`mc --goal` 使用 stdin 接收编号、stderr 显示有界摘要与四种选项：
1 允许一次、2 始终允许、3 拒绝一次、4 始终拒绝。不可缓存请求禁用 2／4。
stdin 和 stderr 均为 TTY 才启用交互（stdout 可以重定向）；否则发送 `deny_once`。
输入 EOF／不可用同样拒绝一次。Ctrl-C、断线或其他客户端解决审批时撤销当前输入；
审批提示异步运行，不阻塞事件流。

## TUI 审批

TUI 在 transcript 内更新同一审批块，展示工具、风险类别及协议提供的有界摘要。
方向键／Tab 选择，Enter 提交；1/y、2/a、3/n、4/d 分别对应四种决策。
非缓存复合风险禁用 always 选项。提交只标记等待 Core，不乐观解决；其他窗口的
权威决定也会替换该块。断线暂停审批交互，重新附着后仍可回应未决请求；发送失败
显示错误，不自动重发。运行期间禁用普通消息输入，Ctrl-C 保持取消语义，终态关闭
遗留审批而不伪造拒绝。
