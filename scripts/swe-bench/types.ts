export interface SweBenchTask {
  readonly id: string;
  readonly repo: string;
  readonly commit: string;
  readonly prompt: string;
  readonly testPatch: string;
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
  readonly version: string;
  readonly evalScript: string;
  readonly logParser: string;
  readonly evalType: string;
}

export interface TaskManifest {
  readonly schemaVersion: 1;
  readonly dataset: string;
  readonly datasetRevision: string;
  readonly sweBenchCommit: string;
  readonly taskAssetsCommit: string;
  readonly piBenchReferenceCommit: string;
  readonly taskIds: readonly string[];
}

export type TaskStatus = "resolved" | "failed" | "timeout" | "cleanup_failed";

export interface EvaluationResult {
  readonly attempted: boolean;
  readonly resolved: boolean;
  readonly report?: unknown;
  readonly reason?: string;
}

export interface CleanupResult {
  readonly succeeded: boolean;
  readonly attempts: number;
  readonly remainingContainers: readonly string[];
  readonly imagePresent: boolean;
  readonly errors: readonly string[];
}

export interface TaskResult {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly reason: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly image: string;
  readonly minicodeGitSha: string;
  readonly datasetRevision: string;
  readonly sweBenchCommit: string;
  readonly agentExitCode: number | null;
  readonly agentTimedOut: boolean;
  readonly evaluation: EvaluationResult;
  readonly cleanup: CleanupResult;
}

export interface RunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly taskId?: string;
  readonly image?: string;
  readonly agentContainerId?: string;
  readonly evaluationContainerId?: string;
  readonly updatedAt: string;
}

export interface RunnerOptions {
  readonly taskId?: string;
  readonly limit?: number;
  readonly resume: boolean;
  readonly force: boolean;
  readonly cleanupStale: boolean;
  readonly resultsDirectory: string;
  readonly agentTimeoutMs: number;
  readonly pullTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly evaluationTimeoutMs: number;
}

export interface Summary {
  readonly datasetTotal: number;
  readonly selected: number;
  readonly executed: number;
  readonly skipped: number;
  readonly total: number;
  readonly resolved: number;
  readonly failed: number;
  readonly timeout: number;
  readonly cleanupFailed: number;
  readonly resolveRate: number;
}
