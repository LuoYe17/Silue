// 角色卡自带的正则（SillyTavern 存在 extensions.regex_scripts 里），照 ST 的规则执行：
// markdownOnly 只改显示，promptOnly 只改发给模型的内容，两个都没勾的两处都改。
// ST 对两个都没勾的脚本是收到消息时直接改写存档；这里不改存档，显示和拼提示词时各跑一遍，效果一样，原文还在。
// shortcut: 只认角色卡里的正则，不支持全局正则和 Tavo 导出的正则文件，做正则管理界面时一起做
import { z } from "zod";
import type { CardData } from "../card/schema.ts";
import type { Role } from "../chat/tree.ts";

/** ST 的 placement：1 用户输入，2 AI 输出。其余（斜杠命令、世界书、思考内容）不处理 */
const ST_USER_INPUT = 1;
const ST_AI_OUTPUT = 2;

const depthLimit = z
  .number()
  .nullish()
  .catch(undefined)
  .transform((v) => v ?? undefined);

export const regexScriptSchema = z.looseObject({
  scriptName: z.string().catch(""),
  findRegex: z.string(),
  replaceString: z
    .string()
    .nullish()
    .catch("")
    .transform((v) => v ?? ""),
  trimStrings: z
    .array(z.string())
    .nullish()
    .catch([])
    .transform((v) => v ?? []),
  placement: z.array(z.number()).catch([]),
  disabled: z.boolean().nullish().catch(false),
  markdownOnly: z.boolean().nullish().catch(false),
  promptOnly: z.boolean().nullish().catch(false),
  substituteRegex: z.number().nullish().catch(0),
  minDepth: depthLimit,
  maxDepth: depthLimit,
});
export type RegexScript = z.infer<typeof regexScriptSchema>;

/** 卡片里的正则，格式不对的单条跳过 */
export function cardRegexScripts(card: CardData): RegexScript[] {
  const raw = card.extensions.regex_scripts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    const parsed = regexScriptSchema.safeParse(s);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface RegexContext {
  /** prompt：拼提示词；display：显示在界面上 */
  target: "prompt" | "display";
  role: Role;
  /** 离最新一条有几条，最新一条是 0 */
  depth: number;
  charName: string;
  userName: string;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fillNames(text: string, ctx: RegexContext, escaped = false): string {
  const wrap = escaped ? escapeRegex : (s: string) => s;
  return text
    .replace(/\{\{char\}\}/gi, () => wrap(ctx.charName))
    .replace(/\{\{user\}\}/gi, () => wrap(ctx.userName));
}

/** ST 的写法：/pattern/flags，不带斜杠的整串当正则；写错的返回 undefined */
export function parseFindRegex(source: string): RegExp | undefined {
  const slashed = source.match(/^\/([\s\S]+)\/([a-z]*)$/);
  try {
    return slashed ? new RegExp(slashed[1] ?? "", slashed[2]) : new RegExp(source);
  } catch {
    return undefined;
  }
}

function applies(script: RegexScript, ctx: RegexContext): boolean {
  if (script.disabled) return false;
  const placement = ctx.role === "user" ? ST_USER_INPUT : ST_AI_OUTPUT;
  if (ctx.role === "system" || !script.placement.includes(placement)) return false;
  if (ctx.target === "prompt" && script.markdownOnly) return false;
  if (ctx.target === "display" && script.promptOnly) return false;
  // ST：minDepth / maxDepth 为空或 -1 表示不限
  if (script.minDepth !== undefined && script.minDepth >= 0 && ctx.depth < script.minDepth) {
    return false;
  }
  return !(script.maxDepth !== undefined && script.maxDepth >= 0 && ctx.depth > script.maxDepth);
}

function runScript(script: RegexScript, text: string, ctx: RegexContext): string {
  // substituteRegex：0 不替换，1 把 {{char}} 等原样填进正则，2 转义后再填
  const source =
    script.substituteRegex === 1 || script.substituteRegex === 2
      ? fillNames(script.findRegex, ctx, script.substituteRegex === 2)
      : script.findRegex;
  const find = parseFindRegex(source);
  if (!find) return text;
  return text.replace(find, (...args: unknown[]) => {
    const groups = (typeof args.at(-1) === "object" ? args.at(-1) : undefined) as
      | Record<string, string | undefined>
      | undefined;
    // 和 ST 一样：{{match}} 等于 $0；引用到的分组先去掉 trimStrings 里的字符串
    const replaced = script.replaceString
      .replace(/\{\{match\}\}/gi, "$0")
      .replace(/\$(\d+)|\$<([^>]+)>/g, (_, num: string | undefined, name: string | undefined) => {
        const value = num !== undefined ? args[Number(num)] : groups?.[name ?? ""];
        if (typeof value !== "string" || value === "") return "";
        return script.trimStrings.reduce(
          (s, trim) => (trim ? s.replaceAll(fillNames(trim, ctx), "") : s),
          value,
        );
      });
    return fillNames(replaced, ctx);
  });
}

/** 按卡片里的顺序依次跑所有生效的正则 */
export function applyRegexScripts(scripts: RegexScript[], text: string, ctx: RegexContext): string {
  return scripts.reduce(
    (s, script) => (applies(script, ctx) ? runScript(script, s, ctx) : s),
    text,
  );
}
