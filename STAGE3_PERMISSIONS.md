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
`run.finished`（`core_restarted`），不会重建审批 Promise 或恢复工具执行。前端实现属于后续 Issue。
