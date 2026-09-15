import type { RunId, SessionId } from "@minicode/protocol";
import { RunIdSchema, SessionIdSchema } from "@minicode/protocol";
import { z } from "zod";
import type { SessionStorage } from "./storage.ts";
import {
  MAX_NOTE_CHARS,
  MAX_NOTES_BYTES,
  SESSION_SCHEMA_VERSION,
  type SessionStoreResult,
} from "./types.ts";

const encoder = new TextEncoder();
const noteLocks = new WeakMap<SessionStorage, Map<string, Promise<unknown>>>();

/** notes.md 单条记录的版本化结构。 */
export const SessionNoteRecordSchema = z.strictObject({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  timestamp: z.iso.datetime({ offset: true }),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  body: z.string().min(1).max(MAX_NOTE_CHARS),
});
export type SessionNoteRecord = z.infer<typeof SessionNoteRecordSchema>;

/** 解析并校验 notes.md 的全部固定格式记录。 */
export function parseSessionNotes(content: string): SessionNoteRecord[] | undefined {
  if (content.length === 0) {
    return [];
  }
  const pattern =
    /### ([^\n]+)\nschemaVersion: ([^\n]+)\nsessionId: ([^\n]+)\nrunId: ([^\n]+)\n\n([\s\S]*?)\n\n(?=### [^\n]+\nschemaVersion:|$)/gy;
  const records: SessionNoteRecord[] = [];
  let consumed = 0;
  for (const match of content.matchAll(pattern)) {
    if (match.index !== consumed) {
      return undefined;
    }
    const parsed = SessionNoteRecordSchema.safeParse({
      timestamp: match[1],
      schemaVersion: Number(match[2]),
      sessionId: match[3],
      runId: match[4],
      body: match[5],
    });
    if (!parsed.success || parsed.data.body !== parsed.data.body.trim()) {
      return undefined;
    }
    records.push(parsed.data);
    consumed = match.index + match[0].length;
  }
  return consumed === content.length ? records : undefined;
}

/** 单条 note 追加时使用的固定身份。 */
export interface NoteIdentity {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/**
 * 负责单个 session 的 notes.md 读写。
 * 追加格式固定包含 ISO timestamp、sessionId、runId 与正文；
 * 超限或写入失败返回结构化错误，绝不截断已有 notes。
 */
export class NoteStore {
  readonly #storage: SessionStorage;
  readonly #path: string;
  readonly #identity: NoteIdentity;
  readonly #now: () => string;

  constructor(
    storage: SessionStorage,
    path: string,
    identity: NoteIdentity,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#storage = storage;
    this.#path = path;
    this.#identity = identity;
    this.#now = now;
  }

  /** 读取全部 notes 原文；下一轮 system prompt 只使用该快照。 */
  async read(): Promise<SessionStoreResult<string>> {
    try {
      const content = (await this.#storage.readFile(this.#path)) ?? "";
      const records = parseSessionNotes(content);
      if (
        encoder.encode(content).byteLength > MAX_NOTES_BYTES ||
        records === undefined ||
        records.some((record) => record.sessionId !== this.#identity.sessionId)
      ) {
        return {
          ok: false,
          error: { code: "session_corrupted", message: "session notes are corrupt" },
        };
      }
      return { ok: true, value: content };
    } catch {
      return { ok: false, error: { code: "io_error", message: "failed to read session notes" } };
    }
  }

  /** notes.md 当前字节数。 */
  async sizeBytes(): Promise<SessionStoreResult<number>> {
    const content = await this.read();
    if (!content.ok) {
      return content;
    }
    return { ok: true, value: encoder.encode(content.value).byteLength };
  }

  /** 组装单条 note 的固定文本格式。 */
  render(body: string): string {
    const timestamp = this.#now();
    return `### ${timestamp}\nschemaVersion: ${SESSION_SCHEMA_VERSION}\nsessionId: ${this.#identity.sessionId}\nrunId: ${this.#identity.runId}\n\n${body}\n\n`;
  }

  /**
   * 追加一条 note。body 先 trim，长度必须为 1..16384 字符；
   * 追加后总字节数不得超过 256 KiB，否则返回结构化错误且不写入。
   */
  async append(input: string): Promise<SessionStoreResult<void>> {
    const body = input.trim();
    if (body.length === 0) {
      return { ok: false, error: { code: "note_invalid", message: "note body must not be empty" } };
    }
    if ([...body].length > MAX_NOTE_CHARS) {
      return {
        ok: false,
        error: { code: "note_invalid", message: "note body exceeds the character limit" },
      };
    }

    return this.#withFileLock(async () => {
      const existing = await this.read();
      if (!existing.ok) {
        return existing;
      }
      const record = this.render(body);
      const nextBytes =
        encoder.encode(existing.value).byteLength + encoder.encode(record).byteLength;
      if (nextBytes > MAX_NOTES_BYTES) {
        return {
          ok: false,
          error: { code: "note_limit_exceeded", message: "session notes exceed the size limit" },
        };
      }

      try {
        await this.#storage.appendLine(this.#path, record);
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: { code: "io_error", message: "failed to write session notes" } };
      }
    });
  }

  /** 同一存储、同一路径的追加串行执行，保证总大小检查与写入不可交错。 */
  #withFileLock(
    operation: () => Promise<SessionStoreResult<void>>,
  ): Promise<SessionStoreResult<void>> {
    let locks = noteLocks.get(this.#storage);
    if (locks === undefined) {
      locks = new Map();
      noteLocks.set(this.#storage, locks);
    }
    const previous = locks.get(this.#path) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(this.#path, tail);
    void result.finally(() => {
      if (locks?.get(this.#path) === tail) {
        locks.delete(this.#path);
      }
    });
    return result;
  }
}
