import { join } from "node:path";
import type { SecretRedactor } from "./redactor.ts";
import type { SweBenchTask } from "./types.ts";

interface HarnessResponse {
  readonly evalScript?: string;
  readonly [key: string]: unknown;
}

/** 通过固定 Python venv 调用官方 SWE-bench 代码，不在 TypeScript 重写判分。 */
export class OfficialHarness {
  readonly #python: string;
  readonly #helper: string;
  readonly #redactor: SecretRedactor;

  /** 绑定仓库 cache 中的固定 venv 与窄 Python adapter。 */
  constructor(repositoryRoot: string, redactor: SecretRedactor) {
    this.#python = join(repositoryRoot, ".cache", "swe-bench", "venv", "bin", "python");
    this.#helper = join(repositoryRoot, "scripts", "swe-bench", "official_harness.py");
    this.#redactor = redactor;
  }

  /** 使用官方 TestSpec 生成含测试退出码标记的 eval script。 */
  async prepare(task: SweBenchTask, image: string): Promise<string> {
    const response = await this.#invoke({ action: "prepare", task: { ...task, image } });
    if (typeof response.evalScript !== "string")
      throw new Error("official harness returned no eval script");
    return response.evalScript;
  }

  /** 使用官方 log parser 和 grading 生成逐测试报告。 */
  async grade(
    task: SweBenchTask,
    image: string,
    modelPatch: string,
    evaluationLog: string,
  ): Promise<unknown> {
    return this.#invoke({
      action: "grade",
      task: { ...task, image },
      modelPatch,
      evaluationLog,
    });
  }

  /** 通过 stdin 传请求，避免题面或 patch 进入宿主命令行。 */
  async #invoke(payload: unknown): Promise<HarnessResponse> {
    const child = Bun.spawn([this.#python, this.#helper], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, PYTHONNOUSERSITE: "1" },
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(`official SWE-bench harness failed: ${this.#redactor.redact(stderr)}`);
    }
    return JSON.parse(stdout) as HarnessResponse;
  }
}
