import { formatEndpoint, MINICODE_VERSION } from "@minicode/protocol";

import type { CoreEndpoint } from "@minicode/protocol";
import type { CoreConfig } from "./config.ts";
import { PingHandler } from "./handlers/ping-handler.ts";
import { createLogger } from "./logger.ts";
import { createRpcDispatcher } from "./rpc-dispatcher.ts";
import { NdjsonRpcServer } from "./transport/ndjson-server.ts";

export class CoreApp {
  readonly #config: CoreConfig;
  readonly #logger;
  #server: NdjsonRpcServer | undefined;
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
    const dispatcher = createRpcDispatcher({
      handlers: [new PingHandler({ uptimeMs: () => performance.now() - this.#startedAt })],
    });
    this.#server = new NdjsonRpcServer(this.#config, dispatcher, this.#logger);
    const endpoint = this.#server.start();
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
  }
}
