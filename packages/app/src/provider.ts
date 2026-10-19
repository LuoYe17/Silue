// 模型接口的设置和调用。配置（名字、地址、模型、思考深度）存在数据库里，以后跟着同步；
// API Key 按配置 id 存在系统凭据管理器里，不同步。
import {
  activeProviderProfile,
  type ChatMessage,
  type DocStore,
  listProviderProfiles,
  openAiChatRequest,
  type ProviderConfig,
  ProviderError,
  type ProviderProfile,
  parseOpenAiEvent,
  providerHttpError,
  removeProviderProfile,
  type Sampling,
  SseDecoder,
  type StreamEvent,
  saveProviderProfile,
  setActiveProviderProfile,
  THINKING_LEVELS,
} from "@silue/core";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

// 旧版只有一套配置：数据库 settings/provider 加凭据 provider.apiKey。第一次打开时搬成一套命名配置
const LEGACY_SETTINGS = "settings";
const LEGACY_PROVIDER = "provider";
const LEGACY_SECRET = "provider.apiKey";
// 搬过来的配置用固定 id：开发模式下 React 会把启动逻辑跑两遍，两次搬迁同时进行也只会落到同一套上
const MIGRATED_ID = "migrated";

const secretName = (profileId: string) => `provider.${profileId}.apiKey`;

/** 设置表单：一套配置加它的 API Key。id 为空表示新建 */
export interface ProviderForm extends ProviderConfig {
  id?: string;
  name: string;
}

export const EMPTY_FORM: ProviderForm = {
  name: "",
  baseUrl: "",
  model: "",
  apiKey: "",
  thinking: "default",
};

async function migrateLegacy(store: DocStore): Promise<void> {
  const legacy = await store.get<Partial<ProviderConfig>>(LEGACY_SETTINGS, LEGACY_PROVIDER);
  if (!legacy) return;
  if ((await listProviderProfiles(store)).every((p) => p.id === MIGRATED_ID)) {
    const model = String(legacy.data.model ?? "");
    const id = await saveProviderProfile(store, {
      id: MIGRATED_ID,
      name: model,
      baseUrl: String(legacy.data.baseUrl ?? ""),
      model,
      thinking: THINKING_LEVELS.find((l) => l === legacy.data.thinking) ?? "default",
    });
    const key = await invoke<string | null>("secret_get", { name: LEGACY_SECRET });
    if (key) await invoke("secret_set", { name: secretName(id), value: key });
    await setActiveProviderProfile(store, id);
  }
  await invoke("secret_set", { name: LEGACY_SECRET, value: "" });
  await store.remove(LEGACY_SETTINGS, LEGACY_PROVIDER);
}

/** 所有配置和当前那套（带 API Key）；一套都没有时 active 是 undefined */
export async function loadProviders(
  store: DocStore,
): Promise<{ profiles: ProviderProfile[]; active: ProviderForm | undefined }> {
  await migrateLegacy(store);
  const [profiles, active] = await Promise.all([
    listProviderProfiles(store),
    activeProviderProfile(store),
  ]);
  return { profiles, active: active && (await withKey(active)) };
}

export async function withKey(profile: ProviderProfile): Promise<ProviderForm> {
  const apiKey = await invoke<string | null>("secret_get", { name: secretName(profile.id) });
  const { id, name, baseUrl, model, thinking } = profile;
  return { id, name, baseUrl, model, thinking, apiKey: apiKey ?? "" };
}

/** 保存并设为当前配置，返回配置 id。名字没填时用模型名 */
export async function saveProvider(store: DocStore, form: ProviderForm): Promise<string> {
  const id = await saveProviderProfile(store, {
    ...(form.id && { id: form.id }),
    name: form.name.trim() || form.model.trim(),
    baseUrl: form.baseUrl,
    model: form.model,
    thinking: form.thinking ?? "default",
  });
  await invoke("secret_set", { name: secretName(id), value: form.apiKey.trim() });
  await setActiveProviderProfile(store, id);
  return id;
}

export async function deleteProvider(store: DocStore, id: string): Promise<void> {
  await removeProviderProfile(store, id);
  await invoke("secret_set", { name: secretName(id), value: "" });
}

export const isProviderReady = (c: ProviderConfig) => Boolean(c.baseUrl && c.model && c.apiKey);

/** 发请求并把流式返回逐个交给 onEvent。signal 中止后不再回调，正常返回 */
export async function streamChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  sampling: Sampling,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const request = openAiChatRequest(config, messages, sampling);
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
