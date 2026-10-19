import { describe, expect, test } from "vitest";
import { openAiChatRequest } from "./openai.ts";
import { reasoningEffort, THINKING_LEVELS, thinkingDialect } from "./thinking.ts";

const BASES = {
  deepseek: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openai: "https://api.example.com",
};

describe("思考深度", () => {
  test("按接口地址认出是哪家", () => {
    expect(thinkingDialect("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(thinkingDialect(" HTTPS://API.DEEPSEEK.COM ")).toBe("deepseek");
    expect(thinkingDialect(BASES.gemini)).toBe("gemini");
    expect(thinkingDialect("https://relay.example.com/deepseek")).toBe("openai");
    expect(thinkingDialect("")).toBe("openai");
  });

  test("每家每个档位实际发出的参数和标准答案逐字相同", async () => {
    const lines = Object.entries(BASES).flatMap(([dialect, baseUrl]) =>
      THINKING_LEVELS.map((level) => {
        const body = openAiChatRequest(
          { baseUrl, apiKey: "k", model: "m", thinking: level },
          [],
        ).body;
        return `${dialect} ${level} -> ${body.slice(body.indexOf('"stream_options"'))}`;
      }),
    );
    // 有意改换算表时，跑 npm test -- -u 更新，并在提交里写明原因
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./__golden__/thinking-levels.txt");
  });

  test("default 不发 reasoning_effort，请求体和没有思考设置时完全一样", () => {
    const config = { baseUrl: BASES.deepseek, apiKey: "k", model: "m" };
    expect(reasoningEffort(config.baseUrl, "default")).toBeUndefined();
    expect(openAiChatRequest({ ...config, thinking: "default" }, []).body).toBe(
      openAiChatRequest(config, []).body,
    );
    expect(openAiChatRequest(config, []).body).not.toContain("reasoning_effort");
  });
});
