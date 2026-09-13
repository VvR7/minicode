import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RunId, SessionId } from "@minicode/protocol";
import type { EventBus } from "../events/event-bus.ts";
import type { EventStore } from "../events/event-store.ts";
import type { LlmUsage } from "../llm/types.ts";

interface RunIdentity {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** 扫描 sessions 目录，返回全部存在的 run 标识（不校验 UUID，交给 store.read 过滤）。 */
async function findRunIdentities(homeDirectory: string): Promise<RunIdentity[]> {
  const sessionsDir = join(homeDirectory, "sessions");
  let sessionEntries: Dirent[];
  try {
    sessionEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const identities: RunIdentity[] = [];
  for (const session of sessionEntries) {
    if (!session.isDirectory()) {
      continue;
    }
    const runsDir = join(sessionsDir, session.name, "runs");
    let runEntries: Dirent[];
    try {
      runEntries = await readdir(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runEntries) {
      if (run.isDirectory()) {
        identities.push({
          sessionId: session.name as SessionId,
          runId: run.name as RunId,
        });
      }
    }
  }
  return identities;
}

/** 从 durable 事件估算已完成的步数与累计用量。 */
function summarize(events: readonly AgentEvent[]): { steps: number; usage: LlmUsage } {
  let steps = 0;
  const usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const event of events) {
    if (event.type === "step.finished") {
      steps = Math.max(steps, event.payload.step);
    } else if (event.type === "llm.usage") {
      usage.inputTokens += event.payload.inputTokens;
      usage.outputTokens += event.payload.outputTokens;
      usage.cacheReadInputTokens += event.payload.cacheReadInputTokens;
      usage.cacheCreationInputTokens += event.payload.cacheCreationInputTokens;
    }
  }
  return { steps, usage };
}

async function publishCoreRestarted(
  bus: EventBus,
  sessionId: SessionId,
  runId: RunId,
  steps: number,
  usage: LlmUsage,
): Promise<void> {
  const result = await bus.publish({
    sessionId,
    runId,
    timestamp: new Date().toISOString(),
    durable: true,
    type: "run.finished",
    payload: {
      status: "failed",
      reason: "core_restarted",
      finalText: "",
      steps,
      usage,
    },
  } as Parameters<EventBus["publish"]>[0]);
  if (!result.ok) {
    throw new Error(result.error.code);
  }
}

/**
 * startup 时把没有 run.finished 的 journal 补记为 core_restarted。
 * 幂等：已终态的 run 会跳过；补记失败向上抛，由 CoreApp 记录日志。
 */
export async function markIncompleteRunsRestarted(
  bus: EventBus,
  store: EventStore,
  homeDirectory: string,
): Promise<void> {
  for (const { sessionId, runId } of await findRunIdentities(homeDirectory)) {
    const read = await store.read(sessionId, runId);
    if (!read.ok || read.value.finished) {
      continue;
    }
    const { steps, usage } = summarize(read.value.events);
    await publishCoreRestarted(bus, sessionId, runId, steps, usage);
  }
}
