// 用户人设：名字替换 {{user}}，描述拼进系统提示（位置见 buildChatPrompt）。
// 存在 settings/app 里，全局一份，跟着同步。
// shortcut: 只有一份人设，不能按角色或聊天切换；要多个人设时改成像接口配置那样的集合
import { APP_SETTINGS, SETTINGS } from "../llm/profiles.ts";
import type { DocStore } from "../store/doc-store.ts";

export interface Persona {
  name: string;
  description: string;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

export async function loadPersona(store: DocStore): Promise<Persona> {
  const doc = await store.get<{ personaName?: unknown; personaDescription?: unknown }>(
    SETTINGS,
    APP_SETTINGS,
  );
  return { name: text(doc?.data.personaName), description: text(doc?.data.personaDescription) };
}

export async function savePersona(store: DocStore, persona: Persona): Promise<void> {
  await store.put(SETTINGS, APP_SETTINGS, {
    personaName: persona.name.trim(),
    personaDescription: persona.description.trim(),
  });
}
