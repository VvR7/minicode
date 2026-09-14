import type { JsonRpcId, JsonRpcNotificationEnvelope } from "@minicode/protocol";

/** Handler 只能通过该窄接口识别连接和推送通知，不能接触 Bun socket。 */
export interface RpcConnection {
  readonly id: string;
  readonly closed: Promise<void>;
  sendNotification(notification: JsonRpcNotificationEnvelope): Promise<boolean>;
  disconnect(): void;
}

export interface RpcInvocationContext {
  readonly connection: RpcConnection;
  /** dispatcher 校验后的请求 ID；直接单测 handler 时可省略。 */
  readonly requestId?: JsonRpcId;
  /** dispatcher 已路由的方法名；直接单测 handler 时可省略。 */
  readonly method?: string;
}
