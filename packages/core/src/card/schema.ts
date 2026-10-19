// 角色卡统一存成 V3 结构。规格：https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
// 卡片来自网上，缺字段、字段是 null 都很常见：必填的文本和数组缺了就补空值，可选字段的 null 当作没有。
// 规格要求保留不认识的字段（导出时原样带上），所以全部用 looseObject。
import { z } from "zod";

const text = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? "");
const textList = () =>
  z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []);
const record = () =>
  z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {});
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? undefined);

export const lorebookEntrySchema = z.looseObject({
  keys: textList(),
  content: text(),
  extensions: record(),
  enabled: z
    .boolean()
    .nullish()
    .transform((v) => v ?? true),
  insertion_order: z
    .number()
    .nullish()
    .transform((v) => v ?? 0),
  case_sensitive: optional(z.boolean()),
  use_regex: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  constant: optional(z.boolean()),
  name: optional(z.string()),
  priority: optional(z.number()),
  id: optional(z.union([z.number(), z.string()])),
  comment: optional(z.string()),
  selective: optional(z.boolean()),
  secondary_keys: optional(z.array(z.string())),
  // 规格写的是 'before_char' | 'after_char'，但 SillyTavern 导出的卡里也见过数字
  position: optional(z.union([z.string(), z.number()])),
});

export const lorebookSchema = z.looseObject({
  name: optional(z.string()),
  description: optional(z.string()),
  scan_depth: optional(z.number()),
  token_budget: optional(z.number()),
  recursive_scanning: optional(z.boolean()),
  extensions: record(),
  entries: z
    .array(lorebookEntrySchema)
    .nullish()
    .transform((v) => v ?? []),
});

export const cardAssetSchema = z.looseObject({
  type: z.string(),
  uri: z.string(),
  name: text(),
  ext: text(),
});

export const cardDataSchema = z.looseObject({
  name: z.string(),
  description: text(),
  tags: textList(),
  creator: text(),
  character_version: text(),
  mes_example: text(),
  extensions: record(),
  system_prompt: text(),
  post_history_instructions: text(),
  first_mes: text(),
  alternate_greetings: textList(),
  personality: text(),
  scenario: text(),
  creator_notes: text(),
  character_book: optional(lorebookSchema),
  assets: optional(z.array(cardAssetSchema)),
  nickname: optional(z.string()),
  creator_notes_multilingual: optional(z.record(z.string(), z.string())),
  source: optional(z.array(z.string())),
  group_only_greetings: textList(),
  creation_date: optional(z.number()),
  modification_date: optional(z.number()),
});

export type LorebookEntry = z.output<typeof lorebookEntrySchema>;
export type Lorebook = z.output<typeof lorebookSchema>;
export type CardData = z.output<typeof cardDataSchema>;

export interface CharacterCardV3 {
  spec: "chara_card_v3";
  spec_version: "3.0";
  data: CardData;
}
