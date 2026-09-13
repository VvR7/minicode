import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import { AgentEventSchema, RunIdSchema, SessionIdSchema } from "@minicode/protocol";

export type EventStoreFailureCode =
  | "read_failed"
  | "write_failed"
  | "corrupt_journal"
  | "invalid_event";

export interface EventStoreFailure {
  readonly code: EventStoreFailureCode;
  readonly message: string;
}

export type EventStoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: EventStoreFailure };

export interface EventJournalStorage {
  append(path: string, content: string): Promise<void>;
  read(path: string): Promise<string | undefined>;
}

const nodeJournalStorage: EventJournalStorage = {
  async append(path, content) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // 即使目录已存在，也收紧权限，避免受进程 umask 或旧目录影响。
    await chmod(directory, 0o700);
    const file = await open(path, "a", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(content, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }
  },
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  },
};

/** 仅负责按 session/run 追加和读取已脱敏的 durable AgentEvent。 */
export class EventStore {
  readonly #homeDirectory: string;
  readonly #storage: EventJournalStorage;

  constructor(homeDirectory: string, storage: EventJournalStorage = nodeJournalStorage) {
    this.#homeDirectory = homeDirectory;
    this.#storage = storage;
  }

  pathFor(sessionId: SessionId, runId: RunId): string {
    SessionIdSchema.parse(sessionId);
    RunIdSchema.parse(runId);
    return join(this.#homeDirectory, "sessions", sessionId, "runs", runId, "events.jsonl");
  }

  async append(event: AgentEvent): Promise<EventStoreResult<void>> {
    const parsed = AgentEventSchema.safeParse(event);
    if (!parsed.success || !parsed.data.durable) {
      return {
        ok: false,
        error: { code: "invalid_event", message: "only valid durable events can be persisted" },
      };
    }
    try {
      // AgentEvent schema 不包含 goal、绝对 workspace、工具原始参数/输出或 secret。
      await this.#storage.append(
        this.pathFor(parsed.data.sessionId, parsed.data.runId),
        `${JSON.stringify(parsed.data)}\n`,
      );
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: { code: "write_failed", message: "failed to persist agent event" },
      };
    }
  }

  async read(
    sessionId: SessionId,
    runId: RunId,
    afterSequence = 0,
  ): Promise<EventStoreResult<readonly AgentEvent[]>> {
    if (
      !SessionIdSchema.safeParse(sessionId).success ||
      !RunIdSchema.safeParse(runId).success ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0
    ) {
      return {
        ok: false,
        error: { code: "invalid_event", message: "event journal identity or cursor is invalid" },
      };
    }
    let content: string | undefined;
    try {
      content = await this.#storage.read(this.pathFor(sessionId, runId));
    } catch {
      return {
        ok: false,
        error: { code: "read_failed", message: "failed to read agent event journal" },
      };
    }
    if (content === undefined || content.length === 0) {
      return { ok: true, value: [] };
    }

    const events: AgentEvent[] = [];
    let previousSequence = 0;
    for (const line of content.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        return this.#corruptJournal();
      }
      const event = AgentEventSchema.safeParse(raw);
      if (
        !event.success ||
        event.data.sessionId !== sessionId ||
        event.data.runId !== runId ||
        event.data.sequence <= previousSequence
      ) {
        return this.#corruptJournal();
      }
      previousSequence = event.data.sequence;
      if (event.data.sequence > afterSequence) {
        events.push(event.data);
      }
    }
    return { ok: true, value: events };
  }

  #corruptJournal(): EventStoreResult<never> {
    return {
      ok: false,
      error: { code: "corrupt_journal", message: "agent event journal is corrupt" },
    };
  }
}
