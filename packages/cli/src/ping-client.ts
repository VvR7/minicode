import {
  CORE_PING_METHOD,
  JSON_RPC_VERSION,
  MINICODE_VERSION,
  PingResponseSchema,
} from "@minicode/protocol";

import type { CoreEndpoint, JsonRpcId, PongResult } from "@minicode/protocol";

export const PING_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface PendingWrite {
  readonly bytes: Uint8Array;
  offset: number;
}

interface ClientState {
  input: Uint8Array;
  readonly writes: PendingWrite[];
  settled: boolean;
  socket: Bun.Socket<ClientState> | undefined;
  resolve: (value: PingRoundTrip) => void;
  reject: (error: PingClientError) => void;
}

export interface PingRoundTrip {
  readonly result: PongResult;
  readonly latencyMs: number;
}

export class PingClientError extends Error {
  override readonly name = "PingClientError";
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function settleError(state: ClientState, message: string): void {
  if (state.settled) {
    return;
  }
  state.settled = true;
  state.reject(new PingClientError(message));
}

function flushWrites(socket: Bun.Socket<ClientState>): void {
  const state = socket.data;
  // 处理部分写入；未写完的部分由 drain 回调继续发送。
  while (state.writes.length > 0) {
    const pending = state.writes[0];
    if (pending === undefined) {
      return;
    }
    const written = socket.write(
      pending.bytes,
      pending.offset,
      pending.bytes.byteLength - pending.offset,
    );
    if (written < 0) {
      settleError(state, "failed to write request");
      return;
    }
    pending.offset += written;
    if (pending.offset < pending.bytes.byteLength) {
      return;
    }
    state.writes.shift();
  }
}

function processResponse(state: ClientState, requestId: JsonRpcId, startedAt: number): void {
  const newlineIndex = state.input.indexOf(0x0a);
  if (newlineIndex === -1) {
    if (state.input.byteLength > MAX_RESPONSE_BYTES) {
      settleError(state, "response exceeds 1 MiB");
    }
    return;
  }
  if (newlineIndex > MAX_RESPONSE_BYTES) {
    settleError(state, "response exceeds 1 MiB");
    return;
  }

  let raw: unknown;
  try {
    // fatal UTF-8 decoder 会把无效字节视为协议错误，而不是替换为不可见字符后继续解析。
    raw = JSON.parse(decoder.decode(state.input.slice(0, newlineIndex))) as unknown;
  } catch {
    settleError(state, "core returned invalid JSON");
    return;
  }

  const response = PingResponseSchema.safeParse(raw);
  if (!response.success) {
    settleError(state, "core returned an invalid response");
    return;
  }
  if (response.data.id !== requestId) {
    // 同一端口上的旧响应或错误实现不能被误认为本次 ping 的结果。
    settleError(state, "core returned a mismatched response id");
    return;
  }
  if ("error" in response.data) {
    settleError(state, `core error ${response.data.error.code}: ${response.data.error.message}`);
    return;
  }

  state.settled = true;
  state.resolve({
    result: response.data.result,
    latencyMs: Math.max(0, Math.floor(performance.now() - startedAt)),
  });
}

export async function pingCore(
  endpoint: CoreEndpoint,
  options: { readonly timeoutMs?: number; readonly requestId?: JsonRpcId } = {},
): Promise<PingRoundTrip> {
  const timeoutMs = options.timeoutMs ?? PING_TIMEOUT_MS;
  const requestId = options.requestId ?? crypto.randomUUID();
  const startedAt = performance.now();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let state: ClientState | undefined;
  const operation = new Promise<PingRoundTrip>((resolve, reject) => {
    state = {
      input: new Uint8Array(),
      writes: [],
      settled: false,
      socket: undefined,
      resolve,
      reject,
    };
    const request = encoder.encode(
      `${JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: requestId,
        method: CORE_PING_METHOD,
        params: { clientName: "mc-ping", clientVersion: MINICODE_VERSION },
      })}\n`,
    );

    void Bun.connect<ClientState>({
      hostname: endpoint.host,
      port: endpoint.port,
      data: state,
      socket: {
        binaryType: "uint8array",
        open: (socket) => {
          socket.data.socket = socket;
          if (socket.data.settled) {
            socket.terminate();
            return;
          }
          socket.data.writes.push({ bytes: request, offset: 0 });
          flushWrites(socket);
        },
        data: (socket, data) => {
          if (socket.data.settled) {
            return;
          }
          socket.data.input = concatenate(socket.data.input, new Uint8Array(data));
          processResponse(socket.data, requestId, startedAt);
          if (socket.data.settled) {
            socket.end();
          }
        },
        drain: (socket) => {
          flushWrites(socket);
        },
        end: (socket) => {
          settleError(socket.data, "core closed the connection before responding");
        },
        close: (socket) => {
          settleError(socket.data, "core closed the connection before responding");
        },
        error: (socket, error) => {
          settleError(socket.data, `socket error: ${error.message}`);
        },
        connectError: (socket, error) => {
          settleError(socket.data, `cannot connect to core: ${error.message}`);
        },
      },
    }).catch((error: unknown) => {
      if (state !== undefined) {
        const message = error instanceof Error ? error.message : "unknown connection error";
        settleError(state, `cannot connect to core: ${message}`);
      }
    });
  });

  const timedOperation = new Promise<PingRoundTrip>((resolve, reject) => {
    timeout = setTimeout(() => {
      if (state !== undefined) {
        settleError(state, `ping timed out after ${timeoutMs}ms`);
        // 超时必须主动释放 socket；否则仍在连接中的请求会遗留句柄并阻止 CLI 退出。
        state.socket?.terminate();
      }
    }, timeoutMs);
    operation.then(resolve, reject);
  });

  try {
    return await timedOperation;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    const socket = state?.socket;
    if (socket !== undefined && socket.readyState > 0) {
      socket.end();
    }
  }
}
