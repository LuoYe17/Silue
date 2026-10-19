// OpenAI 兼容的 /chat/completions 接口：拼请求、解析流式返回。不发网络请求，发请求由各端自己做
// （App 用 Tauri 的 HTTP 插件，测试直接喂字符串）。请求内容由 openai.test.ts 的标准答案锁死。
import { z } from "zod";
import { reasoningEffort, type ThinkingLevel } from "./thinking.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderConfig {
  /** 用户填的接口地址，比如 https://api.example.com 或 https://api.example.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 思考深度，没有时按 default（不发参数） */
  thinking?: ThinkingLevel;
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Usage {
  input: number;
  output: number;
  /** 输入里命中缓存的部分；接口没返回时是 undefined（中转站常见） */
  cachedInput?: number;
  /** 输出里思考用掉的部分 */
  reasoning?: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: string };

export type ProviderErrorCode = "http" | "api" | "bad_response";

/** 模型接口出错。界面按 code 翻译，status 和 detail 原样显示 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;
  readonly detail: string;

  constructor(code: ProviderErrorCode, detail: string, status?: number) {
    super(`${code}${status ? ` ${status}` : ""}: ${detail}`);
    this.name = "ProviderError";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * 只填了域名时补 /v1（大多数中转站和 OpenAI 都是这样）；带了路径就照用，
 * 比如 Gemini 官方的兼容地址 https://generativelanguage.googleapis.com/v1beta/openai
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${/^https?:\/\/[^/]+$/i.test(base) ? `${base}/v1` : base}/chat/completions`;
}

export function openAiChatRequest(config: ProviderConfig, messages: ChatMessage[]): HttpRequest {
  return {
    url: chatCompletionsUrl(config.baseUrl),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // 放在最后：不改前面字段的顺序，default 时请求体和以前逐字相同
      reasoning_effort: reasoningEffort(config.baseUrl, config.thinking ?? "default"),
    }),
  };
}

/** 把一块块收到的文本切成 SSE 事件，返回每个事件的 data（多行 data 用换行连起来） */
export class SseDecoder {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      this.line(line, events);
    }
    return events;
  }

  /** 流结束时调用：最后一个事件后面可能没有空行 */
  end(): string[] {
    const events: string[] = [];
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ""), events);
    this.buffer = "";
    this.line("", events);
    return events;
  }

  private line(line: string, events: string[]) {
    if (line === "") {
      if (this.data.length > 0) events.push(this.data.join("\n"));
      this.data = [];
    } else if (line.startsWith("data:")) {
      this.data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}

const text = z.string().nullish();
const count = z.number().nullish();
const chunkSchema = z.looseObject({
  error: z.union([z.string(), z.looseObject({ message: text })]).nullish(),
  choices: z
    .array(
      z.looseObject({
        // DeepSeek 用 reasoning_content，OpenRouter 等用 reasoning
        delta: z.looseObject({ content: text, reasoning_content: text, reasoning: text }).nullish(),
        finish_reason: text,
      }),
    )
    .nullish(),
  usage: z
    .looseObject({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      prompt_tokens_details: z.looseObject({ cached_tokens: count }).nullish(),
      // DeepSeek 官方接口把缓存命中数放在这里（https://api-docs.deepseek.com/guides/kv_cache）
      prompt_cache_hit_tokens: count,
      completion_tokens_details: z.looseObject({ reasoning_tokens: count }).nullish(),
    })
    .nullish(),
});

/** 解析一个 SSE 事件的 data。`[DONE]` 返回空数组；流里夹着错误对象时抛 ProviderError */
export function parseOpenAiEvent(data: string): StreamEvent[] {
  if (data.trim() === "[DONE]") return [];
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ProviderError("bad_response", data.slice(0, 500));
  }
  const parsed = chunkSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("bad_response", data.slice(0, 500));
  const { error, choices, usage } = parsed.data;
  if (error) {
    throw new ProviderError("api", typeof error === "string" ? error : (error.message ?? data));
  }

  const events: StreamEvent[] = [];
  const choice = choices?.[0];
  const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
  if (reasoning) events.push({ type: "reasoning", text: reasoning });
  if (choice?.delta?.content) events.push({ type: "text", text: choice.delta.content });
  if (choice?.finish_reason) events.push({ type: "finish", reason: choice.finish_reason });
  if (usage) {
    const cachedInput = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
    events.push({
      type: "usage",
      usage: {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        ...(cachedInput != null && { cachedInput }),
        ...(usage.completion_tokens_details?.reasoning_tokens != null && {
          reasoning: usage.completion_tokens_details.reasoning_tokens,
        }),
      },
    });
  }
  return events;
}

/** HTTP 状态码不是 2xx 时，从响应体里尽量取出接口给的错误说明 */
export function providerHttpError(status: number, body: string): ProviderError {
  let detail = body.slice(0, 500);
  try {
    const parsed = chunkSchema.safeParse(JSON.parse(body));
    const error = parsed.success ? parsed.data.error : undefined;
    if (typeof error === "string") detail = error;
    else if (error?.message) detail = error.message;
  } catch {
    // 不是 JSON（比如网关返回的 HTML），用原文
  }
  return new ProviderError("http", detail, status);
}
