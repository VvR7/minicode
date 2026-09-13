import type { AgentCancelParams, AgentCancelResult } from "@minicode/protocol";
import { AGENT_CANCEL_METHOD, AgentCancelParamsSchema } from "@minicode/protocol";
import type { RunManager } from "../run/manager.ts";
import { TypedRpcMethodHandler } from "./rpc-method-handler.ts";

/** agent.cancel：幂等取消一个 run。 */
export class AgentCancelHandler extends TypedRpcMethodHandler<
  AgentCancelParams,
  AgentCancelResult
> {
  readonly method = AGENT_CANCEL_METHOD;
  readonly paramsSchema = AgentCancelParamsSchema;
  readonly #manager: RunManager;

  constructor(manager: RunManager) {
    super();
    this.#manager = manager;
  }

  protected handle(params: AgentCancelParams): AgentCancelResult {
    return { outcome: this.#manager.cancel(params.sessionId, params.runId) };
  }
}
