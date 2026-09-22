/**
 * Core 执行超参数的唯一数值来源。
 *
 * 这里集中管理会影响 Agent、LLM、工具和 MCP 运行行为的默认值与预算。
 * 协议字段长度、持久化 schema 版本和安全策略不属于运行超参数，仍由各自模块维护。
 */
export const RUNTIME_CONFIG = {
  agent: {
    /** 主 Agent 单次 run 最多执行的模型步骤数。 */
    maxSteps: 200,
    /** 单个流式文本事件允许携带的最大字符数。 */
    textDeltaMaxChars: 16 * 1024,
    /** run.finished 中最终文本允许保留的最大字符数。 */
    finalTextMaxChars: 256 * 1024,
  },
  subagent: {
    /** 未显式配置 max_steps 时的默认模型步骤数。 */
    maxSteps: 50,
    /** 类型文件允许配置的最大模型步骤数。 */
    maxConfiguredSteps: 50,
    /** 单步并行工具结果回填模型时的正文总字节预算。 */
    parallelToolResultMaxBytes: 64 * 1024,
    /** 子执行审计中保留的最终文本最大字符数。 */
    finalTextMaxChars: 256 * 1024,
    /** 父事件流中子执行摘要的最大字符数。 */
    summaryMaxChars: 4 * 1024,
    /** 回传父 Agent 的结构化子执行正文最大字符数。 */
    resultContentMaxChars: 256 * 1024 - 2 * 1024,
  },
  llm: {
    /** 单次模型响应的默认最大输出 token 数。 */
    maxOutputTokens: 8192,
    /** 单次模型请求的默认超时。 */
    timeoutMs: 120_000,
    /** 首个 delta 前允许的最大请求次数。 */
    maxAttempts: 3,
    /** 可重试模型错误的退避间隔。 */
    retryBackoffMs: [1_000, 2_000] as readonly number[],
    /** 解析上游错误时读取的最大正文大小。 */
    errorBodyMaxBytes: 8 * 1024,
  },
  context: {
    /** 预检只使用上下文窗口的这一比例，为输出和估算误差留余量。 */
    safeRatio: 0.9,
    /** 自动压缩需要预留的默认 token 数。 */
    compactionReserveTokens: 16_384,
    /** 自动压缩后默认保留的近期上下文 token 数。 */
    compactionKeepRecentTokens: 20_000,
    /** 一次压缩允许重新生成摘要的总次数。 */
    compactionSummaryAttempts: 2,
    /** 每次摘要生成内部只发起一次 provider 请求，由压缩层统一决定重试。 */
    compactionProviderMaxAttempts: 1,
  },
  tool: {
    /** 单个工具结果进入模型上下文前的最大字节数。 */
    resultMaxBytes: 256 * 1024,
    /** 未声明专用超时时的默认工具超时。 */
    timeoutMs: 10_000,
    /** 可重试工具错误的最大执行次数。 */
    maxAttempts: 3,
    /** 可重试工具错误的退避间隔。 */
    retryDelaysMs: [2_000, 4_000] as readonly number[],
    /** read/bash 输出的默认最大行数。 */
    outputMaxLines: 2_000,
    /** read/bash 输出的默认最大字节数。 */
    outputMaxBytes: 50 * 1024,
    /** write/edit 单次允许处理的最大文件内容字节数。 */
    writeMaxBytes: 1024 * 1024,
    /** bash 命令文本允许的最大字符数。 */
    bashCommandMaxChars: 8 * 1024,
    /** bash 参数允许的最大秒数，也是默认执行时限。 */
    bashTimeoutSeconds: 120,
  },
  mcp: {
    /** MCP 连接、发现和调用的单次请求超时。 */
    requestTimeoutMs: 10_000,
    /** Streamable HTTP transport 的固定重连间隔。 */
    reconnectDelayMs: 1_000,
    /** 固定间隔重连，不做指数增长。 */
    reconnectDelayGrowFactor: 1,
    /** MCP 请求由上层显式决定是否重试，transport 默认不重试。 */
    maxReconnectAttempts: 0,
    /** 工具发现允许聚合的最大分页数。 */
    listMaxPages: Number.MAX_SAFE_INTEGER,
  },
} as const;
