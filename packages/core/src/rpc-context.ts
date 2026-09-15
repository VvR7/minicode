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
  /** 已通过 envelope 校验的请求 ID，供 run-scoped Trace 关联 IPC 边界。 */
  readonly requestId?: string;
}
