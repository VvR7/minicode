import type { CoreEndpoint, Environment } from "@minicode/protocol";
import { formatEndpoint, MINICODE_VERSION } from "@minicode/protocol";
import type { CoreConfig } from "./config.ts";
import { EventBus } from "./events/event-bus.ts";
import { EventStore } from "./events/event-store.ts";
import { IpcEventBroadcaster } from "./events/ipc-event-broadcaster.ts";
import { AgentCancelHandler } from "./handlers/agent-cancel-handler.ts";
import { AgentRunHandler } from "./handlers/agent-run-handler.ts";
import {
  EventSubscribeHandler,
  EventUnsubscribeHandler,
} from "./handlers/event-subscription-handlers.ts";
import { PingHandler } from "./handlers/ping-handler.ts";
import { createLogger } from "./logger.ts";
import { createRpcDispatcher } from "./rpc-dispatcher.ts";
import { RunManager } from "./run/manager.ts";
import { markIncompleteRunsRestarted } from "./run/restart.ts";
import { AgentRunner } from "./run/runner.ts";
import { NdjsonRpcServer } from "./transport/ndjson-server.ts";
import {
  TRACE_MAX_BYTES_DEFAULT,
  TRACE_QUEUE_EVENTS_DEFAULT,
  TRACE_SHUTDOWN_MS_DEFAULT,
  TraceService,
  loadTraceConfig,
} from "./trace/index.ts";

export class CoreApp {
  readonly #config: CoreConfig;
  readonly #environment: Environment;
  readonly #logger;
  #server: NdjsonRpcServer | undefined;
  #eventBus: EventBus | undefined;
  #broadcaster: IpcEventBroadcaster | undefined;
  #manager: RunManager | undefined;
  #traceService: TraceService | undefined;
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
    const traceConfig = loadTraceConfig(this.#environment);
    if (!traceConfig.ok) {
      this.#logger.warn(`trace disabled: ${traceConfig.message}`);
    }
    const traceService = new TraceService(
      this.#config.homeDirectory,
      traceConfig.ok
        ? traceConfig.value
        : {
            enabled: false,
            payload: "summary",
            queueEvents: TRACE_QUEUE_EVENTS_DEFAULT,
            maxBytes: TRACE_MAX_BYTES_DEFAULT,
            shutdownMs: TRACE_SHUTDOWN_MS_DEFAULT,
          },
      undefined,
      ({ sessionId, runId, report }) => {
        this.#logger.warn(
          `trace incomplete session=${sessionId} run=${runId} pending=${report.pendingRecords} dropped=${report.droppedRecords} timedOut=${report.timedOut} writeFailed=${report.writeFailed}`,
        );
      },
    );
    const eventStore = new EventStore(this.#config.homeDirectory);
    const eventBus = new EventBus(eventStore, {
      onPersisted: (event) => traceService.recordEvent(event),
    });
    const broadcaster = new IpcEventBroadcaster(eventBus);
    const manager = new RunManager(
      new AgentRunner({ environment: this.#environment, bus: eventBus, traceService }),
    );
    const dispatcher = createRpcDispatcher({
      handlers: [
        new PingHandler({ uptimeMs: () => performance.now() - this.#startedAt }),
        new EventSubscribeHandler(broadcaster),
        new EventUnsubscribeHandler(broadcaster),
        new AgentRunHandler({ manager, broadcaster, traceService }),
        new AgentCancelHandler(manager),
      ],
    });
    const server = new NdjsonRpcServer(this.#config, dispatcher, this.#logger);
    const endpoint = server.start();
    this.#server = server;
    this.#eventBus = eventBus;
    this.#broadcaster = broadcaster;
    this.#manager = manager;
    this.#traceService = traceService;

    // startup 把未完成 journal 补记为 core_restarted；异步执行，不阻塞监听。
    void markIncompleteRunsRestarted(eventBus, eventStore, this.#config.homeDirectory).catch(
      (error: unknown) => {
        this.#logger.warn(`mark incomplete runs failed: ${String(error)}`);
      },
    );

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
    const traceService = this.#traceService;
    this.#server = undefined;

    // 先取消 active runs，让它们发布 run.finished(cancelled) 后再优雅关闭连接。
    await manager?.shutdown();
    await server.stop();
    await traceService?.shutdown();

    this.#broadcaster?.close();
    this.#broadcaster = undefined;
    this.#eventBus = undefined;
    this.#manager = undefined;
    this.#traceService = undefined;
  }

  get eventBus(): EventBus {
    if (this.#eventBus === undefined) {
      throw new Error("core is not started");
    }
    return this.#eventBus;
  }
}
