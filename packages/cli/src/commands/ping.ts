import {
  CORE_PING_METHOD,
  formatEndpoint,
  MINICODE_VERSION,
  PongResultSchema,
} from "@minicode/protocol";

import type { CoreEndpoint, JsonRpcId } from "@minicode/protocol";
import { NdjsonRpcClient, RpcClientError } from "../transport/ndjson-rpc-client.ts";

export interface PingCommandOptions {
  readonly timeoutMs?: number;
  readonly requestId?: JsonRpcId;
}

/** 执行 core.ping 命令；底层 TCP 和 JSON-RPC 细节由共享 transport 负责。 */
export async function runPingCommand(
  endpoint: CoreEndpoint,
  options: PingCommandOptions = {},
): Promise<number> {
  try {
    const client = new NdjsonRpcClient(endpoint, options);
    const response = await client.request(
      CORE_PING_METHOD,
      { clientName: "mc-ping", clientVersion: MINICODE_VERSION },
      PongResultSchema,
      options,
    );
    console.log(
      `pong server=${response.result.serverVersion} uptime=${response.result.uptimeMs}ms latency=${response.latencyMs}ms`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof RpcClientError ? error.message : "unexpected ping failure";
    console.error(`error: ${message} (${formatEndpoint(endpoint)})`);
    return 1;
  }
}
