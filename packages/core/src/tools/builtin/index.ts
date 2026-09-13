import { GlobTool } from "./glob.ts";
import { GrepTool } from "./grep.ts";
import { ReadFileTool } from "./read-file.ts";

/** 静态导入的只读内置工具目录，由 AgentRunner 注册到 ToolRegistry。 */
export const builtinTools = [new ReadFileTool(), new GlobTool(), new GrepTool()];
