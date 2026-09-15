import type {
  HistoryMessage,
  HistoryTurnReason,
  RunId,
  TaskGraphSnapshot,
  TurnId,
} from "@minicode/protocol";
import type { LlmMessage, LlmUsage } from "../llm/types.ts";

/** 在 provider-neutral 内容块扩展后强制调用方补齐映射。 */
function assertNever(value: never): never {
  throw new Error(`unsupported history content: ${String(value)}`);
}

/** run 的终态分类；interrupted 只由重启补偿产生，不出现在运行期 RunCompletion。 */
export type RunCompletionStatus = "succeeded" | "failed" | "cancelled";

/**
 * AgentRunner 结束一轮后返回的结构化终态。
 * 不发布 run.finished；唯一终态由编排层在 history 提交后统一发布。
 */
export interface RunCompletion {
  readonly status: RunCompletionStatus;
  readonly reason: HistoryTurnReason;
  readonly finalText: string;
  readonly steps: number;
  readonly usage: LlmUsage;
  /** 本轮完整 provider-neutral 消息（用户/助手/工具结果），由编排层补齐身份后落盘。 */
  readonly messages: readonly LlmMessage[];
  readonly model: string;
  readonly taskGraph?: TaskGraphSnapshot;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 把 provider 层的 LlmMessage 转换为协议层 HistoryMessage（补齐身份与时间戳）。 */
export function toHistoryMessages(
  messages: readonly LlmMessage[],
  turnId: TurnId,
  runId: RunId,
  now: () => string = () => new Date().toISOString(),
): HistoryMessage[] {
  return messages.map((message) => ({
    messageId: crypto.randomUUID(),
    turnId,
    runId,
    role: message.role,
    timestamp: now(),
    content: message.content.map((part) => {
      switch (part.type) {
        case "text":
          return { type: "text" as const, text: part.text };
        case "tool_use":
          return {
            type: "tool_use" as const,
            id: part.id,
            name: part.name,
            input: part.input,
          };
        case "tool_result":
          return {
            type: "tool_result" as const,
            toolUseId: part.toolUseId,
            content: part.content,
            ...(part.isError === undefined ? {} : { isError: part.isError }),
          };
        default:
          return assertNever(part);
      }
    }),
  }));
}
