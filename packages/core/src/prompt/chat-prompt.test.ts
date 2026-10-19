import { describe, expect, test } from "vitest";
import { parseCardJson } from "../card/import.ts";
import { openAiChatRequest } from "../llm/openai.ts";
import { buildChatPrompt, DEFAULT_MAIN_PROMPT, replaceMacros } from "./chat-prompt.ts";

// 自己写的测试卡，不用开发者的真实卡片（含成人内容，不进公开仓库）
const card = parseCardJson({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "小橘",
    description: "{{char}} 是一只住在书店的橘猫，喜欢趴在 {{user}} 的键盘上。",
    personality: "懒散，嘴硬",
    scenario: "下雨的午后，书店里没有客人。",
    first_mes: "*{{char}} 抬起头看了 {{user}} 一眼* 喵。",
    mes_example: "<START>\n{{user}}: 下来\n{{char}}: 不要。",
    system_prompt: "",
    post_history_instructions: "",
  },
}).card.data;

describe("buildChatPrompt", () => {
  test("拼好的请求和标准答案逐字相同", async () => {
    const messages = buildChatPrompt({
      card,
      userName: "阿叶",
      history: [
        { role: "assistant", content: card.first_mes },
        { role: "user", content: "摸摸头" },
      ],
    });
    const request = openAiChatRequest(
      { baseUrl: "https://api.example.com", apiKey: "test-key", model: "gemini-3.8-flash" },
      messages,
    );
    // 有意改提示词拼法时，跑 npm test -- -u 更新，并在提交里写明原因
    await expect(`${request.body}\n`).toMatchFileSnapshot("./__golden__/basic-card.json");
  });

  test("连续两轮：第二轮的请求以第一轮为前缀，只在后面追加（缓存能命中）", () => {
    const round1 = [
      { role: "assistant" as const, content: card.first_mes },
      { role: "user" as const, content: "摸摸头" },
    ];
    const round2 = [
      ...round1,
      { role: "assistant" as const, content: "*尾巴甩了一下*" },
      { role: "user" as const, content: "给你小鱼干" },
    ];
    const config = { baseUrl: "https://api.example.com", apiKey: "k", model: "m" };
    const body1 = openAiChatRequest(
      config,
      buildChatPrompt({ card, userName: "阿叶", history: round1 }),
    ).body;
    const body2 = openAiChatRequest(
      config,
      buildChatPrompt({ card, userName: "阿叶", history: round2 }),
    ).body;
    // 消息数组在 body 末尾之前结束：去掉第一轮最后的 "]..." 部分，剩下的应当是第二轮的前缀
    const prefix = body1.slice(0, body1.lastIndexOf("}]") + 1);
    expect(body2.startsWith(prefix)).toBe(true);
  });

  test("卡片自带系统提示时替换默认的，{{original}} 换成默认提示", () => {
    const withPrompt = { ...card, system_prompt: "{{original}} 用中文。" };
    const [system] = buildChatPrompt({ card: withPrompt, userName: "阿叶", history: [] });
    expect(
      system?.content.startsWith(`${replaceMacros(DEFAULT_MAIN_PROMPT, "小橘", "阿叶")} 用中文。`),
    ).toBe(true);
  });

  test("post_history_instructions 放在聊天记录之后；空字段不出现", () => {
    const messages = buildChatPrompt({
      card: { ...card, personality: "", post_history_instructions: "保持简短。" },
      userName: "阿叶",
      history: [{ role: "user", content: "嗨" }],
    });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(messages[2]?.content).toBe("保持简短。");
    expect(messages[0]?.content).not.toContain("personality");
  });

  test("用户人设放在角色描述前面，里面的宏也替换", () => {
    const [system] = buildChatPrompt({
      card,
      userName: "阿叶",
      persona: "{{user}} 是书店的店员，对猫过敏。",
      history: [],
    });
    expect(system?.content.split("\n\n").slice(1, 3)).toEqual([
      "阿叶 是书店的店员，对猫过敏。",
      "小橘 是一只住在书店的橘猫，喜欢趴在 阿叶 的键盘上。",
    ]);
  });

  test("宏不区分大小写，V1 的 <BOT> <USER> 也换", () => {
    expect(replaceMacros("{{Char}} <BOT> {{USER}} <user>", "猫", "人")).toBe("猫 猫 人 人");
  });
});
