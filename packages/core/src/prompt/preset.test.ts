import { describe, expect, test } from "vitest";
import { parseCardJson } from "../card/import.ts";
import { openAiChatRequest } from "../llm/openai.ts";
import { DocStore } from "../store/doc-store.ts";
import { nodeSqliteDriver } from "../testing/node-sqlite.ts";
import { buildChatPrompt } from "./chat-prompt.ts";
import {
  activePreset,
  importPreset,
  listPresets,
  movedPresetPrompts,
  PresetImportError,
  parseStPreset,
  presetSampling,
  removePreset,
  setActivePreset,
} from "./preset.ts";

// 自己写的测试预设，字段照着 SillyTavern 导出的聊天补全预设
const marker = (identifier: string) => ({ identifier, name: identifier, marker: true });
const raw = {
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      role: "system",
      content: "你是写手，和 {{user}} 合写。",
    },
    marker("worldInfoBefore"),
    marker("personaDescription"),
    marker("charDescription"),
    marker("charPersonality"),
    marker("scenario"),
    { identifier: "nsfw", name: "Auxiliary Prompt", role: "system", content: "关掉的条目" },
    { identifier: "style", name: "文风", role: "system", content: "短句，少形容词。" },
    marker("worldInfoAfter"),
    marker("dialogueExamples"),
    marker("chatHistory"),
    {
      identifier: "note",
      name: "作者注释",
      role: "system",
      content: "现在在下雨。",
      injection_position: 1,
      injection_depth: 2,
    },
    {
      identifier: "nudge",
      name: "提醒",
      role: "user",
      content: "（记得写 {{char}} 的动作）",
      injection_position: 1,
      injection_depth: 0,
    },
    {
      identifier: "jailbreak",
      name: "Post-History Instructions",
      role: "system",
      content: "写之前自检。",
    },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: "main", enabled: true }] },
    {
      character_id: 100001,
      order: [
        "main",
        "worldInfoBefore",
        "personaDescription",
        "charDescription",
        "charPersonality",
        "scenario",
        "nsfw",
        "style",
        "worldInfoAfter",
        "dialogueExamples",
        "chatHistory",
        "note",
        "nudge",
        "jailbreak",
      ].map((identifier) => ({ identifier, enabled: identifier !== "nsfw" })),
    },
  ],
  personality_format: "[{{char}} 的性格：{{personality}}]",
  temperature: 1,
};
const preset = parseStPreset(raw);

const card = parseCardJson({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "小橘",
    description: "{{char}} 是书店的橘猫。",
    personality: "懒",
    scenario: "雨天的书店。",
    first_mes: "喵。",
    mes_example: "<START>\n{{user}}: 下来\n{{char}}: 不要。",
    character_book: {
      entries: [
        { keys: [], content: "书店在巷子尽头。", constant: true, position: "before_char" },
        { keys: ["小鱼干"], content: "小鱼干在抽屉里。" },
      ],
    },
  },
}).card.data;

const history = [
  { role: "assistant" as const, content: "喵。" },
  { role: "user" as const, content: "给你小鱼干" },
];
const build = (over: Partial<Parameters<typeof buildChatPrompt>[0]> = {}) =>
  buildChatPrompt({
    card,
    userName: "阿叶",
    persona: "{{user}} 是店员。",
    history,
    preset,
    ...over,
  });

describe("SillyTavern 预设", () => {
  test("按全局顺序（100001）拼；带深度的条目挪到聊天记录之后；和标准答案逐字相同", async () => {
    const messages = build();
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "system",
      "user",
      "system",
    ]);
    expect(messages[3]?.content).toBe("小鱼干在抽屉里。\n\n现在在下雨。");
    expect(messages[4]?.content).toBe("（记得写 小橘 的动作）");
    expect(messages[5]?.content).toBe("写之前自检。");
    const body = openAiChatRequest(
      { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
      messages,
    ).body;
    await expect(`${body}\n`).toMatchFileSnapshot("./__golden__/preset-card.json");
  });

  test("关掉的条目不出现，main 关不掉", () => {
    const off = parseStPreset({
      ...raw,
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: false },
            { identifier: "style", enabled: false },
            { identifier: "chatHistory", enabled: true },
          ],
        },
      ],
    });
    const [system] = build({ preset: off });
    expect(system?.content).toBe("你是写手，和 阿叶 合写。\n\n[Start a new Chat]");
  });

  test("卡片的系统提示覆盖 main（{{original}} 是预设原文），forbid_overrides 时不覆盖", () => {
    const withPrompt = { ...card, system_prompt: "{{original}} 用第三人称。" };
    expect(build({ card: withPrompt })[0]?.content.split("\n\n")[0]).toBe(
      "你是写手，和 阿叶 合写。 用第三人称。",
    );
    const locked = parseStPreset({
      ...raw,
      prompts: raw.prompts.map((p) =>
        p.identifier === "main" ? { ...p, forbid_overrides: true } : p,
      ),
    });
    expect(build({ card: withPrompt, preset: locked })[0]?.content.split("\n\n")[0]).toBe(
      "你是写手，和 阿叶 合写。",
    );
  });

  test("列出被挪动的条目，原位置还在条目上", () => {
    expect(movedPresetPrompts(preset).map((p) => [p.name, p.injection_depth])).toEqual([
      ["作者注释", 2],
      ["提醒", 0],
    ]);
  });

  test("连续两轮：聊天记录之前的部分和旧消息不变（缓存能命中）", () => {
    const a = build();
    const b = build({
      history: [
        ...history,
        { role: "assistant", content: "喵？" },
        { role: "user", content: "嗯" },
      ],
    });
    expect(b.slice(0, 3)).toEqual(a.slice(0, 3));
  });

  test("采样参数：只取认识的几个，写错类型的不发", () => {
    expect(presetSampling(preset)).toEqual({ temperature: 1 });
    expect(
      presetSampling(
        parseStPreset({
          ...raw,
          temperature: "热",
          top_p: 0.9,
          openai_max_tokens: 8192,
          top_k: 40,
        }),
      ),
    ).toEqual({ top_p: 0.9, maxTokens: 8192 });
  });

  test("不是预设的 JSON 报错", () => {
    expect(() => parseStPreset({ name: "小橘", first_mes: "喵" })).toThrow(PresetImportError);
  });

  test("存储：导入、列出、选中；选空字符串表示不用预设", async () => {
    const store = await DocStore.open(nodeSqliteDriver(), "dev-a");
    expect(await activePreset(store)).toBeUndefined();
    const id = await importPreset(store, JSON.stringify(raw), "测试预设");
    await expect(importPreset(store, "{", "坏的")).rejects.toThrow("invalid_json");
    await expect(importPreset(store, '{"prompts":"x"}', "坏的")).rejects.toThrow("invalid_preset");
    expect(await listPresets(store)).toEqual([{ id, name: "测试预设" }]);
    await setActivePreset(store, id);
    expect((await activePreset(store))?.preset.personality_format).toBe(raw.personality_format);
    await setActivePreset(store, "");
    expect(await activePreset(store)).toBeUndefined();
    await setActivePreset(store, id);
    await removePreset(store, id);
    expect(await listPresets(store)).toEqual([]);
    expect(await activePreset(store)).toBeUndefined();
  });
});
