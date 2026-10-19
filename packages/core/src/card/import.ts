// 导入角色卡：JSON、PNG（tEXt 块里的 base64 JSON）、CHARX（zip 里的 card.json），V1/V2/V3 都转成 V3。
import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import { type CharacterCardV3, cardDataSchema } from "./schema.ts";

export type CardImportErrorCode =
  | "unknown_format"
  | "invalid_json"
  | "invalid_card"
  | "png_corrupt"
  | "png_no_card"
  | "charx_corrupt"
  | "charx_no_card_json"
  | "charx_too_large";

// 界面按 code 去翻译文件里找提示文字；detail 只进日志，不给用户看
export class CardImportError extends Error {
  readonly code: CardImportErrorCode;
  readonly detail: string | undefined;

  constructor(code: CardImportErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CardImportError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ImportedCard {
  card: CharacterCardV3;
  /** 原来的规格版本，V1/V2 已经升级成 V3 */
  sourceVersion: 1 | 2 | 3;
  container: "json" | "png" | "charx";
  /** PNG 卡的原图，规格里 `ccdefault:` 图标就指它 */
  image?: Uint8Array;
  /** CHARX 里除 card.json 以外的文件，键是 zip 内路径，对应 `embeded://<路径>` */
  files: Record<string, Uint8Array>;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
// CHARX 是不可信的 zip，按头部声明的解压后大小设上限，防压缩炸弹
const CHARX_MAX_FILE_BYTES = 64 * 1024 * 1024;
const CHARX_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

export function importCard(bytes: Uint8Array): ImportedCard {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const chunks = readPngTextChunks(bytes);
    // 规格：两种块都有时用 ccv3
    const encoded = chunks.get("ccv3") ?? chunks.get("chara");
    if (encoded === undefined) throw new CardImportError("png_no_card");
    const json = parseJson(decodeBase64Utf8(encoded));
    return { ...parseCardJson(json), container: "png", image: bytes, files: {} };
  }

  if (startsWith(bytes, ZIP_SIGNATURE)) {
    let entries: Record<string, Uint8Array>;
    let total = 0;
    let tooLarge = false;
    try {
      entries = unzipSync(bytes, {
        filter: (file) => {
          total += file.originalSize;
          if (file.originalSize > CHARX_MAX_FILE_BYTES || total > CHARX_MAX_TOTAL_BYTES) {
            tooLarge = true;
          }
          return !tooLarge;
        },
      });
    } catch (err) {
      throw new CardImportError("charx_corrupt", String(err));
    }
    if (tooLarge) throw new CardImportError("charx_too_large");
    const { "card.json": cardJson, ...files } = entries;
    if (cardJson === undefined) throw new CardImportError("charx_no_card_json");
    const json = parseJson(decodeUtf8(cardJson));
    return { ...parseCardJson(json), container: "charx", files };
  }

  const text = decodeUtf8(bytes).trimStart();
  if (!text.startsWith("{")) throw new CardImportError("unknown_format");
  return { ...parseCardJson(parseJson(text)), container: "json", files: {} };
}

const versionedSchema = z.looseObject({
  spec: z.enum(["chara_card_v2", "chara_card_v3"]),
  data: z.unknown(),
});

/** 把任意版本的卡片 JSON 转成 V3。V1 没有 spec 字段，字段直接放在最外层。 */
export function parseCardJson(json: unknown): Pick<ImportedCard, "card" | "sourceVersion"> {
  const versioned = versionedSchema.safeParse(json);
  const sourceVersion = versioned.success ? (versioned.data.spec === "chara_card_v3" ? 3 : 2) : 1;
  const raw = versioned.success ? versioned.data.data : json;
  // V1 规格里 first_mes 必填。只看 name 会把 ST 预设这类也带 name 的 JSON 当成卡
  if (sourceVersion === 1 && !(typeof raw === "object" && raw !== null && "first_mes" in raw)) {
    throw new CardImportError("invalid_card", "no spec and no first_mes");
  }

  const data = cardDataSchema.safeParse(raw);
  if (!data.success) throw new CardImportError("invalid_card", z.prettifyError(data.error));

  // V1 卡最外层除了角色字段没有别的，规格外的字段照样保留在 data 里
  return { card: { spec: "chara_card_v3", spec_version: "3.0", data: data.data }, sourceVersion };
}

/** 读出 PNG 里所有 tEXt 块（关键字 → 文本）。只校验结构，不校验 CRC。 */
export function readPngTextChunks(bytes: Uint8Array): Map<string, string> {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new CardImportError("png_corrupt", "bad signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = new Map<string, string>();
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = strFromU8(bytes.subarray(offset + 4, offset + 8), true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length)
      throw new CardImportError("png_corrupt", `chunk ${type} truncated`);

    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul > 0) {
        // tEXt 的关键字和内容都是 Latin-1；卡片内容是 base64，本来就只有 ASCII
        chunks.set(strFromU8(data.subarray(0, nul), true), strFromU8(data.subarray(nul + 1), true));
      }
    }
    if (type === "IEND") return chunks;
    offset = dataEnd + 4;
  }
  throw new CardImportError("png_corrupt", "missing IEND");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CardImportError("invalid_json", String(err));
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  const text = strFromU8(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeBase64Utf8(base64: string): string {
  let binary: string;
  try {
    binary = atob(base64);
  } catch (err) {
    throw new CardImportError("invalid_json", `bad base64: ${String(err)}`);
  }
  return decodeUtf8(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
