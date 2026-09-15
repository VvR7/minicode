import { join } from "node:path";
import type { HistoryTurnReason, RunId, SessionId, TurnId } from "@minicode/protocol";
import {
  HistoryTurnReasonSchema,
  RunIdSchema,
  SessionIdSchema,
  TurnIdSchema,
} from "@minicode/protocol";
import { z } from "zod";
import type { SessionStorage } from "../session/storage.ts";
import { nodeSessionStorage } from "../session/storage.ts";

export const RUN_METADATA_SCHEMA_VERSION = 1 as const;

export const RunMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(RUN_METADATA_SCHEMA_VERSION),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    runId: RunIdSchema,
    workspaceRoot: z.string().min(1).max(4096),
    model: z.string().max(256),
    acceptedAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    finishedAt: z.iso.datetime({ offset: true }).optional(),
    status: z.enum(["accepted", "running", "succeeded", "failed", "cancelled", "interrupted"]),
    reason: HistoryTurnReasonSchema.optional(),
  })
  .superRefine((metadata, context) => {
    const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(metadata.status);
    if (terminal !== (metadata.finishedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "terminal metadata requires finishedAt",
        path: ["finishedAt"],
      });
    }
  });
export type RunMetadata = z.infer<typeof RunMetadataSchema>;

export type RunMetadataResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: "io_error" | "corrupted" | "invalid_transition" };

/** 原子维护 runs/<runId>/run.json 的运行审计元数据。 */
export class RunMetadataStore {
  readonly #homeDirectory: string;
  readonly #storage: SessionStorage;
  readonly #now: () => string;

  constructor(
    homeDirectory: string,
    storage: SessionStorage = nodeSessionStorage,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#homeDirectory = homeDirectory;
    this.#storage = storage;
    this.#now = now;
  }

  /** 建立 run 目录并写入 accepted 初态。 */
  async create(input: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly runId: RunId;
    readonly workspaceRoot: string;
    readonly model: string;
    readonly acceptedAt?: string;
  }): Promise<RunMetadataResult<RunMetadata>> {
    const metadata = RunMetadataSchema.safeParse({
      schemaVersion: RUN_METADATA_SCHEMA_VERSION,
      ...input,
      acceptedAt: input.acceptedAt ?? this.#now(),
      status: "accepted",
    });
    if (!metadata.success) {
      return { ok: false, error: "invalid_transition" };
    }
    try {
      await this.#storage.ensureDirectory(this.#directory(input.sessionId, input.runId));
      await this.#write(metadata.data);
      return { ok: true, value: metadata.data };
    } catch {
      return { ok: false, error: "io_error" };
    }
  }

  /** 将 accepted run 原子更新为 running。 */
  async markStarted(sessionId: SessionId, runId: RunId): Promise<RunMetadataResult<RunMetadata>> {
    const loaded = await this.read(sessionId, runId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === undefined || loaded.value.status !== "accepted") {
      return { ok: false, error: "invalid_transition" };
    }
    const next = RunMetadataSchema.parse({
      ...loaded.value,
      status: "running",
      startedAt: this.#now(),
    });
    try {
      await this.#write(next);
      return { ok: true, value: next };
    } catch {
      return { ok: false, error: "io_error" };
    }
  }

  /** 将 accepted/running run 原子更新为唯一终态。 */
  async markFinished(
    sessionId: SessionId,
    runId: RunId,
    status: "succeeded" | "failed" | "cancelled" | "interrupted",
    reason: HistoryTurnReason,
  ): Promise<RunMetadataResult<RunMetadata>> {
    const loaded = await this.read(sessionId, runId);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === undefined) {
      return { ok: false, error: "corrupted" };
    }
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(loaded.value.status)) {
      return loaded.value.status === status && loaded.value.reason === reason
        ? { ok: true, value: loaded.value }
        : { ok: false, error: "invalid_transition" };
    }
    const next = RunMetadataSchema.parse({
      ...loaded.value,
      status,
      reason,
      finishedAt: this.#now(),
    });
    try {
      await this.#write(next);
      return { ok: true, value: next };
    } catch {
      return { ok: false, error: "io_error" };
    }
  }

  /** 读取并严格校验 run.json；缺失返回 undefined。 */
  async read(
    sessionId: SessionId,
    runId: RunId,
  ): Promise<RunMetadataResult<RunMetadata | undefined>> {
    try {
      const raw = await this.#storage.readFile(this.#path(sessionId, runId));
      if (raw === undefined) {
        return { ok: true, value: undefined };
      }
      const parsed = RunMetadataSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.runId !== runId) {
        return { ok: false, error: "corrupted" };
      }
      return { ok: true, value: parsed.data };
    } catch (error) {
      return error instanceof SyntaxError
        ? { ok: false, error: "corrupted" }
        : { ok: false, error: "io_error" };
    }
  }

  /** 原子替换 run.json。 */
  async #write(metadata: RunMetadata): Promise<void> {
    await this.#storage.writeFileAtomic(
      this.#path(metadata.sessionId, metadata.runId),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }

  /** 计算已校验身份对应的 run 目录。 */
  #directory(sessionId: SessionId, runId: RunId): string {
    SessionIdSchema.parse(sessionId);
    RunIdSchema.parse(runId);
    return join(this.#homeDirectory, "sessions", sessionId, "runs", runId);
  }

  /** 计算 run.json 路径。 */
  #path(sessionId: SessionId, runId: RunId): string {
    return join(this.#directory(sessionId, runId), "run.json");
  }
}
