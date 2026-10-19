// 导入 SillyTavern 的聊天记录（.jsonl）。Tavo 导出的也是这个格式。
// 第一行是头信息（user_name、character_name、create_date、chat_metadata），之后每行一条消息。
// 这里只把文件读成线性的消息列表；转成消息树、写进数据库是存储层的事。
import { z } from "zod";

// 用码点写，不写字面字符：BOM 是看不见的字符，写成字面量没法检查
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export class ChatImportError extends Error {
  readonly code: "empty" | "invalid_json" | "invalid_header" | "invalid_message";
  readonly line: number | undefined;

  constructor(code: ChatImportError["code"], line?: number, detail?: string) {
    super([code, line && `line ${line}`, detail].filter(Boolean).join(": "));
    this.name = "ChatImportError";
    this.code = code;
    this.line = line;
  }
}

const headerSchema = z.looseObject({
  user_name: z.string().nullish(),
  character_name: z.string().nullish(),
  create_date: z.union([z.string(), z.number()]).nullish(),
  chat_metadata: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
});

const messageSchema = z.looseObject({
  name: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  is_user: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  is_system: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  send_date: z.union([z.string(), z.number()]).nullish(),
  mes: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  swipes: z.array(z.string()).nullish(),
  swipe_id: z.number().int().nullish(),
  extra: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
});

export interface ImportedStMessage {
  role: "user" | "assistant" | "system";
  name: string;
  /** 这条消息的所有备选回复（左右滑动），至少一条 */
  swipes: string[];
  /** 当前显示的是第几条备选 */
  swipeIndex: number;
  /** 解析不出来时为 undefined，原值在 raw.send_date */
  sentAt: number | undefined;
  /** 原始的整行数据，保留 ST/Tavo 的私有字段 */
  raw: Record<string, unknown>;
}

export interface ImportedStChat {
  userName: string;
  characterName: string;
  createdAt: number | undefined;
  /** 聊天变量等，原样保留（比如万象记忆插件写的 variables.wanxiang） */
  metadata: Record<string, unknown>;
  messages: ImportedStMessage[];
}

export function importStChat(text: string): ImportedStChat {
  const lines = text
    .replace(BOM, "")
    .split(/\r?\n/)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => line.trim() !== "");
  const [first, ...rest] = lines;
  if (!first) throw new ChatImportError("empty");

  const header = headerSchema.safeParse(parseLine(first.line, first.no));
  // 头信息行没有 mes 字段；有 mes 说明文件缺了头，不是 ST 格式
  if (!header.success || "mes" in (header.data as object)) {
    throw new ChatImportError("invalid_header", first.no);
  }

  const messages = rest.map(({ line, no }) => {
    const raw = parseLine(line, no);
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ChatImportError("invalid_message", no, z.prettifyError(parsed.error));
    }
    const m = parsed.data;
    const swipes = m.swipes?.length ? m.swipes : [m.mes];
    const swipeIndex = m.swipe_id != null && m.swipe_id < swipes.length ? m.swipe_id : 0;
    return {
      role: m.is_system ? "system" : m.is_user ? "user" : "assistant",
      name: m.name,
      swipes,
      swipeIndex,
      sentAt: parseDate(m.send_date),
      raw: raw as Record<string, unknown>,
    } satisfies ImportedStMessage;
  });

  return {
    userName: header.data.user_name ?? "",
    characterName: header.data.character_name ?? "",
    createdAt: parseDate(header.data.create_date),
    metadata: header.data.chat_metadata,
    messages,
  };
}

function parseLine(line: string, no: number): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new ChatImportError("invalid_json", no, String(err));
  }
}

// ST 的日期有毫秒数、ISO 字符串、"October 19, 2026 10:15am"、"2026-10-19@10h13m58s"（头信息里的 create_date）
// 等写法，都按本地时间算；Date 解析不了就放弃
function parseDate(value: string | number | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") return value;
  const humanized = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/);
  if (humanized) {
    const [y, mo, d, h, mi, s] = humanized.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  const normalized = value.replace(/(\d)(am|pm)$/i, "$1 $2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}
