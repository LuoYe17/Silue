import { describe, expect, test } from "vitest";
import { parseCardJson } from "../card/import.ts";
import { lorebookSchema } from "../card/schema.ts";
import { openAiChatRequest } from "../llm/openai.ts";
import { buildChatPrompt } from "./chat-prompt.ts";
import { activeLore } from "./lorebook.ts";

// 自己写的测试世界书，字段照着 SillyTavern 导出的格式（extensions 里的 position、depth、scan_depth……）
const book = lorebookSchema.parse({
  scan_depth: 2,
  entries: [
    {
      content: "书店在老城区的巷子尽头。",
      keys: [],
      constant: true,
      position: "after_char",
      insertion_order: 10,
    },
    {
      content: "店主是个戴眼镜的老人。",
      keys: [],
      constant: true,
      position: "before_char",
      insertion_order: 5,
    },
    {
      content: "【规则】每次回复都以猫的视角结尾。",
      keys: [],
      constant: true,
      insertion_order: 100,
      extensions: { position: 4, depth: 1 },
    },
    {
      content: "小鱼干放在柜台第二个抽屉里。",
      keys: ["小鱼干", "零食"],
      insertion_order: 20,
    },
    {
      content: "【OOC】用户在场外说话，暂停剧情回答。",
      keys: ["ooc", "场外"],
      insertion_order: 101,
      extensions: { scan_depth: 1 },
    },
    {
      content: "只在下雨且提到窗户时出现。",
      keys: ["窗户"],
      selective: true,
      secondary_keys: ["雨"],
      insertion_order: 30,
    },
    { content: "关掉的条目", keys: ["小鱼干"], enabled: false },
    { content: "Cat 整词", keys: ["cat"], extensions: { match_whole_words: true } },
    { content: "正则条目", keys: ["/喵{2,}/"], insertion_order: 40 },
    { content: "一半概率", keys: ["抽签"], extensions: { probability: 50, useProbability: true } },
  ],
});

const lore = (...messages: string[]) =>
  activeLore({ book, history: messages.map((content) => ({ content })), random: () => 0.9 });

describe("世界书", () => {
  test("常驻条目：before_char / after_char 进不变区，@D 的放到聊天记录之后", () => {
    expect(lore("你好")).toEqual({
      before: ["店主是个戴眼镜的老人。"],
      after: ["书店在老城区的巷子尽头。"],
      tail: ["【规则】每次回复都以猫的视角结尾。"],
    });
  });

  test("关键词触发的放到最后，按 insertion_order 从小到大；关掉的不触发", () => {
    expect(lore("喵", "给你小鱼干", "OOC 一下").tail).toEqual([
      "小鱼干放在柜台第二个抽屉里。",
      "【规则】每次回复都以猫的视角结尾。",
      "【OOC】用户在场外说话，暂停剧情回答。",
    ]);
  });

  test("只扫最近几条：书默认 2 条，条目自己的 scan_depth 优先", () => {
    expect(lore("给你小鱼干", "嗯", "嗯").tail).not.toContain("小鱼干放在柜台第二个抽屉里。");
    expect(lore("场外", "嗯").tail).not.toContain("【OOC】用户在场外说话，暂停剧情回答。");
  });

  test("selective：主关键词和副关键词都要命中", () => {
    expect(lore("关上窗户").tail).not.toContain("只在下雨且提到窗户时出现。");
    expect(lore("下雨了，关上窗户").tail).toContain("只在下雨且提到窗户时出现。");
  });

  test("整词匹配、正则关键词、默认不区分大小写", () => {
    expect(lore("a CAT here").tail).toContain("Cat 整词");
    expect(lore("concatenate").tail).not.toContain("Cat 整词");
    expect(lore("喵喵喵").tail).toContain("正则条目");
    expect(lore("喵").tail).not.toContain("正则条目");
  });

  test("按概率触发：抽签结果大于概率就不生效", () => {
    expect(lore("抽签").tail).not.toContain("一半概率");
    expect(activeLore({ book, history: [{ content: "抽签" }], random: () => 0.1 }).tail).toContain(
      "一半概率",
    );
  });

  test("拼进请求：常驻在系统提示里，触发的在聊天记录之后；和标准答案逐字相同", async () => {
    const card = parseCardJson({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "小橘",
        description: "{{char}} 是一只橘猫。",
        first_mes: "喵。",
        character_book: book,
        post_history_instructions: "保持简短。",
      },
    }).card.data;
    const messages = buildChatPrompt({
      card,
      userName: "阿叶",
      history: [
        { role: "assistant", content: "喵。" },
        { role: "user", content: "给你小鱼干" },
      ],
      random: () => 0.9,
    });
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "system",
      "system",
    ]);
    const body = openAiChatRequest(
      { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
      messages,
    ).body;
    await expect(`${body}\n`).toMatchFileSnapshot("./__golden__/lorebook-card.json");
  });

  test("触发的条目变了，聊天记录之前的部分不变（缓存仍能命中）", () => {
    const card = parseCardJson({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { name: "小橘", first_mes: "喵。", character_book: book },
    }).card.data;
    const prompt = (text: string) =>
      buildChatPrompt({ card, userName: "阿叶", history: [{ role: "user", content: text }] });
    const [a, b] = [prompt("你好"), prompt("给你小鱼干")];
    // 系统提示（不变区）逐字相同，变的只有聊天记录之后的那条
    expect(b[0]).toEqual(a[0]);
    expect(a.at(-1)?.content).toBe("【规则】每次回复都以猫的视角结尾。");
    expect(b.at(-1)?.content).toBe(
      "小鱼干放在柜台第二个抽屉里。\n\n【规则】每次回复都以猫的视角结尾。",
    );
  });
});
