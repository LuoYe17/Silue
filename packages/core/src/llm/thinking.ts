// 思考深度：界面上只有一组档位，按接口换算成那家的 reasoning_effort。
// 设计见 .agents/notes/proposed/feature/2026-10-19-thinking-depth-levels.md，
// 换算依据见 .agents/notes/implemented/feature/2026-10-19-thinking-levels.md

/** default 表示不发参数，由模型自己决定；其余档位一定会发 */
export const THINKING_LEVELS = ["default", "off", "low", "medium", "high", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 按接口地址认出是哪家，换算表不同。中转站一律当作通用的 OpenAI 兼容接口 */
export type ThinkingDialect = "deepseek" | "gemini" | "openai";

type Effort = string;

const TABLES: Record<ThinkingDialect, Record<Exclude<ThinkingLevel, "default">, Effort>> = {
  // https://api-docs.deepseek.com/api/create-chat-completion ：none / low / high / max，没有中档
  deepseek: { off: "none", low: "low", medium: "high", high: "high", max: "max" },
  // https://ai.google.dev/gemini-api/docs/openai ：minimal / low / medium / high，没有最大档；
  // 文档说 none 只对 2.5 系列有效，2.5 Pro 和 3 系列关不掉思考
  gemini: { off: "none", low: "low", medium: "medium", high: "high", max: "high" },
  // https://developers.openai.com/api/docs/guides/reasoning ：取值随模型不同，同名直接发，不支持的由接口报错
  openai: { off: "none", low: "low", medium: "medium", high: "high", max: "max" },
};

export function thinkingDialect(baseUrl: string): ThinkingDialect {
  const host =
    baseUrl
      .trim()
      .match(/^https?:\/\/([^/:]+)/i)?.[1]
      ?.toLowerCase() ?? "";
  if (host === "api.deepseek.com") return "deepseek";
  if (host === "generativelanguage.googleapis.com") return "gemini";
  return "openai";
}

/** 实际要发的 reasoning_effort；undefined 表示不发 */
export function reasoningEffort(baseUrl: string, level: ThinkingLevel): Effort | undefined {
  return level === "default" ? undefined : TABLES[thinkingDialect(baseUrl)][level];
}
