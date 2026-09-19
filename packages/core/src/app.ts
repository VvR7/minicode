import { SkillListHandler } from "./handlers/skill-list-handler.ts";
import { McpServerManager } from "./mcp/server-manager.ts";
import type { CoreEndpoint, Environment } from "@minicode/protocol";
import { formatEndpoint, MINICODE_VERSION } from "@minicode/protocol";
import type { CoreConfig } from "./config.ts";
import { EventBus } from "./events/event-bus.ts";
import { EventStore } from "./events/event-store.ts";
import { IpcEventBroadcaster } from "./events/ipc-event-broadcaster.ts";
import { IpcSessionBroadcaster } from "./events/ipc-session-broadcaster.ts";
import { SessionEventBus } from "./events/session-event-bus.ts";
import { AgentCancelHandler } from "./handlers/agent-cancel-handler.ts";
import { AgentRunHandler } from "./handlers/agent-run-handler.ts";
import {
  EventSubscribeHandler,
  EventUnsubscribeHandler,
} from "./handlers/event-subscription-handlers.ts";
import { PingHandler } from "./handlers/ping-handler.ts";
import { PermissionRespondHandler } from "./handlers/permission-respond-handler.ts";
import { PermissionManager } from "./permissions/manager.ts";
import {
  SessionCreateHandler,
  SessionCompactHandler,
  SessionGetHandler,
  SessionGetHistoryHandler,
  SessionListHandler,
  SessionSendMessageHandler,
  SessionSubscribeHandler,
} from "./handlers/session-handlers.ts";
import { createLogger } from "./logger.ts";
import { createRpcDispatcher } from "./rpc-dispatcher.ts";
import { RunMetadataStore } from "./run/metadata.ts";
import { AgentRunner } from "./run/runner.ts";
import { SessionManager } from "./session/manager.ts";
import { SessionStore } from "./session/session-store.ts";
import { RunTraceRegistry } from "./trace/registry.ts";
import { NdjsonRpcServer } from "./transport/ndjson-server.ts";

export class CoreApp {
  readonly #config: CoreConfig;
  readonly #environment: Environment;
  readonly #logger;
  #server: NdjsonRpcServer | undefined;
  #eventBus: EventBus | undefined;
  #broadcaster: IpcEventBroadcaster | undefined;
  #sessionBroadcaster: IpcSessionBroadcaster | undefined;
  #manager: SessionManager | undefined;
  #traces: RunTraceRegistry | undefined;
  #permissions: PermissionManager | undefined;
  #mcp: McpServerManager | undefined;
  #startedAt = 0;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;

  /** 保存 Core 配置、环境与日志依赖。 */
  constructor(config: CoreConfig, environment: Environment = Bun.env) {
    this.#config = config;
    this.#environment = environment;
    this.#logger = createLogger(config.logLevel);
  }

  /** 组装 Session/Run/Trace/IPC 服务并开始监听。 */
  start(): CoreEndpoint {
    if (this.#server !== undefined || this.#stopping) {
      throw new Error("core already started");
    }

    this.#mcp = new McpServerManager(this.#config.homeDirectory, this.#environment);
    this.#startedAt = performance.now();
    const eventStore = new EventStore(this.#config.homeDirectory);
    const traces = new RunTraceRegistry(this.#config.homeDirectory, this.#environment);
    const eventBus = new EventBus(eventStore, {
      onPersisted: (event) => traces.recordAgentEvent(event),
    });
    const sessionStore = new SessionStore(this.#config.homeDirectory);
    const sessionEvents = new SessionEventBus(sessionStore, {
      onPersisted: (event) => traces.recordSessionEvent(event),
    });
    const broadcaster = new IpcEventBroadcaster(eventBus, traces);
    const sessionBroadcaster = new IpcSessionBroadcaster(sessionEvents, traces);
    const permissions = new PermissionManager(eventBus);
    const runner = new AgentRunner({
      environment: this.#environment,
      bus: eventBus,
      homeDirectory: this.#config.homeDirectory,
      permissions,
      permissionMode: this.#config.permissionMode ?? "bypasspermission",
      mcp: this.#mcp,
    });
    const manager = new SessionManager({
      store: sessionStore,
      runner,
      eventBus,
      eventStore,
      sessionEvents,
      metadata: new RunMetadataStore(this.#config.homeDirectory),
      traces,
      environment: this.#environment,
    });
    const dispatcher = createRpcDispatcher({
      handlers: [
        new SkillListHandler(this.#config.homeDirectory),
        new PingHandler({ uptimeMs: () => performance.now() - this.#startedAt }),
        new PermissionRespondHandler(
          permissions,
          (context, params) =>
            broadcaster.isAttached(context.connection, params.sessionId, params.runId) ||
            sessionBroadcaster.isAttached(context.connection, params.sessionId),
        ),
        new EventSubscribeHandler(broadcaster),
        new EventUnsubscribeHandler(broadcaster, sessionBroadcaster),
        new AgentRunHandler({ manager, broadcaster }),
        new AgentCancelHandler(manager),
        new SessionCreateHandler(manager),
        new SessionGetHandler(manager),
        new SessionListHandler(manager),
        new SessionGetHistoryHandler(manager),
        new SessionSendMessageHandler(manager),
        new SessionCompactHandler(manager),
        new SessionSubscribeHandler(manager, sessionBroadcaster),
      ],
    });
    const server = new NdjsonRpcServer(this.#config, dispatcher, this.#logger);
    const endpoint = server.start();
    this.#server = server;
    this.#eventBus = eventBus;
    this.#broadcaster = broadcaster;
    this.#sessionBroadcaster = sessionBroadcaster;
    this.#manager = manager;
    this.#traces = traces;
    this.#permissions = permissions;

    this.#logger.info(`mc-core ${MINICODE_VERSION} listening address=${formatEndpoint(endpoint)}`);
    return endpoint;
  }

  /** 幂等停止 Core；并发调用共享同一个完成 Promise。 */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    if (this.#server === undefined) {
      return Promise.resolve();
    }
    const stopping = this.#stopCurrent(this.#server, this.#manager);
    this.#stopPromise = stopping;
    void stopping.then(
      () => {
        if (this.#stopPromise === stopping) this.#stopPromise = undefined;
      },
      () => {
        if (this.#stopPromise === stopping) this.#stopPromise = undefined;
      },
    );
    return stopping;
  }

  /** 执行一次完整停机；所有并发 stop 调用共享外层登记的同一个 Promise。 */
  async #stopCurrent(server: NdjsonRpcServer, manager: SessionManager | undefined): Promise<void> {
    this.#logger.info("mc-core shutting down");
    this.#stopping = true;
    this.#server = undefined;
    try {
      // 先封闭 admission/发出取消，再排空 RPC 响应闸门，最后才允许强制终态提交。
      manager?.beginShutdown();
      this.#permissions?.close();
      await server.stop();
      await manager?.shutdown();
      await this.#mcp?.close();
      this.#mcp = undefined;

      this.#broadcaster?.close();
      this.#sessionBroadcaster?.close();
      this.#broadcaster = undefined;
      this.#sessionBroadcaster = undefined;
      this.#eventBus = undefined;
      this.#manager = undefined;
      this.#permissions = undefined;
      await this.#traces?.stopAll();
      this.#traces = undefined;
    } finally {
      this.#stopping = false;
    }
  }

  /** 返回运行中的 run EventBus；未启动时拒绝访问。 */
  get eventBus(): EventBus {
    if (this.#eventBus === undefined) {
      throw new Error("core is not started");
    }
    return this.#eventBus;
  }
}
