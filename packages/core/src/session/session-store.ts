import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ActiveRun,
  HistoryTurn,
  RunId,
  SessionEvent,
  SessionId,
  SessionSummary,
} from "@minicode/protocol";
import { SessionIdSchema, SessionSummarySchema } from "@minicode/protocol";
import { z } from "zod";
import type { LlmContentPart, LlmMessage } from "../llm/types.ts";
import { NoteStore, parseSessionNotes } from "./notes.ts";
import type { SessionStorage } from "./storage.ts";
import { nodeSessionStorage } from "./storage.ts";
import {
  HistoryRecordSchema,
  SESSION_SCHEMA_VERSION,
  SessionEventRecordSchema,
  SessionMetaSchema,
  TurnAcceptedRecordSchema,
  TurnCompletedRecordSchema,
  type AcceptedTurn,
  type AcceptTurnInput,
  type CompleteTurnInput,
  type CreateSessionOptions,
  type HistoryRecord,
  type PendingInterruption,
  type SessionListOptions,
  type SessionListPage,
  type SessionMeta,
  type SessionSnapshot,
  type SessionStoreResult,
} from "./types.ts";

/** 默认分页大小，与协议层 session.list 默认值一致。 */
export const DEFAULT_SESSION_PAGE_SIZE = 50;
/** 分页大小上限。 */
export const MAX_SESSION_PAGE_SIZE = 100;
/** 新 session 的初始标题；接受首条用户消息后由首行替换。 */
export const NEW_SESSION_TITLE = "New session";
/** 自动标题的最大 Unicode code point 数。 */
export const MAX_TITLE_CODE_POINTS = 80;

const SessionCursorSchema = z.strictObject({
  updatedAt: z.iso.datetime({ offset: true }),
  sessionId: SessionIdSchema,
});

type SessionCursor = z.infer<typeof SessionCursorSchema>;

interface SessionPaths {
  readonly directory: string;
  readonly meta: string;
  readonly history: string;
  readonly notes: string;
  readonly sessionEvents: string;
  readonly runs: string;
}

interface LoadedSession {
  readonly meta: SessionMeta;
  readonly snapshot?: SessionSnapshot;
}

/** 解析结果：合法记录列表，或带原因的损坏标记。 */
type ParsedLines<Record> =
  | { readonly ok: true; readonly records: readonly Record[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 逐行解析 JSONL。中间坏行、身份不匹配与“缺少换行的最后一行”都按损坏处理，
 * 不做静默截断，也不改写原文件。
 */
function parseJsonLines<Record>(
  content: string | undefined,
  parse: (value: unknown) => Record | undefined,
): ParsedLines<Record> {
  if (content === undefined || content.length === 0) {
    return { ok: true, records: [] };
  }
  const lines = content.split("\n");
  // 合法 JSONL 以换行结束；最后一段必为空串，否则视为不完整尾行。
  if (lines[lines.length - 1] !== "") {
    return { ok: false, reason: "incomplete final line" };
  }
  lines.pop();
  const records: Record[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      return { ok: false, reason: "blank record line" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return { ok: false, reason: "unparseable record line" };
    }
    const parsed = parse(raw);
    if (parsed === undefined) {
      return { ok: false, reason: "record does not match schema" };
    }
    records.push(parsed);
  }
  return { ok: true, records };
}

/** 从用户消息推导标题：取第一条非空行，trim 后最多 80 个 code point。 */
export function deriveTitle(userMessage: string): string {
  const line = userMessage
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) {
    return NEW_SESSION_TITLE;
  }
  return [...line].slice(0, MAX_TITLE_CODE_POINTS).join("");
}

/** 取两个 ISO 时间戳中较晚的一个。 */
function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/** 校验 tool_use 与 tool_result 是否按 ID 完整配对（含尾部未配对检测）。 */
function hasCompleteToolPairing(messages: readonly HistoryTurn["messages"][number][]): boolean {
  const pending = new Set<string>();
  const seenToolUses = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        if (seenToolUses.has(block.id)) {
          return false;
        }
        seenToolUses.add(block.id);
        pending.add(block.id);
      } else if (block.type === "tool_result" && !pending.delete(block.toolUseId)) {
        return false;
      }
    }
  }
  return pending.size === 0;
}

/** 读取一个 history turn 的原始用户消息文本。 */
function userMessageOf(turn: HistoryTurn): string | undefined {
  for (const message of turn.messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        return block.text;
      }
    }
  }
  return undefined;
}

/** 把 provider-neutral 历史块映射为下一轮 LLM 可消费的内容块。 */
function toLlmPart(block: HistoryTurn["messages"][number]["content"][number]): LlmContentPart {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content,
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      };
  }
}

/** 把全部 includedInContext=true 的历史 turn 映射为下一轮 LLM 上下文消息。 */
export function buildContextMessages(turns: readonly HistoryTurn[]): readonly LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const turn of turns) {
    // protocol 的 HistoryTurnSchema 已保证 includedInContext 只出现在 succeeded 且配对完整的 turn 上。
    if (!turn.includedInContext) {
      continue;
    }
    for (const message of turn.messages) {
      messages.push({ role: message.role, content: message.content.map(toLlmPart) });
    }
  }
  return messages;
}

/**
 * session 的权威持久化与恢复层。
 * 只负责磁盘格式、崩溃恢复、上下文选择与分页；不实现 RPC handler 或多轮编排。
 */
export class SessionStore {
  readonly #homeDirectory: string;
  readonly #storage: SessionStorage;
  readonly #now: () => string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    homeDirectory: string,
    storage: SessionStorage = nodeSessionStorage,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#homeDirectory = homeDirectory;
    this.#storage = storage;
    this.#now = now;
  }

  /** 计算单个 session 的全部固定路径；sessionId 必须是合法 UUID。 */
  #paths(sessionId: SessionId): SessionPaths {
    const directory = join(this.#homeDirectory, "sessions", sessionId);
    return {
      directory,
      meta: join(directory, "meta.json"),
      history: join(directory, "history.jsonl"),
      notes: join(directory, "notes.md"),
      sessionEvents: join(directory, "session-events.jsonl"),
      runs: join(directory, "runs"),
    };
  }

  /** 为指定 session/run 构造 NoteStore，供后续 note_save 工具使用。 */
  createNoteStore(sessionId: SessionId, runId: RunId): NoteStore {
    SessionIdSchema.parse(sessionId);
    return new NoteStore(
      this.#storage,
      this.#paths(sessionId).notes,
      { sessionId, runId },
      this.#now,
    );
  }

  /** 规范化 workspaceRoot：先绝对化，再尽量 realpath，失败时退回绝对路径。 */
  async #normalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
    const absolute = isAbsolute(workspaceRoot) ? workspaceRoot : resolve(workspaceRoot);
    try {
      return await realpath(absolute);
    } catch {
      return absolute;
    }
  }

  /** 创建新的 chat/one_shot session 目录与空 journal。 */
  async create(options: CreateSessionOptions): Promise<SessionStoreResult<SessionSnapshot>> {
    const workspaceRoot = await this.#normalizeWorkspaceRoot(options.workspaceRoot);
    const sessionId = crypto.randomUUID() as SessionId;
    const timestamp = this.#now();
    const meta: SessionMeta = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId,
      mode: options.mode,
      workspaceRoot,
      title: NEW_SESSION_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const paths = this.#paths(sessionId);
    try {
      await this.#storage.ensureDirectory(paths.directory);
      await this.#storage.ensureDirectory(paths.runs);
      // 预先建立空文件，确保权限为 0600，且加载逻辑无需区分“缺失文件”。
      await this.#storage.writeFileAtomic(paths.history, "");
      await this.#storage.writeFileAtomic(paths.sessionEvents, "");
      await this.#storage.writeFileAtomic(paths.notes, "");
      await this.#storage.writeFileAtomic(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
    } catch {
      return { ok: false, error: { code: "io_error", message: "failed to create session" } };
    }
    return {
      ok: true,
      value: {
        meta,
        status: "idle",
        latestSessionSequence: 0,
        updatedAt: timestamp,
        turns: [],
        pendingInterruptions: [],
        sessionEvents: [],
        notes: "",
      },
    };
  }

  /** 读取并校验一个 session；损坏时返回 session_corrupted。 */
  async load(sessionId: SessionId): Promise<SessionStoreResult<SessionSnapshot>> {
    const loaded = await this.#readSession(sessionId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value.snapshot === undefined) {
      return {
        ok: false,
        error: { code: "session_corrupted", message: "session state is corrupt" },
      };
    }
    return { ok: true, value: loaded.value.snapshot };
  }

  /** 按 workspaceRoot 过滤、updatedAt 降序 / sessionId 升序分页列出 session。 */
  async list(options: SessionListOptions = {}): Promise<SessionStoreResult<SessionListPage>> {
    let cursor: SessionCursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = this.#decodeCursor(options.cursor);
      if (decoded === undefined) {
        return { ok: false, error: { code: "invalid_cursor", message: "list cursor is invalid" } };
      }
      cursor = decoded;
    }

    const workspaceFilter =
      options.workspaceRoot === undefined
        ? undefined
        : await this.#normalizeWorkspaceRoot(options.workspaceRoot);

    const sessionsDirectory = join(this.#homeDirectory, "sessions");
    let names: string[];
    try {
      names = await this.#storage.listDirectories(sessionsDirectory);
    } catch {
      return { ok: false, error: { code: "io_error", message: "failed to list sessions" } };
    }

    const summaries: SessionSummary[] = [];
    for (const name of names) {
      if (!SessionIdSchema.safeParse(name).success) {
        // 非 UUID 目录不是本 store 的 session；单个失败不影响其他 session。
        continue;
      }
      const loaded = await this.#readSession(name as SessionId);
      if (!loaded.ok) {
        continue;
      }
      const summary = this.#summarize(loaded.value);
      if (summary === undefined) {
        continue;
      }
      if (summary.mode === "one_shot" && options.includeOneShot !== true) {
        continue;
      }
      if (workspaceFilter !== undefined && summary.workspaceRoot !== workspaceFilter) {
        continue;
      }
      summaries.push(summary);
    }

    summaries.sort((left, right) => {
      const timestampOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (timestampOrder !== 0) {
        return timestampOrder;
      }
      return left.sessionId < right.sessionId ? -1 : 1;
    });

    const limit = Math.min(
      Math.max(1, options.limit ?? DEFAULT_SESSION_PAGE_SIZE),
      MAX_SESSION_PAGE_SIZE,
    );
    const startIndex =
      cursor === undefined
        ? 0
        : summaries.findIndex(
            (summary) =>
              Date.parse(summary.updatedAt) < Date.parse(cursor.updatedAt) ||
              (Date.parse(summary.updatedAt) === Date.parse(cursor.updatedAt) &&
                summary.sessionId > cursor.sessionId),
          );
    const effectiveStart = startIndex === -1 ? summaries.length : startIndex;
    const page = summaries.slice(effectiveStart, effectiveStart + limit);
    const last = page[page.length - 1];
    if (effectiveStart + limit < summaries.length && last !== undefined) {
      return { ok: true, value: { sessions: page, nextCursor: this.#encodeCursor(last) } };
    }
    return { ok: true, value: { sessions: page } };
  }

  /**
   * 追加 turn.accepted。clientMessageId 在同一 session 内幂等：
   * 相同内容的重试返回原始 turnId/runId，不同内容返回 idempotency_conflict。
   */
  async appendAccepted(
    sessionId: SessionId,
    input: AcceptTurnInput,
  ): Promise<SessionStoreResult<AcceptedTurn>> {
    return this.#withSessionLock<AcceptedTurn>(
      sessionId,
      async (): Promise<SessionStoreResult<AcceptedTurn>> => {
        const loaded = await this.#readSession(sessionId);
        if (!loaded.ok) {
          return loaded;
        }
        if (loaded.value.snapshot === undefined) {
          return this.#corruptSnapshot();
        }
        const snapshot = loaded.value.snapshot;

        const existing = snapshot.turns.find(
          (turn) => turn.clientMessageId === input.clientMessageId,
        );
        if (existing !== undefined) {
          if (userMessageOf(existing) === input.userMessage) {
            return {
              ok: true,
              value: {
                turnId: existing.turnId,
                runId: existing.runId,
                acceptedAt: existing.acceptedAt,
                idempotent: true,
              },
            };
          }
          return {
            ok: false,
            error: {
              code: "idempotency_conflict",
              message: "clientMessageId was already used with different content",
            },
          };
        }

        if (snapshot.turns.some((turn) => turn.turnId === input.turnId)) {
          return {
            ok: false,
            error: { code: "duplicate_turn", message: "turn identity already exists" },
          };
        }

        const timestamp = this.#now();
        const record = TurnAcceptedRecordSchema.safeParse({
          schemaVersion: SESSION_SCHEMA_VERSION,
          recordId: crypto.randomUUID(),
          sessionId,
          turnId: input.turnId,
          runId: input.runId,
          timestamp,
          kind: "turn.accepted",
          clientMessageId: input.clientMessageId,
          userMessage: input.userMessage,
        });
        if (!record.success) {
          return { ok: false, error: { code: "invalid_input", message: "turn input is invalid" } };
        }
        try {
          await this.#storage.appendLine(
            this.#paths(sessionId).history,
            `${JSON.stringify(record.data)}\n`,
          );
        } catch {
          return { ok: false, error: { code: "io_error", message: "failed to persist turn" } };
        }

        const nextTitle =
          snapshot.meta.title === NEW_SESSION_TITLE
            ? deriveTitle(input.userMessage)
            : snapshot.meta.title;
        // meta 只是可重建的缓存；写入失败不改变已落盘 journal 的接受结果。
        await this.#writeMeta(sessionId, {
          ...snapshot.meta,
          title: nextTitle,
          updatedAt: latestTimestamp(snapshot.meta.updatedAt, timestamp),
        });
        return {
          ok: true,
          value: {
            turnId: input.turnId,
            runId: input.runId,
            acceptedAt: timestamp,
            idempotent: false,
          },
        };
      },
    );
  }

  /**
   * 追加 turn.completed。includedInContext 由 status 决定：
   * 只有 succeeded 为 true，failed/cancelled/interrupted 一律 false。
   */
  async appendCompleted(
    sessionId: SessionId,
    input: CompleteTurnInput,
  ): Promise<SessionStoreResult<void>> {
    return this.#withSessionLock<void>(sessionId, async (): Promise<SessionStoreResult<void>> => {
      const loaded = await this.#readSession(sessionId);
      if (!loaded.ok) {
        return loaded;
      }
      if (loaded.value.snapshot === undefined) {
        return this.#corruptSnapshot();
      }
      const snapshot = loaded.value.snapshot;
      const turn = snapshot.turns.find((candidate) => candidate.turnId === input.turnId);
      if (turn === undefined || turn.runId !== input.runId) {
        return { ok: false, error: { code: "unknown_turn", message: "turn is not accepted" } };
      }
      if (turn.status !== "running") {
        return {
          ok: false,
          error: { code: "duplicate_turn", message: "turn already has a terminal record" },
        };
      }

      const timestamp = this.#now();
      const record = TurnCompletedRecordSchema.safeParse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        recordId: crypto.randomUUID(),
        sessionId,
        turnId: input.turnId,
        runId: input.runId,
        timestamp,
        kind: "turn.completed" as const,
        status: input.status,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        messages: input.messages,
        includedInContext: input.status === "succeeded",
        model: input.model,
        ...(input.taskGraph === undefined ? {} : { taskGraph: input.taskGraph }),
      });
      if (
        !record.success ||
        (record.data.includedInContext && !hasCompleteToolPairing(record.data.messages))
      ) {
        return { ok: false, error: { code: "invalid_input", message: "completion is invalid" } };
      }
      try {
        await this.#storage.appendLine(
          this.#paths(sessionId).history,
          `${JSON.stringify(record.data)}\n`,
        );
      } catch {
        return { ok: false, error: { code: "io_error", message: "failed to persist completion" } };
      }
      await this.#writeMeta(sessionId, {
        ...snapshot.meta,
        updatedAt: latestTimestamp(snapshot.meta.updatedAt, timestamp),
      });
      return { ok: true, value: undefined };
    });
  }

  /** 追加 session event；sessionSequence 必须与 journal 连续。 */
  async appendSessionEvent(
    sessionId: SessionId,
    event: SessionEvent,
  ): Promise<SessionStoreResult<void>> {
    return this.#withSessionLock<void>(sessionId, async (): Promise<SessionStoreResult<void>> => {
      const loaded = await this.#readSession(sessionId);
      if (!loaded.ok) {
        return loaded;
      }
      if (loaded.value.snapshot === undefined) {
        return this.#corruptSnapshot();
      }
      if (event.sessionId !== sessionId) {
        return { ok: false, error: { code: "invalid_input", message: "event scope mismatch" } };
      }
      const turn = loaded.value.snapshot.turns.find(
        (candidate) =>
          candidate.turnId === event.payload.turnId && candidate.runId === event.payload.runId,
      );
      if (turn === undefined) {
        return { ok: false, error: { code: "invalid_input", message: "event turn is unknown" } };
      }
      if (event.type === "session.turn_accepted") {
        if (
          event.payload.clientMessageId !== turn.clientMessageId ||
          event.payload.userMessage !== userMessageOf(turn)
        ) {
          return { ok: false, error: { code: "invalid_input", message: "event turn mismatch" } };
        }
      } else if (event.payload.status !== turn.status || event.payload.reason !== turn.reason) {
        return { ok: false, error: { code: "invalid_input", message: "event result mismatch" } };
      }
      const expected = loaded.value.snapshot.latestSessionSequence + 1;
      if (event.sessionSequence !== expected) {
        return { ok: false, error: { code: "invalid_input", message: "session sequence gap" } };
      }
      const record = SessionEventRecordSchema.safeParse({
        schemaVersion: SESSION_SCHEMA_VERSION,
        recordId: crypto.randomUUID(),
        event,
      });
      if (!record.success) {
        return { ok: false, error: { code: "invalid_input", message: "session event is invalid" } };
      }
      try {
        await this.#storage.appendLine(
          this.#paths(sessionId).sessionEvents,
          `${JSON.stringify(record.data)}\n`,
        );
      } catch {
        return {
          ok: false,
          error: { code: "io_error", message: "failed to persist session event" },
        };
      }
      return { ok: true, value: undefined };
    });
  }

  /** 读取 session journal 中 sequence 严格大于 afterSequence 的事件，用于订阅回放。 */
  async readSessionEvents(
    sessionId: SessionId,
    afterSequence = 0,
  ): Promise<SessionStoreResult<readonly SessionEvent[]>> {
    const loaded = await this.#readSession(sessionId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value.snapshot === undefined) {
      return this.#corruptSnapshot();
    }
    return {
      ok: true,
      value: loaded.value.snapshot.sessionEvents.filter(
        (event) => event.sessionSequence > afterSequence,
      ),
    };
  }

  /** 原子写入 meta；失败只返回错误，由调用方决定是否降级。 */
  async #writeMeta(sessionId: SessionId, meta: SessionMeta): Promise<SessionStoreResult<void>> {
    try {
      await this.#storage.writeFileAtomic(
        this.#paths(sessionId).meta,
        `${JSON.stringify(meta, null, 2)}\n`,
      );
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: { code: "io_error", message: "failed to persist session meta" } };
    }
  }

  /**
   * 读取并校验单个 session。meta 无效或身份不匹配时返回错误；
   * journal 损坏时保留合法 meta 但不返回 snapshot，由 list 显示为 corrupted。
   */
  async #readSession(sessionId: SessionId): Promise<SessionStoreResult<LoadedSession>> {
    if (!SessionIdSchema.safeParse(sessionId).success) {
      return { ok: false, error: { code: "invalid_input", message: "session id is invalid" } };
    }
    const paths = this.#paths(sessionId);
    let rawMeta: string | undefined;
    try {
      rawMeta = await this.#storage.readFile(paths.meta);
    } catch {
      return { ok: false, error: { code: "io_error", message: "failed to read session meta" } };
    }
    if (rawMeta === undefined) {
      return { ok: false, error: { code: "session_not_found", message: "session does not exist" } };
    }
    let metaValue: unknown;
    try {
      metaValue = JSON.parse(rawMeta) as unknown;
    } catch {
      return {
        ok: false,
        error: { code: "session_corrupted", message: "session meta is corrupt" },
      };
    }
    const meta = SessionMetaSchema.safeParse(metaValue);
    if (!meta.success || meta.data.sessionId !== sessionId) {
      return {
        ok: false,
        error: { code: "session_corrupted", message: "session meta identity is invalid" },
      };
    }

    const history = await this.#readRecords(paths.history, (value) => {
      const parsed = HistoryRecordSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    });
    const events = await this.#readRecords(paths.sessionEvents, (value) => {
      const parsed = SessionEventRecordSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    });
    let notes: string;
    try {
      const rawNotes = await this.#storage.readFile(paths.notes);
      const noteRecords = rawNotes === undefined ? undefined : parseSessionNotes(rawNotes);
      if (
        rawNotes === undefined ||
        new TextEncoder().encode(rawNotes).byteLength > 256 * 1024 ||
        noteRecords === undefined ||
        noteRecords.some((record) => record.sessionId !== sessionId)
      ) {
        return { ok: true, value: { meta: meta.data } };
      }
      notes = rawNotes;
    } catch {
      return { ok: false, error: { code: "io_error", message: "failed to read session notes" } };
    }

    if (!history.ok || !events.ok) {
      return { ok: true, value: { meta: meta.data } };
    }
    const built = this.#buildSnapshot(meta.data, history.records, events.records, notes);
    if (!built.ok) {
      return { ok: true, value: { meta: meta.data } };
    }
    return { ok: true, value: { meta: meta.data, snapshot: built.value } };
  }

  /** 读取固定 JSONL journal；文件缺失或读取失败均视为损坏。 */
  async #readRecords<Record>(
    path: string,
    parse: (value: unknown) => Record | undefined,
  ): Promise<ParsedLines<Record>> {
    let content: string | undefined;
    try {
      content = await this.#storage.readFile(path);
    } catch {
      return { ok: false, reason: "read failed" };
    }
    if (content === undefined) {
      return { ok: false, reason: "journal file is missing" };
    }
    return parseJsonLines(content, parse);
  }

  /**
   * 由合法 history 与 session events 重建快照。
   * 任何身份不匹配、重复终结、未知 turn 或不连续 sequence 都判定为损坏。
   */
  #buildSnapshot(
    meta: SessionMeta,
    history: readonly HistoryRecord[],
    eventRecords: readonly z.infer<typeof SessionEventRecordSchema>[],
    notes: string,
  ): SessionStoreResult<SessionSnapshot> {
    const accepted = new Map<string, Extract<HistoryRecord, { kind: "turn.accepted" }>>();
    const completed = new Set<string>();
    const order: string[] = [];
    const recordIds = new Set<string>();
    let updatedAt = meta.updatedAt;

    for (const record of history) {
      if (record.sessionId !== meta.sessionId) {
        return this.#corrupt("history identity mismatch");
      }
      if (recordIds.has(record.recordId)) {
        return this.#corrupt("duplicate history record id");
      }
      recordIds.add(record.recordId);
      updatedAt = latestTimestamp(updatedAt, record.timestamp);
      const key = `${record.turnId}:${record.runId}`;
      if (record.kind === "turn.accepted") {
        if (accepted.has(key)) {
          return this.#corrupt("duplicate turn.accepted record");
        }
        accepted.set(key, record);
        order.push(key);
      } else {
        if (!accepted.has(key) || completed.has(key)) {
          return this.#corrupt("orphan or duplicate turn.completed record");
        }
        completed.add(key);
      }
    }

    const seenClientMessages = new Set<string>();
    for (const record of accepted.values()) {
      if (seenClientMessages.has(record.clientMessageId)) {
        return this.#corrupt("duplicate clientMessageId record");
      }
      seenClientMessages.add(record.clientMessageId);
    }

    const completedByKey = new Map<string, Extract<HistoryRecord, { kind: "turn.completed" }>>();
    for (const record of history) {
      if (record.kind !== "turn.completed") {
        continue;
      }
      // 只有进入上下文的 completion 才要求工具调用配对完整；失败/取消的审计内容允许中途截断。
      if (record.includedInContext && !hasCompleteToolPairing(record.messages)) {
        return this.#corrupt("included completion has unpaired tool blocks");
      }
      completedByKey.set(`${record.turnId}:${record.runId}`, record);
    }

    const turns: HistoryTurn[] = [];
    const pendingInterruptions: PendingInterruption[] = [];
    let activeRun: ActiveRun | undefined;
    for (const key of order) {
      const record = accepted.get(key);
      if (record === undefined) {
        continue;
      }
      const completion = completedByKey.get(key);
      if (completion === undefined) {
        turns.push({
          turnId: record.turnId,
          runId: record.runId,
          clientMessageId: record.clientMessageId,
          status: "running",
          acceptedAt: record.timestamp,
          includedInContext: false,
          messages: [
            {
              messageId: record.recordId,
              turnId: record.turnId,
              runId: record.runId,
              role: "user",
              timestamp: record.timestamp,
              content: [{ type: "text", text: record.userMessage }],
            },
          ],
        });
        pendingInterruptions.push({
          turnId: record.turnId,
          runId: record.runId,
          clientMessageId: record.clientMessageId,
          acceptedAt: record.timestamp,
          userMessage: record.userMessage,
        });
        activeRun = { turnId: record.turnId, runId: record.runId };
        continue;
      }
      updatedAt = latestTimestamp(updatedAt, completion.timestamp);
      turns.push({
        turnId: record.turnId,
        runId: record.runId,
        clientMessageId: record.clientMessageId,
        status: completion.status,
        ...(completion.reason === undefined ? {} : { reason: completion.reason }),
        acceptedAt: record.timestamp,
        finishedAt: completion.timestamp,
        includedInContext: completion.includedInContext,
        ...(completion.taskGraph === undefined ? {} : { taskGraph: completion.taskGraph }),
        messages: completion.messages,
      });
    }

    let latestSessionSequence = 0;
    const eventRecordIds = new Set<string>();
    const events: SessionEvent[] = [];
    for (const eventRecord of eventRecords) {
      if (eventRecordIds.has(eventRecord.recordId)) {
        return this.#corrupt("duplicate session event record id");
      }
      eventRecordIds.add(eventRecord.recordId);
      const event = eventRecord.event;
      if (event.sessionId !== meta.sessionId) {
        return this.#corrupt("session event identity mismatch");
      }
      if (event.sessionSequence !== latestSessionSequence + 1) {
        return this.#corrupt("session event sequence gap");
      }
      const key = `${event.payload.turnId}:${event.payload.runId}`;
      const acceptedRecord = accepted.get(key);
      const completion = completedByKey.get(key);
      if (event.type === "session.turn_accepted") {
        if (
          acceptedRecord === undefined ||
          event.payload.clientMessageId !== acceptedRecord.clientMessageId ||
          event.payload.userMessage !== acceptedRecord.userMessage
        ) {
          return this.#corrupt("accepted event does not match history");
        }
      } else if (
        completion === undefined ||
        event.payload.status !== completion.status ||
        event.payload.reason !== completion.reason
      ) {
        return this.#corrupt("finished event does not match history");
      }
      latestSessionSequence = event.sessionSequence;
      updatedAt = latestTimestamp(updatedAt, event.timestamp);
      events.push(event);
    }

    // 首条用户消息已落盘但 meta 缓存落后的场景：以合法 journal 为准重建标题。
    const firstAccepted = order
      .map((key) => accepted.get(key))
      .find((record) => record !== undefined);
    const title =
      meta.title === NEW_SESSION_TITLE && firstAccepted !== undefined
        ? deriveTitle(firstAccepted.userMessage)
        : meta.title;

    const status = activeRun === undefined ? "idle" : "running";
    return {
      ok: true,
      value: {
        meta: { ...meta, title },
        status,
        ...(activeRun === undefined ? {} : { activeRun }),
        latestSessionSequence,
        updatedAt,
        turns,
        pendingInterruptions,
        sessionEvents: events,
        notes,
      },
    };
  }

  /** 把已加载的 session 转成列表摘要；损坏 session 仍以 corrupted 状态出现。 */
  #summarize(loaded: LoadedSession): SessionSummary | undefined {
    const snapshot = loaded.snapshot;
    if (snapshot !== undefined) {
      return SessionSummarySchema.parse({
        sessionId: snapshot.meta.sessionId,
        mode: snapshot.meta.mode,
        status: snapshot.status,
        title: snapshot.meta.title,
        workspaceRoot: snapshot.meta.workspaceRoot,
        createdAt: snapshot.meta.createdAt,
        updatedAt: snapshot.updatedAt,
        latestSessionSequence: snapshot.latestSessionSequence,
        ...(snapshot.activeRun === undefined ? {} : { activeRun: snapshot.activeRun }),
      });
    }
    // 元数据合法但 journal 损坏：只读可诊断，不暴露损坏细节。
    return SessionSummarySchema.parse({
      sessionId: loaded.meta.sessionId,
      mode: loaded.meta.mode,
      status: "corrupted",
      title: loaded.meta.title,
      workspaceRoot: loaded.meta.workspaceRoot,
      createdAt: loaded.meta.createdAt,
      updatedAt: loaded.meta.updatedAt,
      latestSessionSequence: 0,
    });
  }

  #encodeCursor(summary: SessionSummary): string {
    return Buffer.from(
      JSON.stringify({ updatedAt: summary.updatedAt, sessionId: summary.sessionId }),
    ).toString("base64url");
  }

  #decodeCursor(cursor: string): SessionCursor | undefined {
    try {
      const parsed = SessionCursorSchema.safeParse(
        JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  #corruptSnapshot(): SessionStoreResult<never> {
    return { ok: false, error: { code: "session_corrupted", message: "session state is corrupt" } };
  }

  #corrupt(reason: string): SessionStoreResult<never> {
    return { ok: false, error: { code: "session_corrupted", message: reason } };
  }

  /** 串行化同一 session 的写操作，避免 read-modify-write 交错。 */
  #withSessionLock<Value>(
    sessionId: SessionId,
    operation: () => Promise<SessionStoreResult<Value>>,
  ): Promise<SessionStoreResult<Value>> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.#locks.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
