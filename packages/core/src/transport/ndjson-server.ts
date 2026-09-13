// 导入协议层定义的标准错误码，以及构造 JSON-RPC 错误响应的函数。

// 这里只导入类型；编译后的 JavaScript 不会包含这些导入。
import type {
  CoreEndpoint,
  JsonRpcErrorResponse,
  JsonRpcNotificationEnvelope,
  JsonRpcSuccessEnvelope,
} from "@minicode/protocol";
import { JsonRpcErrorCode, MAX_JSON_RPC_FRAME_BYTES, makeJsonRpcError } from "@minicode/protocol";
// Logger 负责把连接和错误信息写到 stderr。
import type { Logger } from "../logger.ts";
import type { RpcConnection, RpcInvocationContext } from "../rpc-context.ts";
// 分发器接收解析后的 JSON，并返回一个可发送的 JSON-RPC 响应。
import type { JsonRpcDispatchResult } from "../rpc-dispatcher.ts";

type OutboundMessage = JsonRpcSuccessEnvelope | JsonRpcErrorResponse | JsonRpcNotificationEnvelope;

// 单条 NDJSON 请求的最大字节数：1 MiB，防止无限制占用内存。
// 停止服务时，最多等待在途请求与连接关闭的时间。
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const MAX_CONNECTION_WRITE_FRAMES = 256;
export const MAX_CONNECTION_WRITE_BYTES = 4 * 1024 * 1024;

// 队列中的工作项：要么是一条完整帧，要么是已经确认超限的输入。
type FrameJob =
  // bytes 保存 LF 换行符之前的原始 UTF-8 字节。
  | { readonly kind: "frame"; readonly bytes: Uint8Array }
  // oversize 不保存超长数据，只保留一个标记以避免额外的内存占用。
  | { readonly kind: "oversize" };

// 一次 socket.write 尚未完整写出的响应。
interface PendingWrite {
  // bytes 是整条 JSON-RPC 响应加结尾换行符。
  readonly bytes: Uint8Array;
  // offset 表示下次应从 bytes 的哪个位置继续写。
  offset: number;
  // completed 只在整帧交给内核或连接失败后完成，供订阅级背压感知真实发送进度。
  readonly resolveCompleted: (sent: boolean) => void;
}

interface EnqueueResult {
  readonly accepted: boolean;
  readonly completed: Promise<boolean>;
}

// 每一个 TCP 连接都有自己独立的状态，互不共享请求队列。
interface ConnectionState {
  // input 累积尚未以 LF 结束的字节，也可能包含多条尚未取出的帧。
  input: Uint8Array;
  // jobs 是等待按顺序解析和分发的请求。
  readonly jobs: FrameJob[];
  // processing 是当前处理链；把新任务接到它后面即可实现串行。
  processing: Promise<void>;
  // writes 保存等待写入或因背压未写完的响应。
  readonly writes: PendingWrite[];
  // queuedWriteBytes 统计尚未交给内核的出站字节，用于隔离慢客户端。
  queuedWriteBytes: number;
  // true 表示写队列清空后应调用 socket.end()。
  closeAfterWrites: boolean;
  // false 后不再从客户端接受新的请求字节。
  acceptingInput: boolean;
  // closed 会在 socket 的 close 回调触发时完成。
  readonly closed: Promise<void>;
  // resolveClosed 是完成 closed Promise 的函数。
  resolveClosed: () => void;
  // connection 是提供给业务 handler 的窄接口，不暴露底层 socket。
  readonly connection: RpcConnection;
  // true 表示 close 已发生，之后不能再接受任何出站消息。
  closedState: boolean;
}

// Core 注入的业务处理函数：输入尚未可信任的 JSON，输出已构造的响应。
export type RpcFrameHandler = (
  value: unknown,
  context: RpcInvocationContext,
) => Promise<JsonRpcDispatchResult>;

// encoder 用于把响应字符串转换为 UTF-8 字节。
const encoder = new TextEncoder();
// fatal: true 让无效 UTF-8 抛错，而不是用替代字符悄悄继续。
const decoder = new TextDecoder("utf-8", { fatal: true });

/** 创建一条 TCP 连接专属的输入缓冲、请求队列、写队列和关闭通知。 */
function createConnectionState(socket: Bun.Socket<ConnectionState>): ConnectionState {
  // 先提供一个空函数，随后由 Promise 构造器赋值为真实的 resolve。
  let resolveClosed = (): void => {};
  // closed 让 stop() 能异步等待这条连接真正关闭。
  const closed = new Promise<void>((resolve) => {
    // 保存 resolve，供 socket.close 回调使用。
    resolveClosed = resolve;
  });
  // 连接对象只暴露安全的通知发送能力，业务层不能直接操作 socket。
  const connection: RpcConnection = {
    id: crypto.randomUUID(),
    closed,
    sendNotification(notification) {
      return enqueueMessage(socket, notification).completed;
    },
    disconnect() {
      socket.terminate();
    },
  };
  // 返回所有字段都有安全初始值的连接状态。
  const state: ConnectionState = {
    // 没有收到任何字节时，输入缓冲为空。
    input: new Uint8Array(),
    // 新连接还没有等待处理的帧。
    jobs: [],
    // 用已完成 Promise 作为串行处理链的起点。
    processing: Promise.resolve(),
    // 新连接还没有等待发送的响应。
    writes: [],
    queuedWriteBytes: 0,
    // 默认不会在写完后关闭连接。
    closeAfterWrites: false,
    // 默认允许客户端发送请求。
    acceptingInput: true,
    // 把关闭 Promise 保存到状态中。
    closed,
    // 把完成关闭 Promise 的函数保存到状态中。
    resolveClosed,
    connection,
    closedState: false,
  };
  return state;
}

/** 合并已有的未完成输入与本次收到的字节，保留跨 TCP 回调的半帧。 */
function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  // 分配刚好容纳两段字节的新数组。
  const output = new Uint8Array(left.byteLength + right.byteLength);
  // 先复制旧的残留输入。
  output.set(left);
  // 再紧跟着复制本次网络回调收到的字节。
  output.set(right, left.byteLength);
  // 返回连续的输入缓冲。
  return output;
}

/** 将 JSON-RPC 响应编码为以换行符结尾的一条 UTF-8 NDJSON 帧。 */
function encodeMessage(message: OutboundMessage): Uint8Array {
  // JSON.stringify 生成一条 JSON 值，\n 将它变成一条 NDJSON 帧。
  return encoder.encode(`${JSON.stringify(message)}\n`);
}

/** 尽可能写出队列中的响应；遇到背压时由 socket 的 drain 回调继续。 */
function flushWrites(socket: Bun.Socket<ConnectionState>): void {
  // 取出这条连接自己的状态。
  const state = socket.data;
  // socket.write 可能只接受部分字节；保留 offset，等 drain 回调继续写，避免截断 JSON 帧。
  while (state.writes.length > 0) {
    const pending = state.writes[0];
    // TypeScript 防御：理论上 length > 0 时首项存在，但仍显式处理异常状态。
    if (pending === undefined) {
      break;
    }
    const written = socket.write(
      // 要写出的完整响应字节。
      pending.bytes,
      // 从此前未写完的位置继续。
      pending.offset,
      // 只请求写出剩余字节。
      pending.bytes.byteLength - pending.offset,
    );
    // 小于 0 表示写入失败，无法安全恢复，因此丢弃队列并立即终止连接。
    if (written < 0) {
      rejectPendingWrites(state);
      socket.terminate();
      return;
    }
    pending.offset += written;
    state.queuedWriteBytes -= written;
    // 没写完时返回；Bun 稍后会调用 drain，届时继续写。
    if (pending.offset < pending.bytes.byteLength) {
      return;
    }
    state.writes.shift();
    pending.resolveCompleted(true);
  }

  if (state.closeAfterWrites) {
    // 所有响应都已经交给系统发送后，半关闭写端，让客户端读到 EOF。
    socket.end();
  }
}

/** 将一个响应加入连接的写队列，并立即尝试发送。 */
function enqueueMessage(
  socket: Bun.Socket<ConnectionState>,
  message: OutboundMessage,
): EnqueueResult {
  const state = socket.data;
  if (state.closedState) {
    return { accepted: false, completed: Promise.resolve(false) };
  }
  const bytes = encodeMessage(message);
  // 与入站帧使用同一个 1 MiB 上限；结尾 LF 不计入帧本身。
  if (bytes.byteLength - 1 > MAX_JSON_RPC_FRAME_BYTES) {
    return { accepted: false, completed: Promise.resolve(false) };
  }
  if (
    state.writes.length >= MAX_CONNECTION_WRITE_FRAMES ||
    state.queuedWriteBytes + bytes.byteLength > MAX_CONNECTION_WRITE_BYTES
  ) {
    return { accepted: false, completed: Promise.resolve(false) };
  }
  const completion = Promise.withResolvers<boolean>();
  // 先把响应转为字节并加入队尾，保持响应顺序与请求顺序一致。
  state.writes.push({ bytes, offset: 0, resolveCompleted: completion.resolve });
  state.queuedWriteBytes += bytes.byteLength;
  // 若 socket 当前可写，立即开始发送。
  flushWrites(socket);
  return { accepted: true, completed: completion.promise };
}

function rejectPendingWrites(state: ConnectionState): void {
  for (const pending of state.writes) {
    pending.resolveCompleted(false);
  }
  state.writes.length = 0;
  state.queuedWriteBytes = 0;
}

/** 将一条 UTF-8 NDJSON 帧解析为未知 JSON 值；编码或 JSON 无效时返回失败。 */
function parseFrame(
  bytes: Uint8Array,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    // decoder 先验证 UTF-8，JSON.parse 再验证 JSON 语法；两者都会在失败时抛错。
    return { ok: true, value: JSON.parse(decoder.decode(bytes)) as unknown };
  } catch {
    // 传输层不暴露解析细节，只把失败交给调用方映射为标准协议错误。
    return { ok: false };
  }
}

/**
 * 提供 loopback TCP 上的 JSON-RPC NDJSON 服务。
 * 每条连接独立排队，连接内串行处理，连接间可并发处理。
 */
export class NdjsonRpcServer {
  // 配置中已验证过的 loopback 监听地址。
  readonly #endpoint: CoreEndpoint;
  // 真正处理 RPC 方法（例如 core.ping）的函数。
  readonly #handler: RpcFrameHandler;
  // 生命周期和 socket 异常的日志出口。
  readonly #logger: Logger;
  // 当前已建立、尚未关闭的所有客户端连接。
  readonly #activeSockets = new Set<Bun.Socket<ConnectionState>>();
  // Bun.listen 成功后保存监听器；未启动或停止后为 undefined。
  #listener: Bun.TCPSocketListener | undefined;
  // stop() 期间为 true，用来拒绝新的输入。
  #stopping = false;

  /** 保存监听地址、RPC 分发函数和生命周期日志记录器。 */
  constructor(endpoint: CoreEndpoint, handler: RpcFrameHandler, logger: Logger) {
    // 保存调用者已完成校验的监听地址。
    this.#endpoint = endpoint;
    // 保存 RPC 分发策略，使 transport 不依赖具体业务方法。
    this.#handler = handler;
    // 保存日志记录器，避免 transport 直接依赖 console。
    this.#logger = logger;
  }

  /** 开始监听并注册各类 socket 回调；返回实际绑定的地址（端口为 0 时尤其有用）。 */
  start(): CoreEndpoint {
    // 同一个实例只能有一个监听器，重复启动是编程错误。
    if (this.#listener !== undefined) {
      throw new Error("server already started");
    }

    this.#listener = Bun.listen<ConnectionState>({
      // 使用配置指定的 IPv4 或 IPv6 loopback 主机。
      hostname: this.#endpoint.host,
      // port 可以为 0，此时操作系统会分配一个可用端口。
      port: this.#endpoint.port,
      // 不与其他 Bun listener 共享同一个地址与端口。
      exclusive: true,
      socket: {
        // data 回调直接获得 Uint8Array，避免字符串编码被运行时隐式处理。
        binaryType: "uint8array",
        open: (socket) => {
          // 每条新连接都分配独立的状态。
          socket.data = createConnectionState(socket);
          // 记录活动连接，供优雅关闭时遍历。
          this.#activeSockets.add(socket);
          this.#logger.debug(
            `client connected remote=${socket.remoteAddress}:${socket.remotePort}`,
          );
        },
        data: (socket, data) => {
          // 将新字节交给帧切分逻辑。
          this.#acceptData(socket, data);
        },
        drain: (socket) => {
          // 之前发生背压后，socket 再次可写，继续发送剩余响应。
          flushWrites(socket);
        },
        close: (socket) => {
          socket.data.closedState = true;
          rejectPendingWrites(socket.data);
          // 关闭后不再把该 socket 当作活动连接。
          this.#activeSockets.delete(socket);
          // 唤醒可能正在 stop() 中等待它关闭的代码。
          socket.data.resolveClosed();
          this.#logger.debug(
            `client disconnected remote=${socket.remoteAddress}:${socket.remotePort}`,
          );
        },
        error: (socket, error) => {
          // socket 错误只记录，不向其他连接传播。
          this.#logger.warn(
            `socket error remote=${socket.remoteAddress}:${socket.remotePort} message=${error.message}`,
          );
        },
      },
    });

    // listener.port 是实际端口，能正确反映 port: 0 的自动分配结果。
    return { host: this.#endpoint.host, port: this.#listener.port };
  }

  /** 停止接收新连接，等待已入队请求完成，并在宽限期结束后强制关闭残留连接。 */
  async stop(graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    // 未启动或已经停止时没有资源需要释放。
    if (this.#listener === undefined) {
      return;
    }

    this.#stopping = true;
    // false 表示停止监听新连接，但先不强制关闭已有连接。
    this.#listener.stop(false);
    // 清空引用，令之后的 start() 可重新创建监听器。
    this.#listener = undefined;

    // 复制集合，避免 socket.close 回调在遍历时修改原集合。
    const sockets = [...this.#activeSockets];
    for (const socket of sockets) {
      // 从现在起不再把新的 data 回调加入处理队列。
      socket.data.acceptingInput = false;
      // 已入队的请求仍要得到响应；处理完才半关闭连接，避免中途丢失响应。
      void socket.data.processing.finally(() => {
        socket.data.closeAfterWrites = true;
        flushWrites(socket);
      });
    }

    await new Promise<void>((resolve) => {
      // 宽限期到期时继续执行，保证 shutdown 始终有上限。
      const timeout = setTimeout(resolve, graceMs);
      // 所有连接提前关闭时取消定时器并尽早完成。
      void Promise.all(sockets.map((socket) => socket.data.closed)).then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    for (const socket of this.#activeSockets) {
      // 宽限期后仍存在的连接不再等待，强制释放其资源。
      socket.terminate();
    }
    // stop() 完成，允许实例未来再次启动。
    this.#stopping = false;
  }

  /** 接收 TCP 字节流、切分 LF 结尾的帧，并将完整帧放入该连接的处理队列。 */
  #acceptData(socket: Bun.Socket<ConnectionState>, data: Uint8Array): void {
    // 读取连接状态，之后所有变化都只影响这一连接。
    const state = socket.data;
    // 已开始关闭或已拒绝输入的连接直接丢弃后续网络字节。
    if (!state.acceptingInput || this.#stopping) {
      return;
    }

    state.input = concatenate(state.input, new Uint8Array(data));
    // TCP 是字节流而不是消息流：一次 data 回调可能包含半帧或多帧，因此按 LF 自行切帧。
    while (state.acceptingInput) {
      const newlineIndex = state.input.indexOf(0x0a);
      // 没有 LF 表示当前只有半帧，需要保留到下一次 data 回调。
      if (newlineIndex === -1) {
        // 无 LF 的半帧也不能无限增长，超过限制即拒绝。
        if (state.input.byteLength > MAX_JSON_RPC_FRAME_BYTES) {
          this.#queueOversize(state);
        }
        break;
      }

      if (newlineIndex > MAX_JSON_RPC_FRAME_BYTES) {
        this.#queueOversize(state);
        break;
      }

      state.jobs.push({ kind: "frame", bytes: state.input.slice(0, newlineIndex) });
      // 删除已入队的帧和它的 LF，继续检查缓冲中是否还有下一帧。
      state.input = state.input.slice(newlineIndex + 1);
    }
    this.#scheduleJobs(socket);
  }

  /** 记录超限帧，清空输入，并停止该连接继续接收请求。 */
  #queueOversize(state: ConnectionState): void {
    // 稍后由串行处理链发送一条 -32600 错误。
    state.jobs.push({ kind: "oversize" });
    // 不保留攻击者发送的大块数据。
    state.input = new Uint8Array();
    // 超限是此连接的协议错误，之后不再接受更多请求。
    state.acceptingInput = false;
  }

  /** 串行执行已入队帧，并把解析、分发或内部异常映射为 JSON-RPC 响应。 */
  #scheduleJobs(socket: Bun.Socket<ConnectionState>): void {
    // 取出本连接状态；不同 socket 的 processing 链彼此独立。
    const state = socket.data;
    // 把新任务接到前一个 Promise 后，保证同一连接严格按帧顺序处理；不同连接各有队列。
    state.processing = state.processing
      .then(async () => {
        // 一个 processing 任务可连续消耗当前队列中的所有帧。
        while (state.jobs.length > 0) {
          const job = state.jobs.shift();
          // 理论上不会发生；保留防御分支以满足严格类型检查。
          if (job === undefined) {
            continue;
          }
          if (job.kind === "oversize") {
            // 超限没有可靠请求 ID，因此错误响应的 id 为 null。
            enqueueMessage(
              socket,
              makeJsonRpcError(null, JsonRpcErrorCode.invalidRequest, "Request too large"),
            );
            state.closeAfterWrites = true;
            // 立即尝试发送错误，并在发送后关闭连接。
            flushWrites(socket);
            return;
          }

          const parsed = parseFrame(job.bytes);
          // 无效 UTF-8、空帧或无效 JSON 都是 JSON-RPC parse error。
          if (!parsed.ok) {
            enqueueMessage(
              socket,
              makeJsonRpcError(null, JsonRpcErrorCode.parseError, "Parse error"),
            );
            continue;
          }

          try {
            // 业务层负责校验请求、路由方法并构造成功或协议错误响应。
            const dispatched = await this.#handler(parsed.value, {
              connection: state.connection,
            });
            if (!enqueueMessage(socket, dispatched.response).accepted) {
              socket.terminate();
              return;
            }
            // 响应必须先入写队列，再允许业务层推送事件，确保客户端先拿到订阅 ID。
            if (dispatched.afterResponseEnqueued !== undefined) {
              try {
                dispatched.afterResponseEnqueued();
              } catch {
                // 此时 RPC 响应已入队，不能再发送第二条错误响应；仅记录内部错误。
                this.#logger.error("after-response action failed");
              }
            }
          } catch {
            // 不把异常栈或内部细节泄漏给客户端。
            enqueueMessage(
              socket,
              makeJsonRpcError(null, JsonRpcErrorCode.internalError, "Internal error"),
            );
          }
        }
      })
      .catch(() => {
        // 兜底处理处理链自身的意外失败，保持每条请求都有安全的协议级结果。
        enqueueMessage(
          socket,
          makeJsonRpcError(null, JsonRpcErrorCode.internalError, "Internal error"),
        );
      });
  }
}
