import { describe, expect, test } from "vitest";
import {
  chatCompletionsUrl,
  openAiChatRequest,
  ProviderError,
  parseOpenAiEvent,
  providerHttpError,
  SseDecoder,
  type StreamEvent,
} from "./openai.ts";

// 2026-10-19 一个 OpenAI 兼容中转站对 gemini-3.8-flash 的真实流式返回（id 截短）
const relayStream = `data: {"id":"msg_1","object":"chat.completion.chunk","created":1792420257,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"msg_1","object":"chat.completion.chunk","created":1792420257,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"喵呜~（软软地凑"},"finish_reason":null}]}

data: {"id":"msg_1","object":"chat.completion.chunk","created":1792420257,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"过来）你好呀"},"finish_reason":null}]}

data: {"id":"msg_1","object":"chat.completion.chunk","created":1792420257,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}

data: {"id":"msg_1","object":"chat.completion.chunk","created":1792420257,"model":"gemini-3.8-flash","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":406,"total_tokens":419}}

data: [DONE]

`;

const decodeAll = (chunks: string[]): StreamEvent[] => {
  const decoder = new SseDecoder();
  const data = [...chunks.flatMap((c) => decoder.push(c)), ...decoder.end()];
  return data.flatMap(parseOpenAiEvent);
};

describe("chatCompletionsUrl", () => {
  test.each([
    ["https://api.example.com", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/v1", "https://api.example.com/v1/chat/completions"],
    [
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    ],
    ["https://x.com/v1/chat/completions", "https://x.com/v1/chat/completions"],
  ])("%s", (base, url) => {
    expect(chatCompletionsUrl(base)).toBe(url);
  });
});

describe("openAiChatRequest", () => {
  test("请求内容和标准答案逐字相同", async () => {
    const request = openAiChatRequest(
      { baseUrl: "https://api.example.com", apiKey: " test-key ", model: "gemini-3.8-flash" },
      [
        { role: "system", content: "你是一只猫。" },
        { role: "user", content: "打个招呼" },
      ],
    );
    const golden = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body}\n`;
    // 有意改请求内容时，跑 npm test -- -u 更新，并在提交里写明原因
    await expect(golden).toMatchFileSnapshot("./__golden__/openai-chat-request.txt");
  });
});

describe("流式解析", () => {
  test("中转站的真实返回：文字、结束原因、用量", () => {
    expect(decodeAll([relayStream])).toEqual([
      { type: "text", text: "喵呜~（软软地凑" },
      { type: "text", text: "过来）你好呀" },
      { type: "finish", reason: "stop" },
      { type: "usage", usage: { input: 13, output: 406 } },
    ]);
  });

  test("切成任意小块收到，结果一样；兼容 CRLF", () => {
    const crlf = relayStream.replaceAll("\n", "\r\n");
    const chunks = crlf.match(/[\s\S]{1,7}/g) ?? [];
    expect(decodeAll(chunks)).toEqual(decodeAll([relayStream]));
  });

  test("最后一个事件后面没有空行也能读出来", () => {
    expect(decodeAll(['data: {"choices":[{"delta":{"content":"a"}}]}'])).toEqual([
      { type: "text", text: "a" },
    ]);
  });

  test("思考内容（reasoning_content / reasoning）和缓存、思考用量", () => {
    expect(
      decodeAll([
        'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"再想"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":30}}}\n\n',
      ]),
    ).toEqual([
      { type: "reasoning", text: "想" },
      { type: "reasoning", text: "再想" },
      { type: "usage", usage: { input: 100, output: 50, cachedInput: 80, reasoning: 30 } },
    ]);
  });

  test("注释行和其他字段忽略", () => {
    expect(
      decodeAll([': ping\nevent: x\nid: 1\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n']),
    ).toEqual([{ type: "text", text: "a" }]);
  });

  test("流里夹着错误对象、不是 JSON", () => {
    expect(() => decodeAll(['data: {"error":{"message":"额度用完"}}\n\n'])).toThrow(
      expect.objectContaining({ code: "api", detail: "额度用完" }),
    );
    expect(() => decodeAll(["data: <html>\n\n"])).toThrow(ProviderError);
  });
});

describe("providerHttpError", () => {
  test("取出 JSON 里的 error.message，不是 JSON 用原文", () => {
    expect(providerHttpError(401, '{"error":{"message":"无效的令牌"}}')).toMatchObject({
      code: "http",
      status: 401,
      detail: "无效的令牌",
    });
    expect(providerHttpError(502, "Bad Gateway")).toMatchObject({
      status: 502,
      detail: "Bad Gateway",
    });
  });
});
