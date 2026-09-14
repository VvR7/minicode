import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Session 持久化的最小 I/O 契约。
 * 所有实现必须保证 JSONL 追加后 fsync、meta 原子替换、目录 0700、文件 0600。
 * 测试可注入内存实现或故障实现，无需真实磁盘。
 */
export interface SessionStorage {
  /** 递归创建目录并收紧到 0700。 */
  ensureDirectory(path: string): Promise<void>;
  /** 以单次 append 追加一行并 fsync，文件权限 0600。 */
  appendLine(path: string, line: string): Promise<void>;
  /** 读取 UTF-8 文本；不存在返回 undefined。 */
  readFile(path: string): Promise<string | undefined>;
  /** 同目录临时文件 + fsync + rename 的原子替换，权限 0600。 */
  writeFileAtomic(path: string, content: string): Promise<void>;
  /** 列出目录下的子目录名；目录不存在返回空数组。 */
  listDirectories(path: string): Promise<string[]>;
  /** 递归删除目录，用于测试清理；不存在时静默成功。 */
  removeDirectory(path: string): Promise<void>;
}

/** 从未知错误中安全提取 Node 错误码。 */
function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** fsync 目录项，确保 rename/append 的目录元数据在崩溃后可见。 */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 基于 node:fs/promises 的真实存储实现。
 * 所有写路径都先创建/收紧父目录，再以独占权限写入并 fsync。
 */
export const nodeSessionStorage: SessionStorage = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    // mkdir 对已存在目录不会改权限，这里显式收紧，避免旧权限泄露 session 元数据。
    await chmod(path, 0o700);
  },

  async appendLine(path, line) {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(line, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
  },

  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  },

  async writeFileAtomic(path, content) {
    const directory = dirname(path);
    const temporary = join(directory, `.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      await syncDirectory(directory);
    } catch (error) {
      // rename 失败时尽力清理临时文件，避免泄露半成品内容。
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  },

  async listDirectories(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  },

  async removeDirectory(path) {
    await rm(path, { recursive: true, force: true });
  },
};
