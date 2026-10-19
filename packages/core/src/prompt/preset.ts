// SillyTavern 的聊天补全预设（prompts + prompt_order）：导入、存储、按预设顺序拼提示词。
// 拼装规则照 ST（public/scripts/openai.js、PromptManager.js），只有一处不同：
// 带深度的条目（injection_position 1）ST 插进聊天记录中间，这里一律挪到聊天记录之后，
// 原位置每轮都变会打断缓存（.agents/notes/proposed/feature/2026-10-19-prompt-cache-layout.md）。预设原文不改，原位置还在条目上。
// shortcut: 不支持预设里的温度等采样参数、续写 / 代写提示、宏 {{random}} 之类，做预设编辑界面时一起做
import { z } from "zod";
import type { CardData } from "../card/schema.ts";
import type { ChatMessage } from "../llm/openai.ts";
import { APP_SETTINGS, SETTINGS } from "../llm/profiles.ts";
import type { DocStore } from "../store/doc-store.ts";
import type { ActiveLore } from "./lorebook.ts";

export type PresetImportErrorCode = "invalid_json" | "invalid_preset";

export class PresetImportError extends Error {
  readonly code: PresetImportErrorCode;

  constructor(code: PresetImportErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PresetImportError";
    this.code = code;
  }
}

/** ST：injection_position 1 表示插在聊天记录里的某个深度 */
const ST_ABSOLUTE = 1;
/** ST 全局预设顺序存在这个假角色 id 下 */
const ST_GLOBAL_ORDER_ID = 100001;

const text = (fallback = "") =>
  z
    .string()
    .nullish()
    .catch(fallback)
    .transform((v) => v ?? fallback);
const num = (fallback: number) =>
  z
    .number()
    .nullish()
    .catch(fallback)
    .transform((v) => v ?? fallback);

const promptSchema = z.looseObject({
  identifier: z.string(),
  name: text(),
  role: z.enum(["system", "user", "assistant"]).catch("system"),
  content: text(),
  marker: z.boolean().nullish().catch(false),
  injection_position: num(0),
  injection_depth: num(4),
  injection_order: num(100),
  forbid_overrides: z.boolean().nullish().catch(false),
});
export type PresetPrompt = z.infer<typeof promptSchema>;

export const stPresetSchema = z.looseObject({
  prompts: z.array(z.unknown()).transform((list) =>
    list.flatMap((p) => {
      const parsed = promptSchema.safeParse(p);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  prompt_order: z
    .array(
      z.looseObject({
        character_id: z.unknown(),
        order: z.array(z.looseObject({ identifier: z.string(), enabled: z.boolean().catch(true) })),
      }),
    )
    .catch([]),
  // 默认值照 ST（openai.js 的 default_settings）
  new_chat_prompt: text("[Start a new Chat]"),
  new_example_chat_prompt: text("[Example Chat]"),
  wi_format: text("{0}"),
  scenario_format: text("{{scenario}}"),
  personality_format: text("{{personality}}"),
});
export type StPreset = z.infer<typeof stPresetSchema>;

export function parseStPreset(json: unknown): StPreset {
  const parsed = stPresetSchema.safeParse(json);
  if (!parsed.success) throw new PresetImportError("invalid_preset", parsed.error.message);
  return parsed.data;
}

/** 预设里生效的顺序：优先全局顺序，没有就用第一份，再没有就按 prompts 的顺序全部启用 */
export function presetOrder(preset: StPreset): { identifier: string; enabled: boolean }[] {
  const order =
    preset.prompt_order.find((o) => Number(o.character_id) === ST_GLOBAL_ORDER_ID) ??
    preset.prompt_order[0];
  return order?.order ?? preset.prompts.map((p) => ({ identifier: p.identifier, enabled: true }));
}

/** 预设里会被挪到聊天记录之后的条目（启用的、带深度的） */
export function movedPresetPrompts(preset: StPreset): PresetPrompt[] {
  const byId = new Map(preset.prompts.map((p) => [p.identifier, p]));
  return presetOrder(preset).flatMap(({ identifier, enabled }) => {
    const p = byId.get(identifier);
    return enabled && p && !p.marker && p.injection_position === ST_ABSOLUTE ? [p] : [];
  });
}

export interface PresetParts {
  card: CardData;
  persona: string;
  lore: ActiveLore;
  /** 已经过正则、替换过宏的聊天记录 */
  chat: ChatMessage[];
  fill: (text: string) => string;
}

/** 卡片自带的系统提示 / 历史后指令覆盖预设的 main / jailbreak，{{original}} 是预设原文（V2 规格，ST 默认开启） */
function override(p: PresetPrompt, cardText: string): string {
  if (p.forbid_overrides || !cardText.trim()) return p.content;
  return cardText.replace(/\{\{original\}\}/gi, () => p.content);
}

function markerContent(id: string, preset: StPreset, { card, persona, lore }: PresetParts): string {
  const wi = (entries: string[]) =>
    entries.length > 0 ? preset.wi_format.replace("{0}", entries.join("\n")) : "";
  switch (id) {
    case "worldInfoBefore":
      return wi(lore.before);
    case "worldInfoAfter":
      return wi(lore.after);
    case "personaDescription":
      return persona;
    case "charDescription":
      return card.description;
    case "charPersonality":
      return card.personality.trim()
        ? preset.personality_format.replace(/\{\{personality\}\}/gi, () => card.personality)
        : "";
    case "scenario":
      return card.scenario.trim()
        ? preset.scenario_format.replace(/\{\{scenario\}\}/gi, () => card.scenario)
        : "";
    case "dialogueExamples":
      // shortcut: ST 把示例拆成 example_user / example_assistant 消息，这里每段示例整段放进系统提示
      return card.mes_example
        .split(/<START>/i)
        .map((block) => block.trim())
        .filter((block) => block !== "")
        .map((block) => `${preset.new_example_chat_prompt}\n${block}`)
        .join("\n\n");
    default:
      return "";
  }
}

/** 相邻的 system 消息合成一条，空的去掉 */
function squash(parts: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const part of parts) {
    const content = part.content.trim();
    if (content === "") continue;
    const last = out.at(-1);
    if (part.role === "system" && last?.role === "system") last.content += `\n\n${content}`;
    else out.push({ role: part.role, content });
  }
  return out;
}

export function presetMessages(preset: StPreset, parts: PresetParts): ChatMessage[] {
  const { card, lore, chat, fill } = parts;
  const byId = new Map(preset.prompts.map((p) => [p.identifier, p]));
  const before: ChatMessage[] = [];
  const after: ChatMessage[] = [];
  const atDepth: PresetPrompt[] = [];
  let history: ChatMessage[] = [];

  for (const { identifier, enabled } of presetOrder(preset)) {
    // ST：main 关不掉
    if (!enabled && identifier !== "main") continue;
    if (identifier === "chatHistory") {
      history = [{ role: "system", content: fill(preset.new_chat_prompt) }, ...chat];
      continue;
    }
    const p = byId.get(identifier);
    if (!p) continue;
    if (!p.marker && p.injection_position === ST_ABSOLUTE) {
      atDepth.push(p);
      continue;
    }
    const content = p.marker
      ? markerContent(identifier, preset, parts)
      : identifier === "main"
        ? override(p, card.system_prompt)
        : identifier === "jailbreak"
          ? override(p, card.post_history_instructions)
          : p.content;
    // 聊天记录之前的进不变区，之后的（一般是 jailbreak）放到最后
    (history.length > 0 ? after : before).push({
      role: p.marker ? "system" : p.role,
      content: fill(content),
    });
  }

  // 挪到聊天记录之后：深度大的在前（原来离结尾更远），同深度按 injection_order 从小到大
  atDepth.sort(
    (a, b) => b.injection_depth - a.injection_depth || a.injection_order - b.injection_order,
  );
  const tail: ChatMessage[] = [
    { role: "system", content: fill(lore.tail.join("\n\n")) },
    ...atDepth.map((p) => ({ role: p.role, content: fill(p.content) })),
  ];
  // 聊天记录里的消息原样保留，不和前后的 system 合并
  return [
    ...squash([...before, ...history.slice(0, 1)]),
    ...history.slice(1),
    ...squash([...tail, ...after]),
  ];
}

// ---- 存储 ----

export const PRESETS = "presets";

export type PresetDoc = {
  name: string;
  /** 导入的原文，保留不认识的字段 */
  preset: unknown;
  createdAt: number;
};

export interface PresetItem {
  id: string;
  name: string;
}

/** 导入预设文件的文本；名字取预设里的 name，没有就用 fallbackName（一般是文件名） */
export async function importPreset(
  store: DocStore,
  text: string,
  fallbackName: string,
): Promise<string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PresetImportError("invalid_json");
  }
  parseStPreset(json);
  const own = (json as { name?: unknown }).name;
  const name = typeof own === "string" && own.trim() ? own.trim() : fallbackName;
  const id = crypto.randomUUID();
  await store.put<PresetDoc>(PRESETS, id, { name, preset: json, createdAt: store.timestamp() });
  return id;
}

export async function listPresets(store: DocStore): Promise<PresetItem[]> {
  const docs = await store.list<PresetDoc>(PRESETS);
  return docs
    .sort((a, b) => (a.data.createdAt ?? 0) - (b.data.createdAt ?? 0))
    .map((d) => ({ id: d.id, name: String(d.data.name ?? "") }));
}

/** 当前用的预设；没选或者选的被删了返回 undefined（按内置顺序拼） */
export async function activePreset(
  store: DocStore,
): Promise<(PresetItem & { preset: StPreset }) | undefined> {
  const settings = await store.get<{ activePresetId?: unknown }>(SETTINGS, APP_SETTINGS);
  const id = settings?.data.activePresetId;
  if (typeof id !== "string" || id === "") return undefined;
  const doc = await store.get<PresetDoc>(PRESETS, id);
  if (!doc) return undefined;
  return { id, name: String(doc.data.name ?? ""), preset: parseStPreset(doc.data.preset) };
}

/** 传空字符串表示不用预设 */
export async function setActivePreset(store: DocStore, id: string): Promise<void> {
  await store.put(SETTINGS, APP_SETTINGS, { activePresetId: id });
}
