import type { JsonRpcNotificationEnvelope } from "@minicode/protocol";

/** Handler 只能通过该窄接口识别连接和推送通知，不能接触 Bun socket。 */
export interface RpcConnection {
  readonly id: string;
  readonly closed: Promise<void>;
  sendNotification(notification: JsonRpcNotificationEnvelope): Promise<boolean>;
  disconnect(): void;
}

export interface RpcInvocationContext {
  readonly connection: RpcConnection;
}
