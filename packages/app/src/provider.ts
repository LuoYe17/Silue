// 模型接口的设置和调用。接口地址、模型名存在数据库里（以后跟着同步），API Key 存在系统凭据管理器里。
import {
  type ChatMessage,
  type DocStore,
  openAiChatRequest,
  type ProviderConfig,
  ProviderError,
  parseOpenAiEvent,
  providerHttpError,
  SseDecoder,
  type StreamEvent,
} from "@silue/core";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

const SETTINGS = "settings";
const PROVIDER = "provider";
const API_KEY_SECRET = "provider.apiKey";

type ProviderSettings = { baseUrl: string; model: string };

export async function loadProvider(store: DocStore): Promise<ProviderConfig> {
  const doc = await store.get<ProviderSettings>(SETTINGS, PROVIDER);
  const apiKey = await invoke<string | null>("secret_get", { name: API_KEY_SECRET });
  return { baseUrl: doc?.data.baseUrl ?? "", model: doc?.data.model ?? "", apiKey: apiKey ?? "" };
}

export async function saveProvider(store: DocStore, config: ProviderConfig): Promise<void> {
  await store.put<ProviderSettings>(SETTINGS, PROVIDER, {
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
  });
  await invoke("secret_set", { name: API_KEY_SECRET, value: config.apiKey.trim() });
}

export const isProviderReady = (c: ProviderConfig) => Boolean(c.baseUrl && c.model && c.apiKey);

/** 发请求并把流式返回逐个交给 onEvent。signal 中止后不再回调，正常返回 */
export async function streamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const request = openAiChatRequest(config, messages);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal,
  });
  if (!response.ok) throw providerHttpError(response.status, await response.text());
  if (!response.body) throw new ProviderError("bad_response", "empty body");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const sse = new SseDecoder();
  const emit = (data: string[]) => {
    for (const d of data) for (const event of parseOpenAiEvent(d)) onEvent(event);
  };
  for (;;) {
    if (signal.aborted) {
      await reader.cancel();
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    emit(sse.push(value));
  }
  emit(sse.end());
}
