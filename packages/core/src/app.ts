import type { CoreEndpoint } from "@minicode/protocol";
import { formatEndpoint, MINICODE_VERSION } from "@minicode/protocol";
import type { CoreConfig } from "./config.ts";
import { EventBus } from "./events/event-bus.ts";
import { EventStore } from "./events/event-store.ts";
import { IpcEventBroadcaster } from "./events/ipc-event-broadcaster.ts";
import {
  EventSubscribeHandler,
  EventUnsubscribeHandler,
} from "./handlers/event-subscription-handlers.ts";
import { PingHandler } from "./handlers/ping-handler.ts";
import { createLogger } from "./logger.ts";
import { createRpcDispatcher } from "./rpc-dispatcher.ts";
import { NdjsonRpcServer } from "./transport/ndjson-server.ts";

export class CoreApp {
  readonly #config: CoreConfig;
  readonly #logger;
  #server: NdjsonRpcServer | undefined;
  #eventBus: EventBus | undefined;
  #broadcaster: IpcEventBroadcaster | undefined;
  #startedAt = 0;

  constructor(config: CoreConfig) {
    this.#config = config;
    this.#logger = createLogger(config.logLevel);
  }

  start(): CoreEndpoint {
    if (this.#server !== undefined) {
      throw new Error("core already started");
    }

    this.#startedAt = performance.now();
    const eventBus = new EventBus(new EventStore(this.#config.homeDirectory));
    const broadcaster = new IpcEventBroadcaster(eventBus);
    const dispatcher = createRpcDispatcher({
      handlers: [
        new PingHandler({ uptimeMs: () => performance.now() - this.#startedAt }),
        new EventSubscribeHandler(broadcaster),
        new EventUnsubscribeHandler(broadcaster),
      ],
    });
    const server = new NdjsonRpcServer(this.#config, dispatcher, this.#logger);
    const endpoint = server.start();
    this.#server = server;
    this.#eventBus = eventBus;
    this.#broadcaster = broadcaster;
    this.#logger.info(`mc-core ${MINICODE_VERSION} listening address=${formatEndpoint(endpoint)}`);
    return endpoint;
  }

  async stop(): Promise<void> {
    if (this.#server === undefined) {
      return;
    }
    this.#logger.info("mc-core shutting down");
    const server = this.#server;
    this.#server = undefined;
    await server.stop();
    this.#broadcaster?.close();
    this.#broadcaster = undefined;
    this.#eventBus = undefined;
  }

  get eventBus(): EventBus {
    if (this.#eventBus === undefined) {
      throw new Error("core is not started");
    }
    return this.#eventBus;
  }
}
