import type { EventUnsubscribeParams, EventUnsubscribeResult } from "@minicode/protocol";
import {
  EVENT_SUBSCRIBE_METHOD,
  EVENT_UNSUBSCRIBE_METHOD,
  EventSubscribeParamsSchema,
  EventUnsubscribeParamsSchema,
} from "@minicode/protocol";
import type { IpcEventBroadcaster } from "../events/ipc-event-broadcaster.ts";
import type { IpcSessionBroadcaster } from "../events/ipc-session-broadcaster.ts";
import type { RpcInvocationContext } from "../rpc-context.ts";
import { RpcMethodHandler, TypedRpcMethodHandler } from "./rpc-method-handler.ts";

export class EventSubscribeHandler extends RpcMethodHandler {
  readonly method = EVENT_SUBSCRIBE_METHOD;
  readonly #broadcaster: IpcEventBroadcaster;

  constructor(broadcaster: IpcEventBroadcaster) {
    super();
    this.#broadcaster = broadcaster;
  }

  async invoke(rawParams: unknown, context: RpcInvocationContext) {
    const params = EventSubscribeParamsSchema.safeParse(rawParams);
    if (!params.success) {
      return { kind: "invalid-params" as const };
    }
    const subscribed = await this.#broadcaster.subscribe(
      context.connection,
      params.data.sessionId,
      params.data.runId,
      params.data.afterSequence,
    );
    if (!subscribed.ok) {
      // dispatcher 会把内部持久化失败映射为不泄露路径信息的标准错误。
      throw new Error(subscribed.error.code);
    }
    return {
      kind: "success" as const,
      result: subscribed.value.result,
      afterResponseEnqueued: subscribed.value.afterResponseEnqueued,
    };
  }
}

export class EventUnsubscribeHandler extends TypedRpcMethodHandler<
  EventUnsubscribeParams,
  EventUnsubscribeResult
> {
  readonly method = EVENT_UNSUBSCRIBE_METHOD;
  readonly paramsSchema = EventUnsubscribeParamsSchema;
  readonly #broadcaster: IpcEventBroadcaster;
  readonly #sessionBroadcaster: IpcSessionBroadcaster | undefined;

  constructor(broadcaster: IpcEventBroadcaster, sessionBroadcaster?: IpcSessionBroadcaster) {
    super();
    this.#broadcaster = broadcaster;
    this.#sessionBroadcaster = sessionBroadcaster;
  }

  protected handle(
    params: EventUnsubscribeParams,
    context: RpcInvocationContext,
  ): EventUnsubscribeResult {
    const session = this.#sessionBroadcaster?.unsubscribe(
      context.connection,
      params.subscriptionId,
    );
    if (session?.removed) {
      return session;
    }
    return this.#broadcaster.unsubscribe(context.connection, params.subscriptionId);
  }
}
