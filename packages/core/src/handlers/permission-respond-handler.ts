import {
  PERMISSION_RESPOND_METHOD,
  PermissionRespondParamsSchema,
  type PermissionRespondParams,
  type PermissionRespondResult,
} from "@minicode/protocol";
import type { PermissionManager } from "../permissions/manager.ts";
import type { RpcInvocationContext } from "../rpc-context.ts";
import { TypedRpcMethodHandler } from "./rpc-method-handler.ts";

/** permission.respond：只接收已附着对应 session/run 的连接的类型化决策。 */
export class PermissionRespondHandler extends TypedRpcMethodHandler<
  PermissionRespondParams,
  PermissionRespondResult
> {
  readonly method = PERMISSION_RESPOND_METHOD;
  readonly paramsSchema = PermissionRespondParamsSchema;
  readonly #permissions: PermissionManager;
  readonly #isAttached: (context: RpcInvocationContext, params: PermissionRespondParams) => boolean;

  /** 保存审批管理器和由订阅层提供的连接附着判定。 */
  constructor(
    permissions: PermissionManager,
    isAttached: (context: RpcInvocationContext, params: PermissionRespondParams) => boolean,
  ) {
    super();
    this.#permissions = permissions;
    this.#isAttached = isAttached;
  }

  /** 未附着连接与外国请求同样返回 not_found，避免泄漏待审批记录。 */
  protected handle(
    params: PermissionRespondParams,
    context: RpcInvocationContext,
  ): Promise<PermissionRespondResult> | PermissionRespondResult {
    return this.#isAttached(context, params)
      ? this.#permissions.respond(params)
      : { outcome: "not_found" };
  }
}
