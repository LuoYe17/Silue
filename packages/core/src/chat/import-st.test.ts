import { describe, expect, test } from "vitest";
import { ChatImportError, importStChat } from "./import-st.ts";

const BOM = String.fromCharCode(0xfeff);

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");

// 和 Tavo 导出的文件同样的字段
const header = {
  user_name: "叶修",
  character_name: "万象",
  create_date: "2026-10-19T10:15:00.000Z",
  chat_metadata: { variables: { wanxiang: { snaps: {} } } },
};
const tavoMessage = (isUser: boolean, mes: string) => ({
  name: isUser ? "叶修" : "万象",
  is_user: isUser,
  is_system: false,
  send_date: "2026-10-19T10:15:00.000",
  mes,
  original_avatar: null,
  extra: {},
});

const expectCode = (fn: () => unknown, code: string, line?: number) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ChatImportError);
    expect((err as ChatImportError).code).toBe(code);
    if (line !== undefined) expect((err as ChatImportError).line).toBe(line);
    return;
  }
  throw new Error(`expected ChatImportError ${code}`);
};

describe("importStChat", () => {
  test("Tavo 导出格式：头信息、聊天变量、消息顺序和角色", () => {
    const chat = importStChat(
      jsonl(header, tavoMessage(true, "开始"), tavoMessage(false, "<status>…</status>")),
    );
    expect(chat.userName).toBe("叶修");
    expect(chat.characterName).toBe("万象");
    expect(chat.createdAt).toBe(Date.parse("2026-10-19T10:15:00.000Z"));
    expect(chat.metadata).toEqual(header.chat_metadata);
    expect(chat.messages.map((m) => [m.role, m.swipes, m.swipeIndex])).toEqual([
      ["user", ["开始"], 0],
      ["assistant", ["<status>…</status>"], 0],
    ]);
    expect(chat.messages[0]?.raw.original_avatar).toBeNull();
  });

  test("ST 的多条备选回复和当前选中的那条", () => {
    const chat = importStChat(
      jsonl(header, { ...tavoMessage(false, "B"), swipes: ["A", "B", "C"], swipe_id: 1 }),
    );
    expect(chat.messages[0]).toMatchObject({ swipes: ["A", "B", "C"], swipeIndex: 1 });
  });

  test("swipe_id 越界时回到第一条", () => {
    const chat = importStChat(
      jsonl(header, { ...tavoMessage(false, "A"), swipes: ["A"], swipe_id: 5 }),
    );
    expect(chat.messages[0]?.swipeIndex).toBe(0);
  });

  test("系统消息、BOM、CRLF 和空行", () => {
    const text = `${BOM}${jsonl(header, { ...tavoMessage(false, "旁白"), is_system: true })}\r\n\r\n`;
    expect(importStChat(text).messages[0]?.role).toBe("system");
  });

  test("ST 的英文日期写法", () => {
    const chat = importStChat(
      jsonl(header, { ...tavoMessage(true, "x"), send_date: "October 19, 2026 10:15am" }),
    );
    expect(chat.messages[0]?.sentAt).toBe(new Date(2026, 9, 19, 10, 15).getTime());
  });

  test("头信息里 ST 的 create_date 写法（Tavo 导出文件也用这个）", () => {
    const chat = importStChat(jsonl({ ...header, create_date: "2026-10-19@10h13m58s" }));
    expect(chat.createdAt).toBe(new Date(2026, 9, 19, 10, 13, 58).getTime());
  });

  test("解析不了的日期是 undefined", () => {
    const chat = importStChat(jsonl(header, { ...tavoMessage(true, "x"), send_date: "昨天" }));
    expect(chat.messages[0]?.sentAt).toBeUndefined();
  });

  test("错误：空文件、坏 JSON、缺头信息、坏消息", () => {
    expectCode(() => importStChat("\n\n"), "empty");
    expectCode(() => importStChat(`${JSON.stringify(header)}\n{oops`), "invalid_json", 2);
    expectCode(() => importStChat(jsonl(tavoMessage(true, "x"))), "invalid_header", 1);
    expectCode(() => importStChat(jsonl(header, { mes: 123 })), "invalid_message", 2);
  });
});
