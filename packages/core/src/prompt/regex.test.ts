import { describe, expect, test } from "vitest";
import { parseCardJson } from "../card/import.ts";
import { openAiChatRequest } from "../llm/openai.ts";
import { buildChatPrompt } from "./chat-prompt.ts";
import {
  applyRegexScripts,
  cardRegexScripts,
  parseFindRegex,
  type RegexContext,
  regexScriptSchema,
} from "./regex.ts";

// 自己写的测试正则，字段照着 SillyTavern 导出的格式；写法仿照状态栏卡常见的几种
const scripts = [
  {
    scriptName: "状态栏外框",
    findRegex: "/<status>\\s*([\\s\\S]*?)\\s*<\\/status>/g",
    replaceString: '<div class="status">$1</div>',
    placement: [2],
    markdownOnly: true,
  },
  {
    scriptName: "对话上色",
    findRegex: "/「([^「」\\n]+)」/g",
    replaceString: '<span style="color:#e8d6a8">「$1」</span>',
    placement: [1, 2],
    markdownOnly: true,
  },
  {
    scriptName: "删旧状态",
    findRegex: "/<status>[\\s\\S]*?<\\/status>/g",
    replaceString: "",
    placement: [2],
    promptOnly: true,
    minDepth: 2,
  },
  {
    scriptName: "两处都改",
    findRegex: "/喵+/g",
    replaceString: "喵",
    placement: [2],
  },
  { scriptName: "关掉的", findRegex: "/喵/g", replaceString: "汪", placement: [2], disabled: true },
  { scriptName: "写错的", findRegex: "/(/g", replaceString: "x", placement: [2] },
];

const card = parseCardJson({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "小橘",
    first_mes: "喵喵喵。\n<status>饱腹：80</status>",
    extensions: { regex_scripts: [...scripts, { scriptName: "缺 findRegex" }] },
  },
}).card.data;

const parsed = cardRegexScripts(card);
const ctx = (over: Partial<RegexContext> = {}): RegexContext => ({
  target: "display",
  role: "assistant",
  depth: 0,
  charName: "小橘",
  userName: "阿叶",
  ...over,
});

describe("正则", () => {
  test("读卡片里的正则：格式不对的单条跳过，写错的正则运行时跳过", () => {
    expect(parsed.map((s) => s.scriptName)).toEqual(scripts.map((s) => s.scriptName));
    expect(parseFindRegex("/(/g")).toBeUndefined();
    expect(parseFindRegex("abc")?.source).toBe("abc");
    expect(parseFindRegex("/a\\/b/gi")?.flags).toBe("gi");
  });

  test("markdownOnly 只改显示，promptOnly 只改提示词，都没勾的两处都改", () => {
    const text = "喵喵喵「你好」\n<status>饱腹：80</status>";
    expect(applyRegexScripts(parsed, text, ctx({ depth: 3 }))).toBe(
      '喵<span style="color:#e8d6a8">「你好」</span>\n<div class="status">饱腹：80</div>',
    );
    expect(applyRegexScripts(parsed, text, ctx({ target: "prompt", depth: 3 }))).toBe(
      "喵「你好」\n",
    );
  });

  test("placement：1 只改用户消息，2 只改 AI 消息；system 不改", () => {
    expect(applyRegexScripts(parsed, "喵喵「嗨」", ctx({ role: "user" }))).toBe(
      '喵喵<span style="color:#e8d6a8">「嗨」</span>',
    );
    expect(applyRegexScripts(parsed, "喵喵", ctx({ role: "system" }))).toBe("喵喵");
  });

  test("minDepth：离最新一条不到 2 条的不删", () => {
    const run = (depth: number) =>
      applyRegexScripts(parsed, "a<status>x</status>", ctx({ target: "prompt", depth }));
    expect([run(0), run(1), run(2), run(5)]).toEqual([
      "a<status>x</status>",
      "a<status>x</status>",
      "a",
      "a",
    ]);
  });

  test("替换写法：$1、{{match}}、命名分组、trimStrings、{{user}}、substituteRegex", () => {
    const one = (script: Record<string, unknown>, text: string) =>
      applyRegexScripts([regexScriptSchema.parse({ placement: [2], ...script })], text, ctx());
    expect(one({ findRegex: "/(\\d+)分/", replaceString: "[{{match}}|$1|$2]" }, "得了 90分")).toBe(
      "得了 [90分|90|]",
    );
    expect(one({ findRegex: "/(?<n>\\d+)/", replaceString: "<$<n>>" }, "7")).toBe("<7>");
    expect(
      one(
        { findRegex: "/<b>(.*?)<\\/b>/", replaceString: "$1", trimStrings: ["*"] },
        "<b>*重*</b>",
      ),
    ).toBe("重");
    expect(one({ findRegex: "/你/g", replaceString: "{{user}}" }, "你好")).toBe("阿叶好");
    expect(
      one({ findRegex: "/{{char}}/g", replaceString: "她", substituteRegex: 1 }, "小橘睡了"),
    ).toBe("她睡了");
  });

  test("拼进请求：旧消息里的状态栏被删，最近的保留；和标准答案逐字相同", async () => {
    const history = [
      { role: "assistant" as const, content: card.first_mes },
      { role: "user" as const, content: "摸摸头「乖」" },
      { role: "assistant" as const, content: "喵喵～\n<status>饱腹：70</status>" },
      { role: "user" as const, content: "继续" },
    ];
    const messages = buildChatPrompt({ card, userName: "阿叶", history });
    expect(messages.map((m) => m.content)).toEqual([
      expect.any(String),
      "喵。\n",
      "摸摸头「乖」",
      "喵～\n<status>饱腹：70</status>",
      "继续",
    ]);
    const body = openAiChatRequest(
      { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
      messages,
    ).body;
    await expect(`${body}\n`).toMatchFileSnapshot("./__golden__/regex-card.json");
  });

  test("按深度删旧内容，缓存只在最近几条失效", () => {
    const turn = (n: number) =>
      buildChatPrompt({
        card,
        userName: "阿叶",
        history: Array.from({ length: n }, (_, i) =>
          i % 2 === 0
            ? { role: "assistant" as const, content: `第${i}条<status>${i}</status>` }
            : { role: "user" as const, content: "继续" },
        ),
      });
    const [a, b] = [turn(7), turn(9)];
    // 上一轮离最新不到 2 条的状态栏这一轮才删，变的只有那一条（第 7 条消息）；它前面逐字不变
    expect(b.slice(0, 7)).toEqual(a.slice(0, 7));
    expect(b[7]).not.toEqual(a[7]);
  });
});
