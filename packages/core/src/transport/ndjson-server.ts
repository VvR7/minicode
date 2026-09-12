import { JsonRpcErrorCode, makeJsonRpcError } from "@minicode/protocol";

import type { CoreEndpoint, JsonRpcErrorResponse } from "@minicode/protocol";
import type { Logger } from "../logger.ts";
import type { JsonRpcDispatchResult } from "../rpc-dispatcher.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

type FrameJob =
  | { readonly kind: "frame"; readonly bytes: Uint8Array }
  | { readonly kind: "oversize" };

interface PendingWrite {
  readonly bytes: Uint8Array;
  offset: number;
}

interface ConnectionState {
  input: Uint8Array;
  readonly jobs: FrameJob[];
  processing: Promise<void>;
  readonly writes: PendingWrite[];
  closeAfterWrites: boolean;
  acceptingInput: boolean;
  readonly closed: Promise<void>;
  resolveClosed: () => void;
}

export type RpcFrameHandler = (value: unknown) => Promise<JsonRpcDispatchResult>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function createConnectionState(): ConnectionState {
  let resolveClosed = (): void => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    input: new Uint8Array(),
    jobs: [],
    processing: Promise.resolve(),
    writes: [],
    closeAfterWrites: false,
    acceptingInput: true,
    closed,
    resolveClosed,
  };
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function encodeResponse(response: JsonRpcDispatchResult | JsonRpcErrorResponse): Uint8Array {
  return encoder.encode(`${JSON.stringify(response)}\n`);
}

function flushWrites(socket: Bun.Socket<ConnectionState>): void {
  const state = socket.data;
  while (state.writes.length > 0) {
    const pending = state.writes[0];
    if (pending === undefined) {
      break;
    }
    const written = socket.write(
      pending.bytes,
      pending.offset,
      pending.bytes.byteLength - pending.offset,
    );
    if (written < 0) {
      state.writes.length = 0;
      socket.terminate();
      return;
    }
    pending.offset += written;
    if (pending.offset < pending.bytes.byteLength) {
      return;
    }
    state.writes.shift();
  }

  if (state.closeAfterWrites) {
    socket.end();
  }
}

function enqueueResponse(
  socket: Bun.Socket<ConnectionState>,
  response: JsonRpcDispatchResult | JsonRpcErrorResponse,
): void {
  socket.data.writes.push({ bytes: encodeResponse(response), offset: 0 });
  flushWrites(socket);
}

function parseFrame(
  bytes: Uint8Array,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(decoder.decode(bytes)) as unknown };
  } catch {
    return { ok: false };
  }
}

export class NdjsonRpcServer {
  readonly #endpoint: CoreEndpoint;
  readonly #handler: RpcFrameHandler;
  readonly #logger: Logger;
  readonly #activeSockets = new Set<Bun.Socket<ConnectionState>>();
  #listener: Bun.TCPSocketListener | undefined;
  #stopping = false;

  constructor(endpoint: CoreEndpoint, handler: RpcFrameHandler, logger: Logger) {
    this.#endpoint = endpoint;
    this.#handler = handler;
    this.#logger = logger;
  }

  start(): CoreEndpoint {
    if (this.#listener !== undefined) {
      throw new Error("server already started");
    }

    this.#listener = Bun.listen<ConnectionState>({
      hostname: this.#endpoint.host,
      port: this.#endpoint.port,
      exclusive: true,
      socket: {
        binaryType: "uint8array",
        open: (socket) => {
          socket.data = createConnectionState();
          this.#activeSockets.add(socket);
          this.#logger.debug(
            `client connected remote=${socket.remoteAddress}:${socket.remotePort}`,
          );
        },
        data: (socket, data) => {
          this.#acceptData(socket, data);
        },
        drain: (socket) => {
          flushWrites(socket);
        },
        close: (socket) => {
          this.#activeSockets.delete(socket);
          socket.data.resolveClosed();
          this.#logger.debug(
            `client disconnected remote=${socket.remoteAddress}:${socket.remotePort}`,
          );
        },
        error: (socket, error) => {
          this.#logger.warn(
            `socket error remote=${socket.remoteAddress}:${socket.remotePort} message=${error.message}`,
          );
        },
      },
    });

    return { host: this.#endpoint.host, port: this.#listener.port };
  }

  async stop(graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    if (this.#listener === undefined) {
      return;
    }

    this.#stopping = true;
    this.#listener.stop(false);
    this.#listener = undefined;

    const sockets = [...this.#activeSockets];
    for (const socket of sockets) {
      socket.data.acceptingInput = false;
      void socket.data.processing.finally(() => {
        socket.data.closeAfterWrites = true;
        flushWrites(socket);
      });
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, graceMs);
      void Promise.all(sockets.map((socket) => socket.data.closed)).then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    for (const socket of this.#activeSockets) {
      socket.terminate();
    }
    this.#stopping = false;
  }

  #acceptData(socket: Bun.Socket<ConnectionState>, data: Uint8Array): void {
    const state = socket.data;
    if (!state.acceptingInput || this.#stopping) {
      return;
    }

    state.input = concatenate(state.input, new Uint8Array(data));
    while (state.acceptingInput) {
      const newlineIndex = state.input.indexOf(0x0a);
      if (newlineIndex === -1) {
        if (state.input.byteLength > MAX_FRAME_BYTES) {
          this.#queueOversize(state);
        }
        break;
      }

      if (newlineIndex > MAX_FRAME_BYTES) {
        this.#queueOversize(state);
        break;
      }

      state.jobs.push({ kind: "frame", bytes: state.input.slice(0, newlineIndex) });
      state.input = state.input.slice(newlineIndex + 1);
    }
    this.#scheduleJobs(socket);
  }

  #queueOversize(state: ConnectionState): void {
    state.jobs.push({ kind: "oversize" });
    state.input = new Uint8Array();
    state.acceptingInput = false;
  }

  #scheduleJobs(socket: Bun.Socket<ConnectionState>): void {
    const state = socket.data;
    state.processing = state.processing
      .then(async () => {
        while (state.jobs.length > 0) {
          const job = state.jobs.shift();
          if (job === undefined) {
            continue;
          }
          if (job.kind === "oversize") {
            enqueueResponse(
              socket,
              makeJsonRpcError(null, JsonRpcErrorCode.invalidRequest, "Request too large"),
            );
            state.closeAfterWrites = true;
            flushWrites(socket);
            return;
          }

          const parsed = parseFrame(job.bytes);
          if (!parsed.ok) {
            enqueueResponse(
              socket,
              makeJsonRpcError(null, JsonRpcErrorCode.parseError, "Parse error"),
            );
            continue;
          }

          try {
            enqueueResponse(socket, await this.#handler(parsed.value));
          } catch {
            enqueueResponse(
              socket,
              makeJsonRpcError(null, JsonRpcErrorCode.internalError, "Internal error"),
            );
          }
        }
      })
      .catch(() => {
        enqueueResponse(
          socket,
          makeJsonRpcError(null, JsonRpcErrorCode.internalError, "Internal error"),
        );
      });
  }
}
