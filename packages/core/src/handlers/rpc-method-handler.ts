import type { z } from "zod";
import type { RpcInvocationContext } from "../rpc-context.ts";

/** 调用方法 handler 后的结果：要么参数合法并得到业务结果，要么参数不合法。 */
export type RpcMethodInvocation =
  | {
      readonly kind: "success";
      readonly result: unknown;
      readonly afterResponseEnqueued?: () => void;
      readonly afterResponseSent?: (sent: boolean) => void;
    }
  | { readonly kind: "invalid-params" };

/**
 * dispatcher 依赖的最小方法契约。
 * 每个 RPC 方法实现一个子类；transport 和 dispatcher 都不需要知道具体业务类型。
 */
export abstract class RpcMethodHandler {
  /** JSON-RPC method 字段的精确值，例如 core.ping。 */
  abstract readonly method: string;

  /** 校验原始 params 并执行方法；业务异常交由 dispatcher 统一映射为内部错误。 */
  abstract invoke(params: unknown, context: RpcInvocationContext): Promise<RpcMethodInvocation>;
}

/**
 * 为带 Zod 参数 schema 的方法提供通用实现。
 * 子类只需提供 method、paramsSchema 和 handle，不必重复参数校验样板代码。
 */
export abstract class TypedRpcMethodHandler<Params, Result> extends RpcMethodHandler {
  /** 该方法唯一的运行时参数边界。 */
  abstract readonly paramsSchema: z.ZodType<Params>;

  async invoke(rawParams: unknown, context: RpcInvocationContext): Promise<RpcMethodInvocation> {
    const params = this.paramsSchema.safeParse(rawParams);
    if (!params.success) {
      return { kind: "invalid-params" };
    }

    return { kind: "success", result: await this.handle(params.data, context) };
  }

  /** params 已由 paramsSchema 校验；子类在这里实现具体业务逻辑。 */
  protected abstract handle(
    params: Params,
    context: RpcInvocationContext,
  ): Promise<Result> | Result;
}
