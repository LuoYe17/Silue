import { describe, expect, test } from "vitest";
import { parseCardJson } from "../card/import.ts";
import { DocStore } from "../store/doc-store.ts";
import { nodeSqliteDriver } from "../testing/node-sqlite.ts";
import { importStChat } from "./import-st.ts";
import {
  appendMessage,
  createCharacter,
  createChat,
  deleteBranch,
  editMessage,
  getCharacter,
  importStChatToStore,
  listCharacters,
  listChats,
  loadActivePath,
  loadChat,
  selectBranch,
} from "./repo.ts";
import { buildTree, siblingsOf } from "./tree.ts";

const card = parseCardJson({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "万象",
    first_mes: "开场白 1",
    alternate_greetings: ["开场白 2", "  "],
    character_book: { entries: [{ keys: ["学院"], content: "设定" }] },
  },
}).card;

async function setup() {
  let t = 1_000;
  const store = await DocStore.open(nodeSqliteDriver(), "dev-a", () => t++);
  const characterId = await createCharacter(store, card);
  return { store, characterId };
}

const contents = (messages: { content: string }[]) => messages.map((m) => m.content);

describe("角色", () => {
  test("存进去的卡原样读回", async () => {
    const { store, characterId } = await setup();
    expect(await getCharacter(store, characterId)).toEqual(card);
    expect((await listCharacters(store)).map((c) => c.id)).toEqual([characterId]);
  });
});

describe("聊天和消息树", () => {
  test("新聊天：开场白和备选开场白是根上的兄弟，空白的跳过，默认显示第一条", async () => {
    const { store, characterId } = await setup();
    const chatId = await createChat(store, characterId);
    const loaded = await loadChat(store, chatId);
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1"]);
    const tree = buildTree(loaded?.messages ?? []);
    expect(contents(tree.children.get(null) ?? [])).toEqual(["开场白 1", "开场白 2"]);
    expect(await listChats(store, characterId)).toHaveLength(1);
  });

  test("发消息、重新生成、左右切换、编辑", async () => {
    const { store, characterId } = await setup();
    const chatId = await createChat(store, characterId);
    const [greeting] = await loadActivePath(store, chatId);
    const user = await appendMessage(store, chatId, {
      parentId: greeting?.id ?? null,
      role: "user",
      name: "叶修",
      content: "你好",
    });
    const reply1 = await appendMessage(store, chatId, {
      parentId: user.id,
      role: "assistant",
      name: "万象",
      content: "回复 1",
    });
    // 重新生成：同一个父消息下再加一条
    await appendMessage(store, chatId, {
      parentId: user.id,
      role: "assistant",
      name: "万象",
      content: "回复 2",
    });
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1", "你好", "回复 2"]);

    const loaded = await loadChat(store, chatId);
    const tree = buildTree(loaded?.messages ?? []);
    expect(contents(siblingsOf(tree, reply1))).toEqual(["回复 1", "回复 2"]);

    await selectBranch(store, chatId, reply1.id);
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1", "你好", "回复 1"]);

    await editMessage(store, reply1.id, "回复 1（改过）");
    expect(contents(await loadActivePath(store, chatId))).toContain("回复 1（改过）");
  });

  test("切到一个分支时，显示到这条分支最新的末端", async () => {
    const { store, characterId } = await setup();
    const chatId = await createChat(store, characterId);
    const [greeting] = await loadActivePath(store, chatId);
    const a = await appendMessage(store, chatId, {
      parentId: greeting?.id ?? null,
      role: "user",
      name: "u",
      content: "A",
    });
    await appendMessage(store, chatId, {
      parentId: a.id,
      role: "assistant",
      name: "c",
      content: "A1",
    });
    await appendMessage(store, chatId, {
      parentId: greeting?.id ?? null,
      role: "user",
      name: "u",
      content: "B",
    });
    await selectBranch(store, chatId, a.id);
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1", "A", "A1"]);
  });

  test("删除分支：删掉当前这条线时切到最新的兄弟，没有兄弟退回父消息", async () => {
    const { store, characterId } = await setup();
    const chatId = await createChat(store, characterId);
    const [greeting] = await loadActivePath(store, chatId);
    const user = await appendMessage(store, chatId, {
      parentId: greeting?.id ?? null,
      role: "user",
      name: "u",
      content: "问",
    });
    const r1 = await appendMessage(store, chatId, {
      parentId: user.id,
      role: "assistant",
      name: "c",
      content: "答 1",
    });
    const r2 = await appendMessage(store, chatId, {
      parentId: user.id,
      role: "assistant",
      name: "c",
      content: "答 2",
    });
    await appendMessage(store, chatId, {
      parentId: r2.id,
      role: "user",
      name: "u",
      content: "追问",
    });

    await deleteBranch(store, chatId, r2.id);
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1", "问", "答 1"]);
    // 子消息也一起删了
    expect(contents((await loadChat(store, chatId))?.messages ?? [])).not.toContain("追问");

    await deleteBranch(store, chatId, r1.id);
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1", "问"]);
  });

  test("删除不在当前线上的分支，当前显示不变", async () => {
    const { store, characterId } = await setup();
    const chatId = await createChat(store, characterId);
    const [greeting] = await loadActivePath(store, chatId);
    const user = await appendMessage(store, chatId, {
      parentId: greeting?.id ?? null,
      role: "user",
      name: "u",
      content: "问",
    });
    const r1 = await appendMessage(store, chatId, {
      parentId: user.id,
      role: "assistant",
      name: "c",
      content: "答 1",
    });
    await appendMessage(store, chatId, {
      parentId: user.id,
      role: "assistant",
      name: "c",
      content: "答 2",
    });
    await deleteBranch(store, chatId, r1.id);
    expect(contents(await loadActivePath(store, chatId))).toEqual(["开场白 1", "问", "答 2"]);
  });
});

describe("导入 ST/Tavo 聊天", () => {
  const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");
  const header = {
    user_name: "叶修",
    character_name: "万象",
    create_date: "2026-10-19@10h13m58s",
    chat_metadata: { variables: { x: 1 } },
  };

  test("线性记录变成一条线，备选回复变成兄弟，私有字段保留", async () => {
    const { store, characterId } = await setup();
    const imported = importStChat(
      jsonl(
        header,
        { name: "万象", is_user: false, mes: "开场", original_avatar: null, extra: { tavo: 1 } },
        { name: "叶修", is_user: true, mes: "你好" },
        { name: "万象", is_user: false, mes: "B", swipes: ["A", "B", "C"], swipe_id: 1 },
      ),
    );
    const chatId = await importStChatToStore(store, characterId, imported);
    const path = await loadActivePath(store, chatId);
    expect(contents(path)).toEqual(["开场", "你好", "B"]);
    expect(path[0]?.stExtra).toEqual({ original_avatar: null, extra: { tavo: 1 } });

    const loaded = await loadChat(store, chatId);
    expect(loaded?.chat.metadata).toEqual({ variables: { x: 1 } });
    const tree = buildTree(loaded?.messages ?? []);
    const last = path[2];
    expect(last && contents(siblingsOf(tree, last))).toEqual(["A", "B", "C"]);
  });

  test("几百条消息的聊天一次写入", async () => {
    const { store, characterId } = await setup();
    const rows = Array.from({ length: 600 }, (_, i) => ({
      name: i % 2 ? "叶修" : "万象",
      is_user: i % 2 === 1,
      mes: `第 ${i} 条`,
    }));
    const chatId = await importStChatToStore(
      store,
      characterId,
      importStChat(jsonl(header, ...rows)),
    );
    const path = await loadActivePath(store, chatId);
    expect(path).toHaveLength(600);
    expect(path[599]?.content).toBe("第 599 条");
  });
});
