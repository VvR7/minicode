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

export class CoreApp {
  readonly #config: CoreConfig;
  readonly #environment: Environment;
  readonly #logger;
  #server: NdjsonRpcServer | undefined;
  #eventBus: EventBus | undefined;
  #broadcaster: IpcEventBroadcaster | undefined;
  #manager: RunManager | undefined;
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
    const eventBus = new EventBus(eventStore);
    const broadcaster = new IpcEventBroadcaster(eventBus);
    const manager = new RunManager(
      new AgentRunner({ environment: this.#environment, bus: eventBus }),
    );
    const dispatcher = createRpcDispatcher({
      handlers: [
        new PingHandler({ uptimeMs: () => performance.now() - this.#startedAt }),
        new EventSubscribeHandler(broadcaster),
        new EventUnsubscribeHandler(broadcaster),
        new AgentRunHandler({ manager, broadcaster }),
        new AgentCancelHandler(manager),
      ],
    });
    const server = new NdjsonRpcServer(this.#config, dispatcher, this.#logger);
    const endpoint = server.start();
    this.#server = server;
    this.#eventBus = eventBus;
    this.#broadcaster = broadcaster;
    this.#manager = manager;

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
    this.#server = undefined;

    // 先取消 active runs，让它们发布 run.finished(cancelled) 后再优雅关闭连接。
    await manager?.shutdown();
    await server.stop();

    this.#broadcaster?.close();
    this.#broadcaster = undefined;
    this.#eventBus = undefined;
    this.#manager = undefined;
  }

  get eventBus(): EventBus {
    if (this.#eventBus === undefined) {
      throw new Error("core is not started");
    }
    return this.#eventBus;
  }
}
