import { BashTool } from "./bash.ts";
import { EditTool } from "./edit.ts";
import { WriteTool } from "./file-write.ts";
import { ReadTool } from "./read.ts";

/** 静态导入的四个通用 coding tools，由 AgentRunner 注册到 ToolRegistry。 */
export const builtinTools = [new ReadTool(), new WriteTool(), new EditTool(), new BashTool()];
