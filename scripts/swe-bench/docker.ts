import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BENCHMARK_LABEL,
  BENCHMARK_LABEL_VALUE,
  cacheDirectory,
  usesHostProxy,
} from "./constants.ts";
import { runCommand, type CommandResult } from "./process.ts";
import type { CleanupResult, RunState } from "./types.ts";

/** 封装 benchmark 允许执行的精确 Docker 操作。 */
export class DockerController {
  readonly #repositoryRoot: string;

  /** 保存宿主仓库路径，供受控临时文件使用。 */
  constructor(repositoryRoot: string) {
    this.#repositoryRoot = repositoryRoot;
  }

  /** 显式 pull 当前唯一 task image。 */
  async pull(image: string, timeoutMs: number): Promise<void> {
    const crane = join(cacheDirectory(this.#repositoryRoot), "bin", "crane");
    if (usesHostProxy() && (await Bun.file(crane).exists())) {
      const result = await runCommand(
        [
          "/bin/bash",
          "-o",
          "pipefail",
          "-c",
          '"$1" pull --platform linux/amd64 "$2" /dev/stdout | docker load',
          "minicode-proxy-pull",
          crane,
          image,
        ],
        { timeoutMs },
      );
      if (result.timedOut) throw new Error(`proxy-aware image pull timed out: ${image}`);
      if (result.exitCode !== 0) {
        throw new Error(`proxy-aware image pull failed: ${result.stderr}`);
      }
      if (!(await this.imageExists(image))) {
        throw new Error(`proxy-aware image pull did not import the expected reference: ${image}`);
      }
      return;
    }
    const result = await runCommand(["docker", "pull", image], { timeoutMs });
    if (result.timedOut) throw new Error(`image pull timed out: ${image}`);
    if (result.exitCode !== 0) throw new Error(`image pull failed: ${result.stderr}`);
  }

  /** 创建带专用 label 的休眠容器，并返回精确 container ID。 */
  async create(image: string, name: string, runId: string, timeoutMs: number): Promise<string> {
    const result = await runCommand(
      [
        "docker",
        "create",
        "--name",
        name,
        "--label",
        `${BENCHMARK_LABEL}=${BENCHMARK_LABEL_VALUE}`,
        "--label",
        `dev.minicode.swe-bench.run=${runId}`,
        image,
        "sleep",
        "infinity",
      ],
      { timeoutMs },
    );
    if (result.exitCode !== 0) throw new Error(`container create failed: ${result.stderr}`);
    const id = result.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("docker create returned an invalid id");
    return id;
  }

  /** 启动精确 container ID。 */
  async start(containerId: string, timeoutMs: number): Promise<void> {
    const result = await runCommand(["docker", "start", containerId], { timeoutMs });
    if (result.exitCode !== 0) throw new Error(`container start failed: ${result.stderr}`);
  }

  /** 在容器中执行命令并分别返回输出。 */
  async exec(
    containerId: string,
    command: readonly string[],
    options: {
      readonly timeoutMs: number;
      readonly workdir?: string;
      readonly environmentNames?: readonly string[];
      readonly hostEnvironment?: Record<string, string | undefined>;
      readonly detached?: boolean;
    },
  ): Promise<CommandResult> {
    const args = ["docker", "exec"];
    if (options.detached) args.push("-d");
    if (options.workdir !== undefined) args.push("-w", options.workdir);
    for (const name of options.environmentNames ?? []) args.push("-e", name);
    args.push(containerId, ...command);
    return runCommand(args, {
      timeoutMs: options.timeoutMs,
      ...(options.hostEnvironment === undefined ? {} : { env: options.hostEnvironment }),
    });
  }

  /** 把宿主文件复制到精确容器路径。 */
  async copyTo(
    containerId: string,
    source: string,
    destination: string,
    timeoutMs: number,
  ): Promise<void> {
    const result = await runCommand(["docker", "cp", source, `${containerId}:${destination}`], {
      timeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`docker cp failed: ${result.stderr}`);
  }

  /** 从容器复制目录到宿主暂存位置。 */
  async copyFrom(
    containerId: string,
    source: string,
    destination: string,
    timeoutMs: number,
  ): Promise<void> {
    await mkdir(destination, { recursive: true });
    const result = await runCommand(["docker", "cp", `${containerId}:${source}`, destination], {
      timeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`docker cp from container failed: ${result.stderr}`);
  }

  /** 将内存文本写入 cache 临时文件后复制进容器。 */
  async copyText(
    containerId: string,
    name: string,
    content: string,
    destination: string,
    timeoutMs: number,
  ): Promise<void> {
    const directory = join(this.#repositoryRoot, ".cache", "swe-bench", "transfer");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${process.pid}-${crypto.randomUUID()}-${name}`);
    await writeFile(path, content, { mode: 0o600 });
    try {
      await this.copyTo(containerId, path, destination, timeoutMs);
    } finally {
      await Bun.file(path).delete();
    }
  }

  /** 强制删除精确容器；容器已不存在视为成功。 */
  async removeContainer(containerId: string, timeoutMs: number): Promise<string | undefined> {
    const result = await runCommand(["docker", "rm", "-f", containerId], { timeoutMs });
    if (result.exitCode === 0 || result.stderr.includes("No such container")) return undefined;
    return result.stderr.trim() || "docker rm failed";
  }

  /** 强制删除精确 image reference；image 已不存在视为成功。 */
  async removeImage(image: string, timeoutMs: number): Promise<string | undefined> {
    const result = await runCommand(["docker", "image", "rm", "-f", image], { timeoutMs });
    if (result.exitCode === 0 || result.stderr.includes("No such image")) return undefined;
    return result.stderr.trim() || "docker image rm failed";
  }

  /** 判断精确容器是否仍存在。 */
  async containerExists(containerId: string): Promise<boolean> {
    const result = await runCommand(["docker", "container", "inspect", containerId], {
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) return true;
    if (result.stderr.includes("No such") || result.stderr.includes("not found")) return false;
    throw new Error(`unable to verify container cleanup: ${result.stderr}`);
  }

  /** 判断精确 image reference 是否仍存在。 */
  async imageExists(image: string): Promise<boolean> {
    const result = await runCommand(["docker", "image", "inspect", image], { timeoutMs: 10_000 });
    if (result.exitCode === 0) return true;
    if (result.stderr.includes("No such") || result.stderr.includes("not found")) return false;
    throw new Error(`unable to verify image cleanup: ${result.stderr}`);
  }

  /** 列出所有带 benchmark 专用 label 的遗留容器 ID。 */
  async labeledContainers(): Promise<readonly string[]> {
    const result = await runCommand(
      ["docker", "ps", "-aq", "--filter", `label=${BENCHMARK_LABEL}=${BENCHMARK_LABEL_VALUE}`],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(`failed to inspect benchmark containers: ${result.stderr}`);
    return result.stdout.split("\n").filter(Boolean);
  }

  /** 验证 container 的 label、ID 与 image 都和 run metadata 完全一致。 */
  async verifyOwnership(containerId: string, state: RunState): Promise<boolean> {
    const result = await runCommand(
      [
        "docker",
        "container",
        "inspect",
        "--format",
        `{{.Id}}|{{index .Config.Labels "${BENCHMARK_LABEL}"}}|{{.Config.Image}}`,
        containerId,
      ],
      { timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) return false;
    const [id, label, image] = result.stdout.trim().split("|");
    return id === containerId && label === BENCHMARK_LABEL_VALUE && image === state.image;
  }

  /** 重试并验证两个容器和当前 image 均已清理。 */
  async cleanup(
    containerIds: readonly string[],
    image: string,
    timeoutMs: number,
  ): Promise<CleanupResult> {
    const errors: string[] = [];
    let attempts = 0;
    for (attempts = 1; attempts <= 3; attempts += 1) {
      for (const id of containerIds.filter(Boolean)) {
        const error = await this.removeContainer(id, timeoutMs);
        if (error !== undefined) errors.push(error);
      }
      const imageError = await this.removeImage(image, timeoutMs);
      if (imageError !== undefined) errors.push(imageError);
      let remainingContainers: string[] = [];
      let imagePresent = true;
      try {
        remainingContainers = (
          await Promise.all(
            containerIds
              .filter(Boolean)
              .map(async (id) => ((await this.containerExists(id)) ? id : "")),
          )
        ).filter(Boolean);
        imagePresent = await this.imageExists(image);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        remainingContainers = [...containerIds.filter(Boolean)];
      }
      if (remainingContainers.length === 0 && !imagePresent) {
        return { succeeded: true, attempts, remainingContainers, imagePresent, errors };
      }
      await Bun.sleep(500);
    }
    let remainingContainers = [...containerIds.filter(Boolean)];
    let imagePresent = true;
    try {
      remainingContainers = (
        await Promise.all(
          containerIds
            .filter(Boolean)
            .map(async (id) => ((await this.containerExists(id)) ? id : "")),
        )
      ).filter(Boolean);
      imagePresent = await this.imageExists(image);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return {
      succeeded: false,
      attempts: Math.min(attempts, 3),
      remainingContainers,
      imagePresent,
      errors,
    };
  }
}
