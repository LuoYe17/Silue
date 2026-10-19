import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { CardImportError, importCard, parseCardJson, readPngTextChunks } from "./import.ts";

const BOM = String.fromCharCode(0xfeff);

const utf8 = (s: string) => strToU8(s);
const latin1 = (s: string) => strToU8(s, true);
const base64 = (s: string) => btoa(String.fromCharCode(...utf8(s)));

// 最小 PNG：签名 + 给定的块 + IEND。解析器不校验 CRC，这里 CRC 全写 0。
function makePng(chunks: [type: string, data: Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  for (const [type, data] of [...chunks, ["IEND", new Uint8Array()] as const]) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    head.set(latin1(type), 4);
    parts.push(head, data, new Uint8Array(4));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const textChunk = (keyword: string, value: string): [string, Uint8Array] => [
  "tEXt",
  latin1(`${keyword}\0${value}`),
];

const v2Card = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "沈青竹",
    description: "法学院研究生",
    first_mes: "你好",
    tags: ["校园"],
    extensions: { regex_scripts: [{ scriptName: "外框" }] },
    character_book: {
      entries: [
        { keys: ["学院"], content: "设定", enabled: true, insertion_order: 1, extensions: {} },
      ],
    },
    some_future_field: 42,
  },
};

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CardImportError);
    expect((err as CardImportError).code).toBe(code);
    return;
  }
  throw new Error(`expected CardImportError ${code}`);
};

describe("parseCardJson", () => {
  test("V1 卡升级成 V3，缺的字段补空值", () => {
    const { card, sourceVersion } = parseCardJson({
      name: "A",
      description: "d",
      personality: "p",
      scenario: "s",
      first_mes: "hi",
      mes_example: "",
    });
    expect(sourceVersion).toBe(1);
    expect(card.spec).toBe("chara_card_v3");
    expect(card.data.name).toBe("A");
    expect(card.data.alternate_greetings).toEqual([]);
    expect(card.data.group_only_greetings).toEqual([]);
    expect(card.data.extensions).toEqual({});
  });

  test("V2 卡升级成 V3，保留不认识的字段和 extensions", () => {
    const { card, sourceVersion } = parseCardJson(v2Card);
    expect(sourceVersion).toBe(2);
    expect(card.data.extensions).toEqual({ regex_scripts: [{ scriptName: "外框" }] });
    expect((card.data as Record<string, unknown>).some_future_field).toBe(42);
    expect(card.data.character_book?.entries[0]?.use_regex).toBe(false);
  });

  test("null 字段：必填文本补空串，可选字段当作没有", () => {
    const { card } = parseCardJson({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { name: "A", description: null, nickname: null, character_book: null },
    });
    expect(card.data.description).toBe("");
    expect(card.data.nickname).toBeUndefined();
    expect(card.data.character_book).toBeUndefined();
  });

  test("没有名字的卡拒绝导入", () => {
    expectCode(
      () => parseCardJson({ spec: "chara_card_v2", data: { description: "x" } }),
      "invalid_card",
    );
    expectCode(() => parseCardJson("not an object"), "invalid_card");
  });
});

describe("importCard", () => {
  test("JSON 文件，带 BOM", () => {
    const result = importCard(utf8(`${BOM}${JSON.stringify(v2Card)}`));
    expect(result.container).toBe("json");
    expect(result.card.data.name).toBe("沈青竹");
  });

  test("PNG 里只有 chara 块（V2）", () => {
    const png = makePng([textChunk("chara", base64(JSON.stringify(v2Card)))]);
    const result = importCard(png);
    expect(result.container).toBe("png");
    expect(result.sourceVersion).toBe(2);
    expect(result.card.data.description).toBe("法学院研究生");
    expect(result.image).toBe(png);
  });

  test("PNG 里 chara 和 ccv3 都有时用 ccv3", () => {
    const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "V3 名字" } };
    const png = makePng([
      textChunk("chara", base64(JSON.stringify(v2Card))),
      textChunk("ccv3", base64(JSON.stringify(v3))),
    ]);
    expect(importCard(png).card.data.name).toBe("V3 名字");
  });

  test("PNG 里没有卡片数据", () => {
    expectCode(() => importCard(makePng([textChunk("Software", "x")])), "png_no_card");
  });

  test("截断的 PNG", () => {
    const png = makePng([textChunk("chara", base64(JSON.stringify(v2Card)))]);
    expectCode(() => importCard(png.subarray(0, 40)), "png_corrupt");
  });

  test("CHARX：card.json 加资源文件", () => {
    const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "C" } };
    const icon = new Uint8Array([1, 2, 3]);
    const zip = zipSync({
      "card.json": utf8(JSON.stringify(v3)),
      "assets/icon/images/main.png": icon,
    });
    const result = importCard(zip);
    expect(result.container).toBe("charx");
    expect(result.card.data.name).toBe("C");
    expect(Object.keys(result.files)).toEqual(["assets/icon/images/main.png"]);
    expect(result.files["assets/icon/images/main.png"]).toEqual(icon);
  });

  test("CHARX 没有 card.json", () => {
    expectCode(() => importCard(zipSync({ "x.json": utf8("{}") })), "charx_no_card_json");
  });

  test("不认识的文件", () => {
    expectCode(() => importCard(utf8("hello")), "unknown_format");
    expectCode(() => importCard(utf8("{oops")), "invalid_json");
  });
});

test("readPngTextChunks 读出全部 tEXt 块", () => {
  const chunks = readPngTextChunks(makePng([textChunk("a", "1"), textChunk("b", "2")]));
  expect([...chunks]).toEqual([
    ["a", "1"],
    ["b", "2"],
  ]);
});
