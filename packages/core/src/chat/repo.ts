// 角色、聊天、消息的读写。数据结构见 .agents/notes/implemented/architecture/2026-10-19-doc-store.md
import type { CardData, CharacterCardV3 } from "../card/schema.ts";
import type { DocStore } from "../store/doc-store.ts";
import type { ImportedStChat } from "./import-st.ts";
import {
  activePath,
  buildTree,
  latestLeaf,
  type Message,
  type MessageData,
  type Role,
  subtreeIds,
} from "./tree.ts";

export const CHARACTERS = "characters";
export const CHATS = "chats";
export const MESSAGES = "messages";

export interface ChatData {
  [key: string]: unknown;
  characterId: string;
  title: string;
  /** 当前显示的那条线的最后一条消息；聊天是空的时为 null */
  leafId: string | null;
  /** 聊天变量等，比如从 ST/Tavo 导入的 chat_metadata */
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface Chat extends ChatData {
  id: string;
}

export interface LoadedChat {
  chat: Chat;
  messages: Message[];
}

// ---------- 角色 ----------

/** 卡片的每个顶层字段存成文档的一个字段，两台设备分别改名字和描述时可以各自保留 */
export async function createCharacter(store: DocStore, card: CharacterCardV3): Promise<string> {
  const id = crypto.randomUUID();
  await store.put(CHARACTERS, id, { ...card.data });
  return id;
}

export async function getCharacter(
  store: DocStore,
  id: string,
): Promise<CharacterCardV3 | undefined> {
  const doc = await store.get<CardData>(CHARACTERS, id);
  return doc && { spec: "chara_card_v3", spec_version: "3.0", data: doc.data };
}

export async function listCharacters(
  store: DocStore,
): Promise<{ id: string; card: CharacterCardV3 }[]> {
  const docs = await store.list<CardData>(CHARACTERS);
  return docs.map((d) => ({
    id: d.id,
    card: { spec: "chara_card_v3", spec_version: "3.0", data: d.data },
  }));
}

// ---------- 聊天 ----------

/** 新建聊天：卡片的开场白和备选开场白作为根上的兄弟消息，默认显示第一条 */
export async function createChat(
  store: DocStore,
  characterId: string,
  title = "",
): Promise<string> {
  const character = await getCharacter(store, characterId);
  if (!character) throw new Error(`character not found: ${characterId}`);
  const chatId = crypto.randomUUID();
  const { name, first_mes, alternate_greetings } = character.data;
  const greetings = [first_mes, ...alternate_greetings].filter((g) => g.trim() !== "");
  const docs = greetings.map((content) => ({
    collection: MESSAGES,
    id: crypto.randomUUID(),
    data: messageData(store, chatId, null, "assistant", name, content),
  }));
  await store.insertMany(docs);
  await store.put<ChatData>(CHATS, chatId, {
    characterId,
    title,
    leafId: docs[0]?.id ?? null,
    metadata: {},
    createdAt: store.timestamp(),
  });
  return chatId;
}

export async function listChats(store: DocStore, characterId: string): Promise<Chat[]> {
  const docs = await store.list<ChatData>(CHATS, { characterId });
  return docs.map((d) => ({ ...d.data, id: d.id })).sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadChat(store: DocStore, chatId: string): Promise<LoadedChat | undefined> {
  const chat = await store.get<ChatData>(CHATS, chatId);
  if (!chat) return undefined;
  const docs = await store.list<MessageData>(MESSAGES, { chatId });
  return {
    chat: { ...chat.data, id: chat.id },
    messages: docs.map((d) => ({ ...d.data, id: d.id })),
  };
}

/** 当前显示的那条线，从开场白到最后一条 */
export async function loadActivePath(store: DocStore, chatId: string): Promise<Message[]> {
  const loaded = await loadChat(store, chatId);
  if (!loaded) return [];
  return activePath(buildTree(loaded.messages), loaded.chat.leafId);
}

// ---------- 消息 ----------

/**
 * 在 parentId 下面加一条消息，并让聊天显示到这条。
 * 发新消息：parentId 是当前最后一条；重新生成：parentId 是要替换的那条的父消息，结果成为它的兄弟。
 */
export async function appendMessage(
  store: DocStore,
  chatId: string,
  input: { parentId: string | null; role: Role; name: string; content: string },
): Promise<Message> {
  const id = crypto.randomUUID();
  const data = messageData(store, chatId, input.parentId, input.role, input.name, input.content);
  await store.put(MESSAGES, id, data);
  await store.put<ChatData>(CHATS, chatId, { leafId: id });
  return { ...data, id };
}

/** 原地改内容。另一台设备同时改了同一条时，后改的那次胜出。 */
export async function editMessage(store: DocStore, messageId: string, content: string) {
  await store.put<MessageData>(MESSAGES, messageId, { content });
}

/** 切到某条消息所在的分支（左右滑动、点分支），显示到这条分支最新的末端 */
export async function selectBranch(store: DocStore, chatId: string, messageId: string) {
  const loaded = await loadChat(store, chatId);
  if (!loaded) throw new Error(`chat not found: ${chatId}`);
  const tree = buildTree(loaded.messages);
  if (!tree.byId.has(messageId)) throw new Error(`message not found: ${messageId}`);
  await store.put<ChatData>(CHATS, chatId, { leafId: latestLeaf(tree, messageId) });
}

/**
 * 删除这条消息和它下面的所有消息。
 * 如果当前显示的线被删掉了：还有兄弟就切到最新的兄弟那条线，没有就退回父消息。
 */
export async function deleteBranch(store: DocStore, chatId: string, messageId: string) {
  const loaded = await loadChat(store, chatId);
  if (!loaded) throw new Error(`chat not found: ${chatId}`);
  const tree = buildTree(loaded.messages);
  const message = tree.byId.get(messageId);
  if (!message) return;

  const removed = new Set(subtreeIds(tree, messageId));
  await store.removeMany(MESSAGES, [...removed]);

  if (loaded.chat.leafId === null || !removed.has(loaded.chat.leafId)) return;
  const remainingSiblings = (tree.children.get(message.parentId) ?? []).filter(
    (m) => m.id !== messageId,
  );
  const fallback = remainingSiblings[remainingSiblings.length - 1];
  const leafId = fallback ? latestLeaf(tree, fallback.id) : message.parentId;
  await store.put<ChatData>(CHATS, chatId, { leafId });
}

// ---------- 导入 ----------

/**
 * 把 ST/Tavo 导出的聊天写进库。每条 ST 消息的多条备选回复变成兄弟消息，
 * 当前选中的那条接着往下连。整段聊天一次批量写入。
 */
export async function importStChatToStore(
  store: DocStore,
  characterId: string,
  imported: ImportedStChat,
): Promise<string> {
  const chatId = crypto.randomUUID();
  const base = imported.createdAt ?? store.timestamp();
  const docs: { collection: string; id: string; data: MessageData }[] = [];
  let parentId: string | null = null;

  imported.messages.forEach((m, i) => {
    // ST 的消息不一定有时间；没有就按顺序每条往后排 1 秒，保证兄弟之间、上下之间的先后
    const createdAt = m.sentAt ?? base + i * 1000;
    const { name, is_user, is_system, send_date, mes, swipes, swipe_id, ...stExtra } = m.raw;
    let selected: string | null = null;
    m.swipes.forEach((content, j) => {
      const id = crypto.randomUUID();
      const data: MessageData = {
        chatId,
        parentId,
        role: m.role,
        name: m.name,
        content,
        createdAt: createdAt + j,
        ...(j === m.swipeIndex && Object.keys(stExtra).length > 0 ? { stExtra } : {}),
      };
      docs.push({ collection: MESSAGES, id, data });
      if (j === m.swipeIndex) selected = id;
    });
    parentId = selected;
  });

  await store.insertMany(docs);
  await store.put<ChatData>(CHATS, chatId, {
    characterId,
    title: "",
    leafId: parentId,
    metadata: imported.metadata,
    createdAt: base,
  });
  return chatId;
}

function messageData(
  store: DocStore,
  chatId: string,
  parentId: string | null,
  role: Role,
  name: string,
  content: string,
): MessageData {
  return { chatId, parentId, role, name, content, createdAt: store.timestamp() };
}
