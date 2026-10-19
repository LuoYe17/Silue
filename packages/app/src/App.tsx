// 最简界面：用来在真 App 里把存储层跑一遍（导入卡、导入聊天、发消息、切换备选）。还没接模型。
import {
  appendMessage,
  buildTree,
  type CharacterCardV3,
  type Chat,
  createCharacter,
  createChat,
  type DocStore,
  importCard,
  importStChat,
  importStChatToStore,
  listCharacters,
  listChats,
  loadChat,
  type Message,
  selectBranch,
  siblingsOf,
  activePath as toActivePath,
} from "@silue/core";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { openStore } from "./db.ts";
import { errorText, t } from "./i18n/index.ts";
import "./App.css";

type CharacterItem = { id: string; card: CharacterCardV3 };
type View = { messages: Message[]; siblings: Map<string, Message[]> };

export function App() {
  const [store, setStore] = useState<DocStore>();
  const [fatal, setFatal] = useState<string>();
  const [error, setError] = useState<string>();
  const [characters, setCharacters] = useState<CharacterItem[]>([]);
  const [characterId, setCharacterId] = useState<string>();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string>();
  const [view, setView] = useState<View>({ messages: [], siblings: new Map() });
  const [draft, setDraft] = useState("");

  useEffect(() => {
    openStore().then(setStore, (err) => setFatal(errorText(err)));
  }, []);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const refreshCharacters = useCallback(async (s: DocStore) => {
    setCharacters(await listCharacters(s));
  }, []);

  const refreshChats = useCallback(async (s: DocStore, id: string | undefined) => {
    setChats(id ? await listChats(s, id) : []);
  }, []);

  const refreshView = useCallback(async (s: DocStore, id: string | undefined) => {
    const loaded = id ? await loadChat(s, id) : undefined;
    if (!loaded) return setView({ messages: [], siblings: new Map() });
    const tree = buildTree(loaded.messages);
    const messages = toActivePath(tree, loaded.chat.leafId);
    setView({ messages, siblings: new Map(messages.map((m) => [m.id, siblingsOf(tree, m)])) });
  }, []);

  useEffect(() => {
    if (store) void refreshCharacters(store);
  }, [store, refreshCharacters]);
  useEffect(() => {
    if (store) void refreshChats(store, characterId);
  }, [store, characterId, refreshChats]);
  useEffect(() => {
    if (store) void refreshView(store, chatId);
  }, [store, chatId, refreshView]);

  if (fatal) return <div className="center">{`${t("app.loadFailed")}: ${fatal}`}</div>;
  if (!store) return <div className="center">{t("app.loading")}</div>;

  const onImportCard = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(async () => {
      const { card } = importCard(new Uint8Array(await file.arrayBuffer()));
      const id = await createCharacter(store, card);
      await refreshCharacters(store);
      setCharacterId(id);
    });
  };

  const onImportChat = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !characterId) return;
    void run(async () => {
      const id = await importStChatToStore(store, characterId, importStChat(await file.text()));
      await refreshChats(store, characterId);
      setChatId(id);
    });
  };

  const onNewChat = () => {
    if (!characterId) return;
    void run(async () => {
      const id = await createChat(store, characterId);
      await refreshChats(store, characterId);
      setChatId(id);
    });
  };

  const onSend = () => {
    const content = draft.trim();
    if (!content || !chatId) return;
    void run(async () => {
      const last = view.messages[view.messages.length - 1];
      await appendMessage(store, chatId, {
        parentId: last?.id ?? null,
        role: "user",
        name: t("chat.you"),
        content,
      });
      setDraft("");
      await refreshView(store, chatId);
    });
  };

  const onSwitch = (message: Message, step: number) => {
    const siblings = view.siblings.get(message.id) ?? [];
    const target = siblings[siblings.findIndex((m) => m.id === message.id) + step];
    if (!target || !chatId) return;
    void run(async () => {
      await selectBranch(store, chatId, target.id);
      await refreshView(store, chatId);
    });
  };

  return (
    <div className="layout">
      <aside className="pane">
        <header>
          <h2>{t("characters.title")}</h2>
          <label className="button">
            {t("characters.import")}
            <input type="file" accept=".png,.json,.charx" hidden onChange={onImportCard} />
          </label>
        </header>
        {characters.length === 0 && <p className="hint">{t("characters.empty")}</p>}
        <ul>
          {characters.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={c.id === characterId ? "item selected" : "item"}
                onClick={() => {
                  setCharacterId(c.id);
                  setChatId(undefined);
                }}
              >
                {c.card.data.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <aside className="pane">
        <header>
          <h2>{t("chats.title")}</h2>
          {characterId && (
            <div className="actions">
              <button type="button" className="button" onClick={onNewChat}>
                {t("chats.new")}
              </button>
              <label className="button">
                {t("chats.import")}
                <input type="file" accept=".jsonl" hidden onChange={onImportChat} />
              </label>
            </div>
          )}
        </header>
        {characterId && chats.length === 0 && <p className="hint">{t("chats.empty")}</p>}
        <ul>
          {chats.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={c.id === chatId ? "item selected" : "item"}
                onClick={() => setChatId(c.id)}
              >
                {c.title || t("chats.untitled", { date: new Date(c.createdAt).toLocaleString() })}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat">
        {error && <div className="error">{error}</div>}
        {!chatId && <p className="hint center">{t("chat.empty")}</p>}
        <div className="messages">
          {view.messages.map((m) => {
            const siblings = view.siblings.get(m.id) ?? [m];
            const index = siblings.findIndex((s) => s.id === m.id);
            return (
              <article key={m.id} className={`message ${m.role}`}>
                <div className="meta">
                  <span className="name">{m.name}</span>
                  {siblings.length > 1 && (
                    <span className="switcher">
                      <button
                        type="button"
                        aria-label={t("chat.previous")}
                        disabled={index === 0}
                        onClick={() => onSwitch(m, -1)}
                      >
                        ‹
                      </button>
                      {t("chat.branch", { index: index + 1, total: siblings.length })}
                      <button
                        type="button"
                        aria-label={t("chat.next")}
                        disabled={index === siblings.length - 1}
                        onClick={() => onSwitch(m, 1)}
                      >
                        ›
                      </button>
                    </span>
                  )}
                </div>
                <div className="content">{m.content}</div>
              </article>
            );
          })}
        </div>
        {chatId && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <textarea
              value={draft}
              placeholder={t("chat.placeholder")}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="button">
              {t("chat.send")}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
