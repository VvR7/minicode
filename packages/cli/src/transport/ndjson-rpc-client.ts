import {
  JsonRpcResponseEnvelopeSchema,
  JSON_RPC_VERSION,
  MAX_JSON_RPC_FRAME_BYTES,
} from "@minicode/protocol";

import type { CoreEndpoint, JsonRpcId } from "@minicode/protocol";
import type { z } from "zod";

export const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface PendingWrite {
  readonly bytes: Uint8Array;
  offset: number;
}

interface ClientState<Result> {
  input: Uint8Array;
  readonly writes: PendingWrite[];
  settled: boolean;
  socket: Bun.Socket<ClientState<Result>> | undefined;
  resolve: (value: RpcRoundTrip<Result>) => void;
  reject: (error: RpcClientError) => void;
}

export interface RpcRoundTrip<Result> {
  readonly result: Result;
  readonly latencyMs: number;
}

export interface NdjsonRpcClientOptions {
  readonly timeoutMs?: number;
}

export interface RpcRequestOptions {
  readonly requestId?: JsonRpcId;
}

export class RpcClientError extends Error {
  override readonly name = "RpcClientError";
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function settleError<Result>(state: ClientState<Result>, message: string): void {
  if (state.settled) {
    return;
  }
  state.settled = true;
  state.reject(new RpcClientError(message));
}

/** 处理 TCP 部分写入和背压，所有 CLI 命令共用这一实现。 */
function flushWrites<Result>(socket: Bun.Socket<ClientState<Result>>): void {
  const state = socket.data;
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

/** 解析一条响应，校验 JSON-RPC envelope、请求 ID 和调用方提供的 result schema。 */
function processResponse<ResultSchema extends z.ZodType>(
  state: ClientState<z.output<ResultSchema>>,
  requestId: JsonRpcId,
  resultSchema: ResultSchema,
  startedAt: number,
): void {
  const newlineIndex = state.input.indexOf(0x0a);
  if (newlineIndex === -1) {
    if (state.input.byteLength > MAX_JSON_RPC_FRAME_BYTES) {
      settleError(state, "response exceeds 1 MiB");
    }
    return;
  }
  if (newlineIndex > MAX_JSON_RPC_FRAME_BYTES) {
    settleError(state, "response exceeds 1 MiB");
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(state.input.slice(0, newlineIndex))) as unknown;
  } catch {
    settleError(state, "core returned invalid JSON");
    return;
  }

  const envelope = JsonRpcResponseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    settleError(state, "core returned an invalid response");
    return;
  }
  if (envelope.data.id !== requestId) {
    settleError(state, "core returned a mismatched response id");
    return;
  }
  if ("error" in envelope.data) {
    settleError(state, `core error ${envelope.data.error.code}: ${envelope.data.error.message}`);
    return;
  }

  const result = resultSchema.safeParse(envelope.data.result);
  if (!result.success) {
    settleError(state, "core returned an invalid response result");
    return;
  }

  state.settled = true;
  state.resolve({
    result: result.data,
    latencyMs: Math.max(0, Math.floor(performance.now() - startedAt)),
  });
}

/**
 * 可供所有 CLI 命令复用的一次性 JSON-RPC over TCP/NDJSON 客户端。
 * 每次 request 建立连接、发送一条请求、读取一条响应，然后释放连接。
 */
export class NdjsonRpcClient {
  readonly #endpoint: CoreEndpoint;
  readonly #timeoutMs: number;

  constructor(endpoint: CoreEndpoint, options: NdjsonRpcClientOptions = {}) {
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  async request<ResultSchema extends z.ZodType>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    resultSchema: ResultSchema,
    options: RpcRequestOptions = {},
  ): Promise<RpcRoundTrip<z.output<ResultSchema>>> {
    const requestId = options.requestId ?? crypto.randomUUID();
    const startedAt = performance.now();
    const request = encoder.encode(
      `${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: requestId, method, params })}\n`,
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let state: ClientState<z.output<ResultSchema>> | undefined;
    const operation = new Promise<RpcRoundTrip<z.output<ResultSchema>>>((resolve, reject) => {
      state = {
        input: new Uint8Array(),
        writes: [],
        settled: false,
        socket: undefined,
        resolve,
        reject,
      };

      void Bun.connect<ClientState<z.output<ResultSchema>>>({
        hostname: this.#endpoint.host,
        port: this.#endpoint.port,
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
            processResponse(socket.data, requestId, resultSchema, startedAt);
            if (socket.data.settled) {
              socket.end();
            }
          },
          drain: (socket) => flushWrites(socket),
          end: (socket) => settleError(socket.data, "core closed the connection before responding"),
          close: (socket) =>
            settleError(socket.data, "core closed the connection before responding"),
          error: (socket, error) => settleError(socket.data, `socket error: ${error.message}`),
          connectError: (socket, error) =>
            settleError(socket.data, `cannot connect to core: ${error.message}`),
        },
      }).catch((error: unknown) => {
        if (state !== undefined) {
          const message = error instanceof Error ? error.message : "unknown connection error";
          settleError(state, `cannot connect to core: ${message}`);
        }
      });
    });

    timeout = setTimeout(() => {
      if (state !== undefined) {
        settleError(state, `request timed out after ${this.#timeoutMs}ms`);
        state.socket?.terminate();
      }
    }, this.#timeoutMs);

    try {
      return await operation;
    } finally {
      clearTimeout(timeout);
      const socket = state?.socket;
      if (socket !== undefined && socket.readyState > 0) {
        socket.end();
      }
    }
  }
}
