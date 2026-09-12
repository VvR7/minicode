import { CORE_PING_METHOD, MINICODE_VERSION, PingParamsSchema } from "@minicode/protocol";

import type { PingParams, PongResult } from "@minicode/protocol";
import { TypedRpcMethodHandler } from "./rpc-method-handler.ts";

/** Ping handler 所需的运行时依赖；由 CoreApp 在组合入口注入。 */
export interface PingHandlerOptions {
  readonly uptimeMs: () => number;
  readonly now?: () => Date;
}

/** core.ping 的唯一业务实现和参数 schema 所在位置。 */
export class PingHandler extends TypedRpcMethodHandler<PingParams, PongResult> {
  readonly method = CORE_PING_METHOD;
  readonly paramsSchema = PingParamsSchema;
  readonly #uptimeMs: () => number;
  readonly #now: () => Date;

  constructor(options: PingHandlerOptions) {
    super();
    this.#uptimeMs = options.uptimeMs;
    this.#now = options.now ?? (() => new Date());
  }

  protected handle(_params: PingParams): PongResult {
    return {
      serverVersion: MINICODE_VERSION,
      uptimeMs: Math.max(0, Math.floor(this.#uptimeMs())),
      receivedAt: this.#now().toISOString(),
    };
  }
}
