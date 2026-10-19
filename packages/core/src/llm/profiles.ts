// 接口配置：可以存多套（比如中转站一套、官方 DeepSeek 一套），设置里选当前用哪套。
// 这里只管数据库里的部分（名字、地址、模型、思考深度），会跟着同步；API Key 由各端存进系统安全存储，按配置 id 区分。
import type { DocStore } from "../store/doc-store.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.ts";

export const PROVIDERS = "providers";
const SETTINGS = "settings";
const APP_SETTINGS = "app";

export interface ProviderProfileData {
  [key: string]: unknown;
  name: string;
  baseUrl: string;
  model: string;
  thinking: ThinkingLevel;
  createdAt: number;
}

export interface ProviderProfile extends ProviderProfileData {
  id: string;
}

/** 按创建时间排。同步来的数据可能缺字段或带着不认识的档位，读出来时补齐 */
export async function listProviderProfiles(store: DocStore): Promise<ProviderProfile[]> {
  const docs = await store.list<ProviderProfileData>(PROVIDERS);
  return docs
    .map((d) => ({
      ...d.data,
      id: d.id,
      name: String(d.data.name ?? ""),
      baseUrl: String(d.data.baseUrl ?? ""),
      model: String(d.data.model ?? ""),
      thinking: THINKING_LEVELS.find((l) => l === d.data.thinking) ?? "default",
      createdAt: Number(d.data.createdAt ?? 0),
    }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** 没有 id 时新建，返回配置 id */
export async function saveProviderProfile(
  store: DocStore,
  profile: { id?: string; name: string; baseUrl: string; model: string; thinking: ThinkingLevel },
): Promise<string> {
  const id = profile.id ?? crypto.randomUUID();
  await store.put<ProviderProfileData>(PROVIDERS, id, {
    name: profile.name.trim(),
    baseUrl: profile.baseUrl.trim(),
    model: profile.model.trim(),
    thinking: profile.thinking,
    ...(profile.id ? {} : { createdAt: store.timestamp() }),
  });
  return id;
}

export async function removeProviderProfile(store: DocStore, id: string): Promise<void> {
  await store.remove(PROVIDERS, id);
}

/** 当前用哪套。存的那套被删了（或者从没选过）时退回第一套；一套都没有时是 undefined */
export async function activeProviderProfile(store: DocStore): Promise<ProviderProfile | undefined> {
  const [profiles, settings] = await Promise.all([
    listProviderProfiles(store),
    store.get<{ activeProviderId?: string }>(SETTINGS, APP_SETTINGS),
  ]);
  return profiles.find((p) => p.id === settings?.data.activeProviderId) ?? profiles[0];
}

export async function setActiveProviderProfile(store: DocStore, id: string): Promise<void> {
  await store.put(SETTINGS, APP_SETTINGS, { activeProviderId: id });
}
