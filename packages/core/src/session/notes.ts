import type { RunId, SessionId } from "@minicode/protocol";
import type { SessionStorage } from "./storage.ts";
import { MAX_NOTE_CHARS, MAX_NOTES_BYTES, type SessionStoreResult } from "./types.ts";

const encoder = new TextEncoder();

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
      return { ok: true, value: (await this.#storage.readFile(this.#path)) ?? "" };
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
    return `### ${timestamp}\nsessionId: ${this.#identity.sessionId}\nrunId: ${this.#identity.runId}\n\n${body}\n\n`;
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

    const existing = await this.read();
    if (!existing.ok) {
      return existing;
    }
    const record = this.render(body);
    const nextBytes = encoder.encode(existing.value).byteLength + encoder.encode(record).byteLength;
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
  }
}
