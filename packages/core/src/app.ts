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
import {
  SessionCreateHandler,
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
  #startedAt = 0;

  constructor(config: CoreConfig, environment: Environment = Bun.env) {
    this.#config = config;
    this.#environment = environment;
    this.#logger = createLogger(config.logLevel);
  }

  start(): CoreEndpoint {
    if (this.#server !== undefined) {
      throw new Error("core already started");
    }

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
    const runner = new AgentRunner({
      environment: this.#environment,
      bus: eventBus,
      homeDirectory: this.#config.homeDirectory,
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
        new PingHandler({ uptimeMs: () => performance.now() - this.#startedAt }),
        new EventSubscribeHandler(broadcaster),
        new EventUnsubscribeHandler(broadcaster, sessionBroadcaster),
        new AgentRunHandler({ manager, broadcaster }),
        new AgentCancelHandler(manager),
        new SessionCreateHandler(manager),
        new SessionGetHandler(manager),
        new SessionListHandler(manager),
        new SessionGetHistoryHandler(manager),
        new SessionSendMessageHandler(manager),
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

    this.#logger.info(`mc-core ${MINICODE_VERSION} listening address=${formatEndpoint(endpoint)}`);
    return endpoint;
  }

  async stop(): Promise<void> {
    if (this.#server === undefined) {
      return;
    }
    this.#logger.info("mc-core shutting down");
    const server = this.#server;
    const manager = this.#manager;
    this.#server = undefined;

    // 先取消 active runs，让它们发布 run.finished(cancelled) 后再优雅关闭连接。
    await manager?.shutdown();
    await server.stop();

    this.#broadcaster?.close();
    this.#sessionBroadcaster?.close();
    this.#broadcaster = undefined;
    this.#sessionBroadcaster = undefined;
    this.#eventBus = undefined;
    this.#manager = undefined;
    await this.#traces?.stopAll();
    this.#traces = undefined;
  }

  get eventBus(): EventBus {
    if (this.#eventBus === undefined) {
      throw new Error("core is not started");
    }
    return this.#eventBus;
  }
}
