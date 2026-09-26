import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ArtifactStore } from "./artifact-store.ts";
import {
  BENCHMARK_CONTEXT_TOKENS,
  BENCHMARK_MAX_STEPS,
  CRANE_LINUX_X86_64_SHA256,
  CRANE_VERSION,
  DATASET_REVISION,
  SWE_BENCH_COMMIT,
  cacheDirectory,
  imageForTask,
  usesHostProxy,
} from "./constants.ts";
import { DockerController } from "./docker.ts";
import { OfficialHarness } from "./official-harness.ts";
import { runCommand } from "./process.ts";
import type { SecretRedactor } from "./redactor.ts";
import type {
  CleanupResult,
  EvaluationResult,
  RunState,
  RunnerOptions,
  SweBenchTask,
  TaskResult,
} from "./types.ts";

interface RuntimeBinaries {
  readonly core: string;
  readonly cli: string;
}

/** 执行固定 Verified Mini task 的严格串行双容器流程。 */
export class SweBenchRunner {
  readonly #repositoryRoot: string;
  readonly #options: RunnerOptions;
  readonly #store: ArtifactStore;
  readonly #redactor: SecretRedactor;
  readonly #docker: DockerController;
  readonly #official: OfficialHarness;
  readonly #runId = crypto.randomUUID();
  readonly #modelEnvironment: Record<string, string | undefined>;
  #binaries: RuntimeBinaries | undefined;

  /** 组装 orchestration 依赖，不在构造时执行外部副作用。 */
  constructor(
    repositoryRoot: string,
    options: RunnerOptions,
    store: ArtifactStore,
    redactor: SecretRedactor,
  ) {
    this.#repositoryRoot = repositoryRoot;
    this.#options = options;
    this.#store = store;
    this.#redactor = redactor;
    this.#docker = new DockerController(repositoryRoot);
    this.#official = new OfficialHarness(repositoryRoot, redactor);
    const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = Bun.env;
    this.#modelEnvironment = {
      LLM_API_KEY,
      LLM_BASE_URL,
      LLM_MODEL,
      LLM_CONTEXT_WINDOW_TOKENS: String(BENCHMARK_CONTEXT_TOKENS),
      MINICODE_MAX_STEPS: String(BENCHMARK_MAX_STEPS),
      MINICODE_PERMISSION_MODE: "bypasspermission",
      MINICODE_TRACE_ENABLED: "true",
      MINICODE_TRACE_PAYLOAD: "full",
      MINICODE_HOME: "/tmp/minicode-home",
      MINICODE_CORE_HOST: "127.0.0.1",
      MINICODE_CORE_PORT: "7437",
    };
  }

  /** 在整批开始时编译两个不自动加载容器 .env 的 standalone binary。 */
  async prepareRuntime(): Promise<void> {
    for (const name of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const) {
      if (!this.#modelEnvironment[name])
        throw new Error(`missing required model configuration: ${name}`);
    }
    const directory = join(cacheDirectory(this.#repositoryRoot), "bin");
    await mkdir(directory, { recursive: true });
    await this.#prepareProxyPullTool(directory);
    const core = join(directory, "mc-core");
    const cli = join(directory, "mc");
    for (const [entry, output] of [
      ["packages/core/src/bin.ts", core],
      ["packages/cli/src/mc.ts", cli],
    ] as const) {
      const result = await runCommand(
        [
          "bun",
          "build",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          output,
          entry,
        ],
        { cwd: this.#repositoryRoot, timeoutMs: this.#options.startupTimeoutMs },
      );
      if (result.exitCode !== 0) throw new Error(`standalone build failed: ${result.stderr}`);
    }
    this.#binaries = { core, cli };
  }

  /** 在宿主使用代理而 Docker daemon 未继承代理时准备固定校验和的 crane。 */
  async #prepareProxyPullTool(directory: string): Promise<void> {
    if (!usesHostProxy()) return;
    const crane = join(directory, "crane");
    if (await Bun.file(crane).exists()) return;
    const archive = join(directory, `go-containerregistry-${CRANE_VERSION}.tar.gz`);
    const url = `https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz`;
    const download = await runCommand(["curl", "-fL", url, "-o", archive], {
      timeoutMs: this.#options.startupTimeoutMs,
    });
    if (download.exitCode !== 0) throw new Error(`failed to download crane: ${download.stderr}`);
    const digest = await runCommand(["sha256sum", archive], {
      timeoutMs: this.#options.startupTimeoutMs,
    });
    if (digest.exitCode !== 0 || digest.stdout.split(/\s+/)[0] !== CRANE_LINUX_X86_64_SHA256) {
      await Bun.file(archive).delete();
      throw new Error("crane release checksum mismatch");
    }
    const extract = await runCommand(["tar", "-xzf", archive, "-C", directory, "crane"], {
      timeoutMs: this.#options.startupTimeoutMs,
    });
    await Bun.file(archive).delete();
    if (extract.exitCode !== 0) throw new Error(`failed to extract crane: ${extract.stderr}`);
  }

  /** 执行单题，并确保所有退出路径最终清理两个容器和 image。 */
  async runTask(task: SweBenchTask): Promise<TaskResult> {
    if (this.#binaries === undefined) throw new Error("runtime binaries were not prepared");
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const image = imageForTask(task.id);
    const state: {
      agentContainerId?: string;
      evaluationContainerId?: string;
      patch: string;
      agentExitCode: number | null;
      agentTimedOut: boolean;
      status: TaskResult["status"];
      reason: string;
      evaluation: EvaluationResult;
    } = {
      patch: "",
      agentExitCode: null,
      agentTimedOut: false,
      status: "failed",
      reason: "task did not start",
      evaluation: { attempted: false, resolved: false },
    };
    let cleanup: CleanupResult = {
      succeeded: false,
      attempts: 0,
      remainingContainers: [],
      imagePresent: false,
      errors: [],
    };

    await this.#store.archiveExisting(task.id);
    await Promise.all([
      this.#store.writeTaskText(task.id, "patch.diff", ""),
      this.#store.writeTaskText(task.id, "agent.stdout.log", ""),
      this.#store.writeTaskText(task.id, "agent.stderr.log", ""),
      this.#store.writeTaskText(task.id, "core.log", ""),
      this.#store.writeTaskText(task.id, "evaluation.log", ""),
      this.#store.writeTaskText(task.id, "run.json", "{}\n"),
      this.#store.writeTaskText(task.id, "events.jsonl", ""),
      this.#store.writeTaskText(task.id, "trace.jsonl", ""),
    ]);
    await this.#writeState(task, image, state);
    try {
      await this.#docker.pull(image, this.#options.pullTimeoutMs);
      state.agentContainerId = await this.#createContainer(task, image, "agent");
      await this.#writeState(task, image, state);
      await this.#runAgent(task, state.agentContainerId, state);

      const removeAgentError = await this.#docker.removeContainer(
        state.agentContainerId,
        this.#options.startupTimeoutMs,
      );
      if (
        removeAgentError !== undefined ||
        (await this.#docker.containerExists(state.agentContainerId))
      ) {
        throw new Error(
          `agent container cleanup before evaluation failed: ${removeAgentError ?? "still exists"}`,
        );
      }
      delete state.agentContainerId;
      await this.#writeState(task, image, state);

      if (state.agentTimedOut) {
        state.status = "timeout";
        state.reason = "agent_timeout";
      } else if (state.agentExitCode !== 0) {
        state.status = "failed";
        state.reason = "agent_failed";
      } else {
        state.evaluationContainerId = await this.#createContainer(task, image, "evaluation");
        await this.#writeState(task, image, state);
        state.evaluation = await this.#runEvaluation(
          task,
          image,
          state.evaluationContainerId,
          state.patch,
        );
        state.status = state.evaluation.resolved ? "resolved" : "failed";
        state.reason = state.evaluation.resolved
          ? "official_tests_resolved"
          : (state.evaluation.reason ?? "official_tests_failed");
      }
    } catch (error) {
      if (state.agentTimedOut) {
        state.status = "timeout";
        state.reason = "agent_timeout";
      } else {
        state.status = "failed";
        state.reason = this.#redactor.redact(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      try {
        cleanup = await this.#docker.cleanup(
          [state.agentContainerId ?? "", state.evaluationContainerId ?? ""],
          image,
          this.#options.startupTimeoutMs,
        );
      } catch (error) {
        cleanup = {
          succeeded: false,
          attempts: 3,
          remainingContainers: [
            state.agentContainerId ?? "",
            state.evaluationContainerId ?? "",
          ].filter(Boolean),
          imagePresent: true,
          errors: [this.#redactor.redact(error instanceof Error ? error.message : String(error))],
        };
      }
      if (!cleanup.succeeded) {
        state.status = "cleanup_failed";
        state.reason = "container_or_image_cleanup_failed";
      }
    }

    const finished = Date.now();
    const result: TaskResult = {
      schemaVersion: 1,
      taskId: task.id,
      status: state.status,
      reason: state.reason,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      image,
      minicodeGitSha: await this.#gitSha(),
      datasetRevision: DATASET_REVISION,
      sweBenchCommit: SWE_BENCH_COMMIT,
      agentExitCode: state.agentExitCode,
      agentTimedOut: state.agentTimedOut,
      evaluation: state.evaluation,
      cleanup,
    };
    await this.#store.writeTaskJson(task.id, "result.json", result);
    await this.#writeState(task, image, state);
    return result;
  }

  /** 创建、启动 task container，并把 standalone runtime 注入固定路径。 */
  async #createContainer(task: SweBenchTask, image: string, role: string): Promise<string> {
    const name = `minicode-swe-${role}-${task.id}-${this.#runId.slice(0, 8)}`;
    const id = await this.#docker.create(image, name, this.#runId, this.#options.startupTimeoutMs);
    await this.#docker.start(id, this.#options.startupTimeoutMs);
    await this.#resetTestbed(id);
    const mkdirResult = await this.#docker.exec(id, ["mkdir", "-p", "/opt/minicode"], {
      timeoutMs: this.#options.startupTimeoutMs,
    });
    if (mkdirResult.exitCode !== 0)
      throw new Error(`runtime directory setup failed: ${mkdirResult.stderr}`);
    if (role === "agent") {
      if (this.#binaries === undefined) throw new Error("runtime binaries unavailable");
      await this.#docker.copyTo(
        id,
        this.#binaries.core,
        "/opt/minicode/mc-core",
        this.#options.startupTimeoutMs,
      );
      await this.#docker.copyTo(
        id,
        this.#binaries.cli,
        "/opt/minicode/mc",
        this.#options.startupTimeoutMs,
      );
      const chmod = await this.#docker.exec(
        id,
        ["chmod", "755", "/opt/minicode/mc-core", "/opt/minicode/mc"],
        {
          timeoutMs: this.#options.startupTimeoutMs,
        },
      );
      if (chmod.exitCode !== 0) throw new Error(`runtime chmod failed: ${chmod.stderr}`);
    }
    return id;
  }

  /** 清除 image 构建时遗留的工作树改动，确保 Agent 和 evaluation 都从 HEAD 开始。 */
  async #resetTestbed(containerId: string): Promise<void> {
    const reset = await this.#docker.exec(
      containerId,
      [
        "/bin/bash",
        "-lc",
        'git reset --hard HEAD && git clean -fdx && test -z "$(git status --porcelain)"',
      ],
      { timeoutMs: this.#options.startupTimeoutMs, workdir: "/testbed" },
    );
    if (reset.exitCode !== 0) {
      throw new Error(`testbed reset failed: ${reset.stderr}`);
    }
  }

  /** 在 Agent container 内通过正常 Core 和 mc --goal 执行任务。 */
  async #runAgent(
    task: SweBenchTask,
    containerId: string,
    state: { patch: string; agentExitCode: number | null; agentTimedOut: boolean },
  ): Promise<void> {
    const environmentNames = Object.keys(this.#modelEnvironment);
    const core = await this.#docker.exec(
      containerId,
      [
        "/bin/bash",
        "-lc",
        "echo $$ >/tmp/minicode-core.pid; exec /opt/minicode/mc-core >/tmp/minicode-core.log 2>&1",
      ],
      {
        timeoutMs: this.#options.startupTimeoutMs,
        environmentNames,
        hostEnvironment: this.#modelEnvironment,
        detached: true,
      },
    );
    if (core.exitCode !== 0) throw new Error(`core start failed: ${core.stderr}`);
    await this.#waitForCore(containerId);

    const agent = await this.#docker.exec(
      containerId,
      [
        "/bin/bash",
        "-lc",
        'echo $$ >/tmp/minicode-agent.pid; exec /opt/minicode/mc --goal "$1"',
        "minicode-agent",
        task.prompt,
      ],
      {
        timeoutMs: this.#options.agentTimeoutMs,
        workdir: "/testbed",
        environmentNames: ["MINICODE_CORE_HOST", "MINICODE_CORE_PORT"],
        hostEnvironment: this.#modelEnvironment,
      },
    );
    state.agentExitCode = agent.exitCode;
    state.agentTimedOut = agent.timedOut;
    await this.#store.writeTaskText(task.id, "agent.stdout.log", agent.stdout);
    await this.#store.writeTaskText(task.id, "agent.stderr.log", agent.stderr);
    if (agent.timedOut) {
      await this.#docker.exec(
        containerId,
        [
          "/bin/bash",
          "-lc",
          "kill -TERM $(cat /tmp/minicode-agent.pid) 2>/dev/null || true; for i in {1..20}; do kill -0 $(cat /tmp/minicode-agent.pid) 2>/dev/null || exit 0; sleep .25; done; kill -KILL $(cat /tmp/minicode-agent.pid) 2>/dev/null || true",
        ],
        { timeoutMs: 10_000 },
      );
    }
    await this.#stopCore(containerId);
    await this.#captureAgentArtifacts(task.id, containerId);
    const patch = await this.#docker.exec(
      containerId,
      [
        "/bin/bash",
        "-lc",
        "git add -A && git -c core.fileMode=false diff --cached --binary --full-index",
      ],
      { timeoutMs: this.#options.startupTimeoutMs, workdir: "/testbed" },
    );
    if (patch.exitCode !== 0) throw new Error(`failed to capture model patch: ${patch.stderr}`);
    state.patch = patch.stdout;
    await this.#store.writeTaskText(task.id, "patch.diff", patch.stdout);
    if (this.#redactor.containsSecret(patch.stdout)) {
      throw new Error("model patch contained injected credentials and was redacted");
    }
  }

  /** 等待 Core 监听端口，超过 startup timeout 则失败。 */
  async #waitForCore(containerId: string): Promise<void> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.#docker.exec(
        containerId,
        ["/bin/bash", "-lc", "echo >/dev/tcp/127.0.0.1/7437"],
        { timeoutMs: 5_000 },
      );
      if (probe.exitCode === 0) return;
      await Bun.sleep(500);
    }
    throw new Error("core startup timed out");
  }

  /** 请求 Core 正常 SIGTERM 并等待 trace flush。 */
  async #stopCore(containerId: string): Promise<void> {
    await this.#docker.exec(
      containerId,
      [
        "/bin/bash",
        "-lc",
        "kill -TERM $(cat /tmp/minicode-core.pid) 2>/dev/null || true; for i in {1..20}; do kill -0 $(cat /tmp/minicode-core.pid) 2>/dev/null || exit 0; sleep .25; done; exit 0",
      ],
      { timeoutMs: 10_000 },
    );
  }

  /** 复制并二次脱敏 run/events/trace 与 Core 日志。 */
  async #captureAgentArtifacts(taskId: string, containerId: string): Promise<void> {
    const coreLog = await this.#docker.exec(containerId, ["cat", "/tmp/minicode-core.log"], {
      timeoutMs: 10_000,
    });
    await this.#store.writeTaskText(taskId, "core.log", `${coreLog.stdout}${coreLog.stderr}`);
    const temporary = await mkdtemp(join(tmpdir(), "minicode-swe-artifacts-"));
    try {
      await this.#docker.copyFrom(containerId, "/tmp/minicode-home", temporary, 30_000);
      const files = await readdir(temporary, { recursive: true });
      for (const path of files) {
        const name = basename(path);
        if (!["run.json", "events.jsonl", "trace.jsonl"].includes(name)) continue;
        const content = await readFile(join(temporary, path), "utf8");
        await this.#store.writeTaskText(taskId, name, content);
      }
    } catch (error) {
      await this.#store.writeTaskText(
        taskId,
        "artifact-copy-error.log",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /** 在全新 evaluation container 中应用 model patch 并执行官方脚本与判分。 */
  async #runEvaluation(
    task: SweBenchTask,
    image: string,
    containerId: string,
    modelPatch: string,
  ): Promise<EvaluationResult> {
    const script = await this.#official.prepare(task, image);
    await this.#docker.copyText(containerId, "model.patch", modelPatch, "/tmp/model.patch", 30_000);
    await this.#docker.copyText(containerId, "eval.sh", script, "/tmp/eval.sh", 30_000);
    const apply = await this.#docker.exec(
      containerId,
      [
        "/bin/bash",
        "-lc",
        "git apply --verbose /tmp/model.patch || git apply --verbose --3way /tmp/model.patch || git apply --verbose --reject /tmp/model.patch || patch --batch --forward --fuzz=5 -p1 -i /tmp/model.patch",
      ],
      { timeoutMs: this.#options.startupTimeoutMs, workdir: "/testbed" },
    );
    if (apply.exitCode !== 0) {
      const log = `${apply.stdout}${apply.stderr}`;
      await this.#store.writeTaskText(task.id, "evaluation.log", log);
      return { attempted: true, resolved: false, reason: "model_patch_apply_failed" };
    }

    const evaluation = await this.#docker.exec(
      containerId,
      ["/bin/bash", "-lc", "/bin/bash /tmp/eval.sh 2>&1"],
      {
        timeoutMs: this.#options.evaluationTimeoutMs,
        workdir: "/testbed",
      },
    );
    const rawLog = `${evaluation.stdout}${evaluation.stderr}`;
    await this.#store.writeTaskText(task.id, "evaluation.log", rawLog);
    if (evaluation.timedOut)
      return { attempted: true, resolved: false, reason: "evaluation_timeout" };

    const temporary = join(cacheDirectory(this.#repositoryRoot), `evaluation-${process.pid}.log`);
    await writeFile(temporary, rawLog, { mode: 0o600 });
    try {
      const report = await this.#official.grade(task, image, modelPatch, temporary);
      const entry = (report as Record<string, { readonly resolved?: boolean }>)[task.id];
      return {
        attempted: true,
        resolved: entry?.resolved === true,
        report,
        ...(entry?.resolved === true ? {} : { reason: "official_tests_failed" }),
      };
    } finally {
      await Bun.file(temporary).delete();
    }
  }

  /** 更新 crash 恢复所需的精确资源 metadata。 */
  async #writeState(
    task: SweBenchTask,
    image: string,
    state: { agentContainerId?: string; evaluationContainerId?: string },
  ): Promise<void> {
    const value: RunState = {
      schemaVersion: 1,
      runId: this.#runId,
      pid: process.pid,
      taskId: task.id,
      image,
      ...(state.agentContainerId === undefined ? {} : { agentContainerId: state.agentContainerId }),
      ...(state.evaluationContainerId === undefined
        ? {}
        : { evaluationContainerId: state.evaluationContainerId }),
      updatedAt: new Date().toISOString(),
    };
    await this.#store.writeRunState(value);
  }

  /** 读取本次 Minicode checkout 的 git SHA。 */
  async #gitSha(): Promise<string> {
    const result = await runCommand(["git", "rev-parse", "HEAD"], {
      cwd: this.#repositoryRoot,
      timeoutMs: 10_000,
    });
    return result.exitCode === 0 ? result.stdout.trim() : "unknown";
  }
}
