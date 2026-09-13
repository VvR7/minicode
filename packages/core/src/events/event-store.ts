import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import { AgentEventSchema, RunIdSchema, SessionIdSchema } from "@minicode/protocol";
import { z } from "zod";

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
  append(path: string, content: string, directories: readonly string[]): Promise<void>;
  read(path: string): Promise<string | undefined>;
}

export interface EventJournalSnapshot {
  readonly events: readonly AgentEvent[];
  readonly latestSequence: number;
  readonly finished: boolean;
}

const SequenceWatermarkSchema = z
  .object({
    kind: z.literal("sequence.watermark"),
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    sequence: z.number().int().positive(),
  })
  .strict();

type SequenceWatermark = z.infer<typeof SequenceWatermarkSchema>;

const nodeJournalStorage: EventJournalStorage = {
  async append(path, content, directories) {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // 即使父目录已存在，也逐级收紧权限，避免旧权限泄露 journal 元数据。
      await chmod(directory, 0o700);
    }
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

/** 按 session/run 保存 durable 事件和不含事件内容的 sequence 水位。 */
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
      await this.#appendRecord(parsed.data.sessionId, parsed.data.runId, parsed.data);
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: { code: "write_failed", message: "failed to persist agent event" },
      };
    }
  }

  async appendWatermark(
    sessionId: SessionId,
    runId: RunId,
    sequence: number,
  ): Promise<EventStoreResult<void>> {
    const parsed = SequenceWatermarkSchema.safeParse({
      kind: "sequence.watermark",
      sessionId,
      runId,
      sequence,
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "invalid_event", message: "event sequence watermark is invalid" },
      };
    }
    try {
      // watermark 只记录连续序号和隔离标识，不写入 transient payload。
      await this.#appendRecord(sessionId, runId, parsed.data);
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: { code: "write_failed", message: "failed to persist event sequence watermark" },
      };
    }
  }

  async read(
    sessionId: SessionId,
    runId: RunId,
    afterSequence = 0,
  ): Promise<EventStoreResult<EventJournalSnapshot>> {
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
      return { ok: true, value: { events: [], latestSequence: 0, finished: false } };
    }

    const events: AgentEvent[] = [];
    let previousSequence = 0;
    let finished = false;
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
      const watermark = SequenceWatermarkSchema.safeParse(raw);
      const record: AgentEvent | SequenceWatermark | undefined = event.success
        ? event.data
        : watermark.success
          ? watermark.data
          : undefined;
      if (
        record === undefined ||
        record.sessionId !== sessionId ||
        record.runId !== runId ||
        record.sequence !== previousSequence + 1
      ) {
        return this.#corruptJournal();
      }
      previousSequence = record.sequence;
      if (event.success && event.data.sequence > afterSequence) {
        events.push(event.data);
      }
      if (event.success && event.data.type === "run.finished") {
        finished = true;
      }
    }
    return { ok: true, value: { events, latestSequence: previousSequence, finished } };
  }

  async #appendRecord(
    sessionId: SessionId,
    runId: RunId,
    record: AgentEvent | SequenceWatermark,
  ): Promise<void> {
    const sessions = join(this.#homeDirectory, "sessions");
    const session = join(sessions, sessionId);
    const runs = join(session, "runs");
    const run = join(runs, runId);
    await this.#storage.append(join(run, "events.jsonl"), `${JSON.stringify(record)}\n`, [
      sessions,
      session,
      runs,
      run,
    ]);
  }

  #corruptJournal(): EventStoreResult<never> {
    return {
      ok: false,
      error: { code: "corrupt_journal", message: "agent event journal is corrupt" },
    };
  }
}
