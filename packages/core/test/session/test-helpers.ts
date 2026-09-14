import type { RunId, SessionId, TurnId } from "@minicode/protocol";
import { SessionStore } from "../../src/session/session-store.ts";
import type { SessionStorage } from "../../src/session/storage.ts";
import type { SessionMeta } from "../../src/session/types.ts";

export const SESSION_A = "550e8400-e29b-41d4-a716-446655440100" as SessionId;
export const SESSION_B = "550e8400-e29b-41d4-a716-446655440101" as SessionId;
export const RUN_A = "6ba7b810-9dad-41d1-80b4-00c04fd430a0" as RunId;
export const RUN_B = "6ba7b810-9dad-41d1-80b4-00c04fd430a1" as RunId;
export const RUN_C = "6ba7b810-9dad-41d1-80b4-00c04fd430a2" as RunId;
export const TURN_A = "6ba7b820-9dad-41d1-80b4-00c04fd430b0" as TurnId;
export const TURN_B = "6ba7b820-9dad-41d1-80b4-00c04fd430b1" as TurnId;
export const TURN_C = "6ba7b820-9dad-41d1-80b4-00c04fd430b2" as TurnId;
export const CLIENT_MESSAGE_A = "6ba7b830-9dad-41d1-80b4-00c04fd430c0";
export const CLIENT_MESSAGE_B = "6ba7b830-9dad-41d1-80b4-00c04fd430c1";
export const CLIENT_MESSAGE_C = "6ba7b830-9dad-41d1-80b4-00c04fd430c2";

/** 可注入故障的内存存储，用于在不触碰磁盘的情况下覆盖损坏与 I/O 分支。 */
export class MemorySessionStorage implements SessionStorage {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  appendError: Error | undefined;
  readError: Error | undefined;
  writeError: Error | undefined;
  listError: Error | undefined;

  async ensureDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async appendLine(path: string, line: string): Promise<void> {
    if (this.appendError !== undefined) {
      throw this.appendError;
    }
    this.files.set(path, `${this.files.get(path) ?? ""}${line}`);
  }

  async readFile(path: string): Promise<string | undefined> {
    if (this.readError !== undefined) {
      throw this.readError;
    }
    return this.files.get(path);
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
    this.files.set(path, content);
  }

  async listDirectories(path: string): Promise<string[]> {
    if (this.listError !== undefined) {
      throw this.listError;
    }
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.directories]) {
      if (!candidate.startsWith(prefix)) {
        continue;
      }
      const rest = candidate.slice(prefix.length);
      const segment = rest.split("/")[0];
      if (segment !== undefined && segment.length > 0) {
        names.add(segment);
      }
    }
    return [...names];
  }

  async removeDirectory(path: string): Promise<void> {
    this.directories.delete(path);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${path}/`)) {
        this.files.delete(key);
      }
    }
  }
}

/** 构造基于内存存储的 SessionStore 与确定性递增时钟。 */
export function createMemoryStore(home = "/home"): {
  store: SessionStore;
  storage: MemorySessionStorage;
  tick: () => string;
} {
  const storage = new MemorySessionStorage();
  let counter = 0;
  const tick = (): string => {
    counter += 1;
    return new Date(Date.UTC(2026, 8, 14, 8, 0, counter)).toISOString();
  };
  return { store: new SessionStore(home, storage, tick), storage, tick };
}

export function sessionPaths(home: string, sessionId: SessionId) {
  const directory = `${home}/sessions/${sessionId}`;
  return {
    directory,
    meta: `${directory}/meta.json`,
    history: `${directory}/history.jsonl`,
    notes: `${directory}/notes.md`,
    sessionEvents: `${directory}/session-events.jsonl`,
  };
}

/** 直接写入一份合法 meta，便于测试指定 sessionId 的场景。 */
export function seedSession(
  storage: MemorySessionStorage,
  home: string,
  sessionId: SessionId,
  overrides: Partial<SessionMeta> = {},
): SessionMeta {
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId,
    mode: "chat",
    workspaceRoot: "/workspace",
    title: "New session",
    createdAt: "2026-09-14T08:00:00.000Z",
    updatedAt: "2026-09-14T08:00:00.000Z",
    ...overrides,
  };
  const paths = sessionPaths(home, sessionId);
  storage.files.set(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  storage.files.set(paths.history, "");
  storage.files.set(paths.sessionEvents, "");
  storage.files.set(paths.notes, "");
  return meta;
}
