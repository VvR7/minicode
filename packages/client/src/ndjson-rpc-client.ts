import type {
  CoreEndpoint,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcNotificationEnvelope,
} from "@minicode/protocol";
import {
  JSON_RPC_VERSION,
  JsonRpcNotificationEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  MAX_JSON_RPC_FRAME_BYTES,
} from "@minicode/protocol";
import type { z } from "zod";

export const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface PendingWrite {
  readonly bytes: Uint8Array;
  offset: number;
}

interface PendingRequest {
  readonly resultSchema: z.ZodType;
  readonly startedAt: number;
  readonly resolve: (value: RpcRoundTrip<unknown>) => void;
  readonly reject: (error: RpcClientError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface ClientState {
  input: Uint8Array;
  readonly writes: PendingWrite[];
  readonly pending: Map<JsonRpcId, PendingRequest>;
  readonly notificationListeners: Set<NotificationListener>;
  socket: Bun.Socket<ClientState> | undefined;
  closed: boolean;
  connected: boolean;
  resolveConnected: () => void;
  rejectConnected: (error: RpcClientError) => void;
  readonly closedSignal: Promise<void>;
  resolveClosed: () => void;
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
  readonly timeoutMs?: number;
}

export type NotificationListener = (notification: JsonRpcNotificationEnvelope) => void;

export class RpcClientError extends Error {
  override readonly name = "RpcClientError";

  /** JSON-RPC application error code；传输层错误不携带该字段。 */
  readonly code: number | undefined;

  /** Core 返回的已通过协议校验的安全错误数据。 */
  readonly data: unknown;

  /** 创建传输错误或携带结构化 JSON-RPC application error 的客户端错误。 */
  constructor(message: string, error?: Pick<JsonRpcErrorObject, "code" | "data">) {
    super(message);
    this.code = error?.code;
    this.data = error?.data;
  }
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function asClientError(message: string): RpcClientError {
  return new RpcClientError(message);
}

function rejectPending(state: ClientState, message: string): void {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(asClientError(message));
  }
  state.pending.clear();
}

/** 将连接置为不可用，并一次性拒绝所有仍在等待响应的请求。 */
function failConnection(state: ClientState, message: string): void {
  if (state.closed) {
    return;
  }
  state.closed = true;
  const error = asClientError(message);
  if (!state.connected) {
    state.rejectConnected(error);
  }
  rejectPending(state, message);
  state.resolveClosed();
}

/** 处理 TCP 部分写入和背压，持久连接上的所有请求共用同一写队列。 */
function flushWrites(socket: Bun.Socket<ClientState>): void {
  const state = socket.data;
  while (!state.closed && state.writes.length > 0) {
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
      failConnection(state, "failed to write request");
      socket.terminate();
      return;
    }
    pending.offset += written;
    if (pending.offset < pending.bytes.byteLength) {
      return;
    }
    state.writes.shift();
  }
}

function completeResponse(state: ClientState, raw: unknown): boolean {
  const envelope = JsonRpcResponseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return false;
  }

  if (envelope.data.id === null) {
    failConnection(state, "core returned a response without a request id");
    state.socket?.terminate();
    return true;
  }
  const pending = state.pending.get(envelope.data.id);
  if (pending === undefined) {
    failConnection(state, "core returned a mismatched response id");
    state.socket?.terminate();
    return true;
  }
  state.pending.delete(envelope.data.id);
  clearTimeout(pending.timeout);

  if ("error" in envelope.data) {
    pending.reject(
      new RpcClientError(
        `core error ${envelope.data.error.code}: ${envelope.data.error.message}`,
        envelope.data.error,
      ),
    );
    return true;
  }

  const result = pending.resultSchema.safeParse(envelope.data.result);
  if (!result.success) {
    pending.reject(asClientError("core returned an invalid response result"));
    return true;
  }
  pending.resolve({
    result: result.data,
    latencyMs: Math.max(0, Math.floor(performance.now() - pending.startedAt)),
  });
  return true;
}

function dispatchNotification(state: ClientState, raw: unknown): boolean {
  const notification = JsonRpcNotificationEnvelopeSchema.safeParse(raw);
  if (!notification.success) {
    return false;
  }
  // response Promise 的 continuation 已在解析前一帧时入微任务队列；通知随后排队，
  // 让调用方能先拿到 agent.run 的 subscriptionId，再注册首事件 listener。
  queueMicrotask(() => {
    for (const listener of state.notificationListeners) {
      try {
        listener(notification.data);
      } catch {
        // 一个 UI listener 的异常不能破坏连接，也不能影响其他 listener。
      }
    }
  });
  return true;
}

/** 消耗当前缓冲区中的全部完整 NDJSON 帧；半帧留待下一次 data 回调。 */
function processFrames(state: ClientState): void {
  while (!state.closed) {
    const newlineIndex = state.input.indexOf(0x0a);
    if (newlineIndex === -1) {
      if (state.input.byteLength > MAX_JSON_RPC_FRAME_BYTES) {
        failConnection(state, "core frame exceeds 1 MiB");
        state.socket?.terminate();
      }
      return;
    }
    if (newlineIndex > MAX_JSON_RPC_FRAME_BYTES) {
      failConnection(state, "core frame exceeds 1 MiB");
      state.socket?.terminate();
      return;
    }

    const frame = state.input.slice(0, newlineIndex);
    state.input = state.input.slice(newlineIndex + 1);
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(frame)) as unknown;
    } catch {
      failConnection(state, "core returned invalid JSON");
      state.socket?.terminate();
      return;
    }

    if (!completeResponse(state, raw) && !dispatchNotification(state, raw)) {
      failConnection(state, "core returned an invalid message");
      state.socket?.terminate();
      return;
    }
  }
}

/**
 * 一条可复用的 JSON-RPC over TCP/NDJSON 长连接。
 * pending map 按请求 ID 关联交错响应，notification listener 接收服务端事件。
 */
export class NdjsonRpcConnection {
  readonly #state: ClientState;
  readonly #defaultTimeoutMs: number;

  private constructor(state: ClientState, defaultTimeoutMs: number) {
    this.#state = state;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  static async connect(
    endpoint: CoreEndpoint,
    options: NdjsonRpcClientOptions = {},
  ): Promise<NdjsonRpcConnection> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    let resolveConnected = (): void => {};
    let rejectConnected = (_error: RpcClientError): void => {};
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    let resolveClosed = (): void => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const state: ClientState = {
      input: new Uint8Array(),
      writes: [],
      pending: new Map(),
      notificationListeners: new Set(),
      socket: undefined,
      closed: false,
      connected: false,
      resolveConnected,
      rejectConnected,
      closedSignal: closed,
      resolveClosed,
    };

    const connectTimeout = setTimeout(() => {
      failConnection(state, `connection timed out after ${timeoutMs}ms`);
      state.socket?.terminate();
    }, timeoutMs);

    void Bun.connect<ClientState>({
      hostname: endpoint.host,
      port: endpoint.port,
      data: state,
      socket: {
        binaryType: "uint8array",
        open: (socket) => {
          socket.data.socket = socket;
          if (socket.data.closed) {
            socket.terminate();
            return;
          }
          socket.data.connected = true;
          socket.data.resolveConnected();
        },
        data: (socket, data) => {
          socket.data.input = concatenate(socket.data.input, new Uint8Array(data));
          processFrames(socket.data);
        },
        drain: (socket) => flushWrites(socket),
        end: (socket) => failConnection(socket.data, "core closed the connection"),
        close: (socket) => failConnection(socket.data, "core closed the connection"),
        error: (socket, error) => failConnection(socket.data, `socket error: ${error.message}`),
        connectError: (socket, error) =>
          failConnection(socket.data, `cannot connect to core: ${error.message}`),
      },
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown connection error";
      failConnection(state, `cannot connect to core: ${message}`);
    });

    try {
      await connected;
      return new NdjsonRpcConnection(state, timeoutMs);
    } finally {
      clearTimeout(connectTimeout);
    }
  }

  get closed(): boolean {
    return this.#state.closed;
  }

  onNotification(listener: NotificationListener): () => void {
    if (this.#state.closed) {
      throw asClientError("connection is closed");
    }
    this.#state.notificationListeners.add(listener);
    return () => this.#state.notificationListeners.delete(listener);
  }

  waitUntilClosed(): Promise<void> {
    return this.#state.closedSignal;
  }

  request<ResultSchema extends z.ZodType>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    resultSchema: ResultSchema,
    options: RpcRequestOptions = {},
  ): Promise<RpcRoundTrip<z.output<ResultSchema>>> {
    if (this.#state.closed || this.#state.socket === undefined) {
      return Promise.reject(asClientError("connection is closed"));
    }
    const requestId = options.requestId ?? crypto.randomUUID();
    if (this.#state.pending.has(requestId)) {
      return Promise.reject(asClientError(`duplicate pending request id: ${String(requestId)}`));
    }
    const bytes = encoder.encode(
      `${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: requestId, method, params })}\n`,
    );
    if (bytes.byteLength - 1 > MAX_JSON_RPC_FRAME_BYTES) {
      return Promise.reject(asClientError("request exceeds 1 MiB"));
    }

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const operation = new Promise<RpcRoundTrip<z.output<ResultSchema>>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#state.pending.get(requestId);
        if (pending === undefined) {
          return;
        }
        // 超时响应未来仍可能抵达；关闭连接可避免把它误判为其他请求的响应。
        failConnection(this.#state, `request timed out after ${timeoutMs}ms`);
        this.#state.socket?.terminate();
      }, timeoutMs);
      this.#state.pending.set(requestId, {
        resultSchema,
        startedAt: performance.now(),
        resolve: (value) => resolve(value as RpcRoundTrip<z.output<ResultSchema>>),
        reject,
        timeout,
      });
    });

    this.#state.writes.push({ bytes, offset: 0 });
    flushWrites(this.#state.socket);
    return operation;
  }

  close(): void {
    if (this.#state.closed) {
      return;
    }
    failConnection(this.#state, "connection closed by client");
    this.#state.socket?.terminate();
  }
}

/** 保留简单命令使用的一次性 facade；需要事件流时调用 connect() 获取长连接。 */
export class NdjsonRpcClient {
  readonly #endpoint: CoreEndpoint;
  readonly #options: NdjsonRpcClientOptions;

  constructor(endpoint: CoreEndpoint, options: NdjsonRpcClientOptions = {}) {
    this.#endpoint = endpoint;
    this.#options = options;
  }

  connect(): Promise<NdjsonRpcConnection> {
    return NdjsonRpcConnection.connect(this.#endpoint, this.#options);
  }

  async request<ResultSchema extends z.ZodType>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    resultSchema: ResultSchema,
    options: RpcRequestOptions = {},
  ): Promise<RpcRoundTrip<z.output<ResultSchema>>> {
    const connection = await this.connect();
    try {
      return await connection.request(method, params, resultSchema, options);
    } finally {
      connection.close();
    }
  }
}
