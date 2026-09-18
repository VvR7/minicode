import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SKILL_LIST_METHOD,
  SkillListParamsSchema,
  type SkillListParams,
  type SkillListResult,
} from "@minicode/protocol";
import { loadSkills } from "../skills/loader.ts";
import { TypedRpcMethodHandler } from "./rpc-method-handler.ts";

/** 无会话副作用的技能目录查询入口。 */
export class SkillListHandler extends TypedRpcMethodHandler<SkillListParams, SkillListResult> {
  readonly method = SKILL_LIST_METHOD;
  readonly paramsSchema = SkillListParamsSchema;
  readonly #homeDirectory: string;

  /** 保存全局技能目录所属的 minicode home。 */
  constructor(homeDirectory: string) {
    super();
    this.#homeDirectory = homeDirectory;
  }

  /** 规范化工作区并返回元数据及有界诊断，不返回技能正文。 */
  protected async handle(params: SkillListParams): Promise<SkillListResult> {
    const absolute = resolve(params.workspaceRoot);
    const workspaceRoot = await realpath(absolute).catch(() => absolute);
    const catalog = await loadSkills(this.#homeDirectory, workspaceRoot);
    return {
      skills: catalog.skills.map(({ body: _body, ...metadata }) => metadata),
      diagnostics: catalog.diagnostics,
    };
  }
}
