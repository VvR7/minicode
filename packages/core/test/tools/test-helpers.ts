import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 创建临时 workspace 目录并返回其 realpath 化绝对路径。 */
export async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-tools-"));
  return await realpath(dir);
}

/** 递归删除临时 workspace。 */
export async function cleanupTempWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
