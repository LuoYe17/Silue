// 主界面：左边是导航栏（角色 → 这个角色的聊天，像 iOS 一样点进去、返回），右边是聊天。
// 窄屏（手机）上两边不同时显示：打开聊天时只显示聊天，左上角返回。设置是弹出页（SettingsSheet）。
import {
  activePreset,
  appendMessage,
  applyRegexScripts,
  buildChatPrompt,
  buildTree,
  type CharacterCardV3,
  type Chat,
  cardRegexScripts,
  createCharacter,
  createChat,
  type DocStore,
  deleteBranch,
  editMessage,
  getCharacter,
  importCard,
  importStChat,
  importStChatToStore,
  listCharacters,
  listChats,
  loadChat,
  loadPersona,
  type Message,
  type Persona,
  presetSampling,
  replaceMacros,
  selectBranch,
  siblingsOf,
  activePath as toActivePath,
  type Usage,
} from "@silue/core";
import {
  type ChangeEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openStore } from "./db.ts";
import { errorText, t } from "./i18n/index.ts";
import { Icon } from "./icons.tsx";
import { MessageHtml } from "./MessageHtml.tsx";
import { htmlMarkdown, textMarkdown } from "./markdown.ts";
import { isProviderReady, loadProviders, type ProviderForm, streamChat } from "./provider.ts";
import { SettingsSheet, type SettingsTab } from "./SettingsSheet.tsx";
import "./App.css";

type CharacterItem = { id: string; card: CharacterCardV3 };
type View = { messages: Message[]; siblings: Map<string, Message[]> };
type Streaming = { parentId: string; text: string; reasoning: string; startedAt: number };

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
  /** 当前在用的接口配置，生成回复用它 */
  const [provider, setProvider] = useState<ProviderForm>();
  const [persona, setPersona] = useState<Persona>({ name: "", description: "" });
  /** 设置弹出页开着时是哪一页 */
  const [settings, setSettings] = useState<SettingsTab>();
  const [streaming, setStreaming] = useState<Streaming>();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [deleting, setDeleting] = useState<string>();
  const abort = useRef<AbortController>(undefined);
  const [now, setNow] = useState(Date.now);
  const scroller = useRef<HTMLDivElement>(null);

  // 还没出字时每秒刷新一次等待秒数：有的中转站要等模型想完才开始返回（实测 15 秒左右）
  const waiting = Boolean(streaming && !streaming.text);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

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
    if (!store) return;
    void refreshCharacters(store);
    void run(async () => {
      setProvider((await loadProviders(store)).active);
      setPersona(await loadPersona(store));
    });
  }, [store, refreshCharacters, run]);
  useEffect(() => {
    if (store) void refreshChats(store, characterId);
  }, [store, characterId, refreshChats]);
  useEffect(() => {
    if (store) void refreshView(store, chatId);
  }, [store, chatId, refreshView]);

  // 消息区是 column-reverse，scrollTop 0 就是最底部，内容变高时浏览器自己贴着底部；换聊天时回到底部
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换聊天时执行
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [chatId]);

  const card = characters.find((c) => c.id === characterId)?.card.data;
  // 正则表跟着卡片变；稳定的引用让 MessageBody 的 memo 生效，打字时不用重新渲染所有消息
  const scripts = useMemo(() => (card ? cardRegexScripts(card) : []), [card]);
  const closeSettings = useCallback(() => setSettings(undefined), []);

  if (fatal) return <div className="splash">{`${t("app.loadFailed")}: ${fatal}`}</div>;
  if (!store) return <div className="splash">{t("app.loading")}</div>;

  /** {{user}} 用人设的名字；没填时沿用这段聊天里最后一条用户消息的名字（导入的 ST 聊天带名字） */
  const userNameOf = (path: Message[]) =>
    persona.name || path.findLast((m) => m.role === "user")?.name || t("chat.you");

  /** 生成一条回复，挂在 parentId 下面（发新消息后、重新生成时）。中途停止或出错，已收到的部分照样保存 */
  const generate = async (parentId: string) => {
    if (!chatId || !characterId) return;
    if (!provider || !isProviderReady(provider)) {
      setSettings("model");
      throw new Error(t("settings.missing"));
    }
    const [loaded, character, active] = await Promise.all([
      loadChat(store, chatId),
      getCharacter(store, characterId),
      activePreset(store),
    ]);
    if (!loaded || !character) return;
    const path = toActivePath(buildTree(loaded.messages), parentId);
    const messages = buildChatPrompt({
      card: character.data,
      userName: userNameOf(path),
      persona: persona.description,
      history: path,
      preset: active?.preset,
    });

    const controller = new AbortController();
    abort.current = controller;
    const state: Streaming = { parentId, text: "", reasoning: "", startedAt: Date.now() };
    let usage: Usage | undefined;
    setStreaming({ ...state });
    try {
      const sampling = active ? presetSampling(active.preset) : {};
      await streamChat(provider, messages, sampling, controller.signal, (event) => {
        if (event.type === "text") state.text += event.text;
        else if (event.type === "reasoning") state.reasoning += event.text;
        else if (event.type === "usage") usage = event.usage;
        setStreaming({ ...state });
      });
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    } finally {
      abort.current = undefined;
      setStreaming(undefined);
      if (state.text) {
        await appendMessage(store, chatId, {
          parentId,
          role: "assistant",
          name: character.data.name,
          content: state.text,
          extra: {
            model: provider.model,
            ...(usage && { usage }),
            ...(state.reasoning && { reasoning: state.reasoning }),
          },
        });
      }
      await refreshView(store, chatId);
    }
  };

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
    if (!content || !chatId || streaming) return;
    scroller.current?.scrollTo({ top: 0 });
    void run(async () => {
      const last = view.messages[view.messages.length - 1];
      const sent = await appendMessage(store, chatId, {
        parentId: last?.id ?? null,
        role: "user",
        name: userNameOf(view.messages),
        content,
      });
      setDraft("");
      await refreshView(store, chatId);
      await generate(sent.id);
    });
  };

  /** Enter 发送，Shift+Enter 换行；输入法还在选字时的 Enter 不算 */
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onSend();
  };

  const onRegenerate = (message: Message) => {
    if (message.parentId === null || streaming) return;
    const parentId = message.parentId;
    void run(() => generate(parentId));
  };

  const onSaveEdit = () => {
    if (!editing || !chatId) return;
    const { id, text } = editing;
    void run(async () => {
      await editMessage(store, id, text);
      setEditing(undefined);
      await refreshView(store, chatId);
    });
  };

  /** 删掉这条和它后面的整条分支；当前显示的线被删时切到还在的兄弟分支 */
  const onDelete = (message: Message) => {
    if (!chatId || streaming) return;
    void run(async () => {
      await deleteBranch(store, chatId, message.id);
      setDeleting(undefined);
      await refreshView(store, chatId);
    });
  };

  const onSwitch = (message: Message, step: number) => {
    const siblings = view.siblings.get(message.id) ?? [];
    const target = siblings[siblings.findIndex((m) => m.id === message.id) + step];
    if (!target || !chatId || streaming) return;
    void run(async () => {
      await selectBranch(store, chatId, target.id);
      await refreshView(store, chatId);
    });
  };

  // 生成中只显示到要接回复的那条为止：从中间某条重新生成时，后面的旧消息属于另一条分支
  const shown = streaming
    ? view.messages.slice(0, view.messages.findIndex((m) => m.id === streaming.parentId) + 1)
    : view.messages;
  const chat = chats.find((c) => c.id === chatId);
  const chatTitle = (c: Chat) =>
    c.title ||
    new Date(c.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className={chatId ? "layout chat-open" : "layout"}>
      <aside className="sidebar">
        {characterId && card ? (
          <>
            <header className="nav-bar">
              <button
                type="button"
                className="nav-back"
                onClick={() => {
                  setCharacterId(undefined);
                  setChatId(undefined);
                }}
              >
                <Icon name="back" />
                {t("characters.title")}
              </button>
              <div className="nav-actions">
                <label className="icon-button" title={t("chats.import")}>
                  <Icon name="import" />
                  <input type="file" accept=".jsonl" hidden onChange={onImportChat} />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  title={t("chats.new")}
                  onClick={onNewChat}
                >
                  <Icon name="plus" />
                </button>
              </div>
            </header>
            <div className="sidebar-hero">
              <Avatar name={card.name} large />
              <h1>{card.name}</h1>
            </div>
            {chats.length === 0 && <p className="sidebar-empty">{t("chats.empty")}</p>}
            <ul className="list">
              {chats.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={c.id === chatId ? "list-row selected" : "list-row"}
                    onClick={() => setChatId(c.id)}
                  >
                    <span className="list-title">{chatTitle(c)}</span>
                    <Icon name="forward" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <header className="nav-bar">
              <span />
              <div className="nav-actions">
                <button
                  type="button"
                  className="icon-button"
                  title={t("settings.title")}
                  onClick={() => setSettings("model")}
                >
                  <Icon name="gear" />
                </button>
                <label className="icon-button" title={t("characters.import")}>
                  <Icon name="plus" />
                  <input type="file" accept=".png,.json,.charx" hidden onChange={onImportCard} />
                </label>
              </div>
            </header>
            <h1 className="large-title">{t("characters.title")}</h1>
            {characters.length === 0 && <p className="sidebar-empty">{t("characters.empty")}</p>}
            <ul className="list">
              {characters.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="list-row"
                    onClick={() => {
                      setCharacterId(c.id);
                      setChatId(undefined);
                    }}
                  >
                    <Avatar name={c.card.data.name} />
                    <span className="list-title">{c.card.data.name}</span>
                    <Icon name="forward" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>

      <main className="chat">
        {chatId && chat && card ? (
          <>
            <header className="nav-bar chat-bar">
              <button
                type="button"
                className="nav-back narrow-only"
                onClick={() => setChatId(undefined)}
              >
                <Icon name="back" />
                {t("chats.title")}
              </button>
              <div className="chat-title">
                <strong>{card.name}</strong>
                <span>{chatTitle(chat)}</span>
              </div>
              <span className="narrow-only nav-spacer" />
            </header>
            {error && <ErrorBanner text={error} onClose={() => setError(undefined)} />}
            <div className="messages" ref={scroller}>
              <div className="column">
                {shown.map((m, i) => {
                  const siblings = view.siblings.get(m.id) ?? [m];
                  const index = siblings.findIndex((s) => s.id === m.id);
                  const usage = m.usage as Usage | undefined;
                  const isLast = i === shown.length - 1;
                  const actions =
                    !streaming &&
                    editing?.id !== m.id &&
                    (deleting === m.id ? (
                      <span className="message-actions visible">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setDeleting(undefined)}
                        >
                          {t("chat.cancel")}
                        </button>
                        <button
                          type="button"
                          className="text-button danger"
                          onClick={() => onDelete(m)}
                        >
                          {t("chat.confirmDelete")}
                        </button>
                      </span>
                    ) : (
                      <span className="message-actions">
                        {m.role === "assistant" && m.parentId !== null && (
                          <button
                            type="button"
                            className="icon-button small"
                            title={t("chat.regenerate")}
                            onClick={() => onRegenerate(m)}
                          >
                            <Icon name="regenerate" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button small"
                          title={t("chat.edit")}
                          onClick={() => setEditing({ id: m.id, text: m.content })}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          className="icon-button small"
                          title={t("chat.delete")}
                          onClick={() => setDeleting(m.id)}
                        >
                          <Icon name="trash" />
                        </button>
                      </span>
                    ));
                  return (
                    <article key={m.id} className={`message ${m.role}${isLast ? " last" : ""}`}>
                      <header className="message-meta">
                        <span className="name">{m.name}</span>
                        {siblings.length > 1 && (
                          <span className="switcher">
                            <button
                              type="button"
                              aria-label={t("chat.previous")}
                              disabled={index === 0 || Boolean(streaming)}
                              onClick={() => onSwitch(m, -1)}
                            >
                              <Icon name="back" />
                            </button>
                            {t("chat.branch", { index: index + 1, total: siblings.length })}
                            <button
                              type="button"
                              aria-label={t("chat.next")}
                              disabled={index === siblings.length - 1 || Boolean(streaming)}
                              onClick={() => onSwitch(m, 1)}
                            >
                              <Icon name="forward" />
                            </button>
                          </span>
                        )}
                        {!isLast && actions}
                      </header>
                      {typeof m.reasoning === "string" && m.reasoning && (
                        <details className="reasoning">
                          <summary>{t("chat.reasoning")}</summary>
                          <div className="reasoning-text">{m.reasoning}</div>
                        </details>
                      )}
                      {editing?.id === m.id ? (
                        <form
                          className="editor"
                          onSubmit={(e) => {
                            e.preventDefault();
                            onSaveEdit();
                          }}
                        >
                          <textarea
                            value={editing.text}
                            onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          />
                          <div className="editor-actions">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => setEditing(undefined)}
                            >
                              {t("chat.cancel")}
                            </button>
                            <button type="submit" className="pill-button">
                              {t("chat.save")}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <MessageBody
                          message={m}
                          depth={shown.length - 1 - i}
                          scripts={scripts}
                          charName={card.name}
                          userName={userNameOf(shown)}
                        />
                      )}
                      {(usage || (isLast && actions)) && (
                        <footer className="message-foot">
                          {usage && (
                            <span className="usage">
                              {t("chat.usage", {
                                input: usage.input,
                                cached: usage.cachedInput ?? t("chat.cacheUnknown"),
                                output: usage.output,
                              })}
                              {usage.reasoning != null &&
                                t("chat.usageReasoning", { reasoning: usage.reasoning })}
                            </span>
                          )}
                          {isLast && actions}
                        </footer>
                      )}
                    </article>
                  );
                })}
                {streaming && (
                  <article className="message assistant">
                    <header className="message-meta">
                      <span className="name">{card.name}</span>
                      <span className="status">
                        {streaming.text
                          ? t("chat.generating")
                          : t(streaming.reasoning ? "chat.thinking" : "chat.waiting", {
                              seconds: Math.max(0, Math.round((now - streaming.startedAt) / 1000)),
                            })}
                      </span>
                    </header>
                    {streaming.reasoning && (
                      <details className="reasoning">
                        <summary>{t("chat.reasoning")}</summary>
                        <div className="reasoning-text">{streaming.reasoning}</div>
                      </details>
                    )}
                    <div className="streaming-text">{streaming.text}</div>
                  </article>
                )}
              </div>
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                onSend();
              }}
            >
              <div className="composer-box">
                <textarea
                  rows={1}
                  value={draft}
                  placeholder={t("chat.placeholder")}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    // 跟着内容长高，最多 8 行左右
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                  }}
                  onKeyDown={onComposerKey}
                />
                {streaming ? (
                  <button
                    type="button"
                    className="send-button stop"
                    aria-label={t("chat.stop")}
                    onClick={() => abort.current?.abort()}
                  >
                    <Icon name="stop" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    aria-label={t("chat.send")}
                    disabled={!draft.trim()}
                  >
                    <Icon name="send" />
                  </button>
                )}
              </div>
            </form>
          </>
        ) : (
          <>
            {error && <ErrorBanner text={error} onClose={() => setError(undefined)} />}
            <div className="chat-empty">{t(characterId ? "chat.empty" : "chat.pickCharacter")}</div>
          </>
        )}
      </main>

      {settings && (
        <SettingsSheet
          store={store}
          tab={settings}
          onTab={setSettings}
          onClose={closeSettings}
          run={run}
          onProviderChange={setProvider}
          onPersonaChange={setPersona}
        />
      )}
    </div>
  );
}

/** 没有头像图片时用名字的第一个字，颜色按名字固定 */
function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  const hue = [...name].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) % 360, 0);
  return (
    <span
      className={large ? "avatar large" : "avatar"}
      style={{ background: `hsl(${hue} 45% 55%)` }}
    >
      {[...name.trim()][0] ?? "?"}
    </span>
  );
}

function ErrorBanner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{text}</span>
      <button
        type="button"
        className="icon-button small"
        aria-label={t("chat.dismiss")}
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/**
 * 显示前先过角色卡里只改显示的正则，再按 Markdown 渲染（顺序和 SillyTavern 一样）。
 * 正则改出了东西就按「认 HTML」渲染、放进沙盒 iframe；没改过的转义 HTML 后直接放进页面。
 */
const MessageBody = memo(function MessageBody(props: {
  message: Message;
  depth: number;
  scripts: ReturnType<typeof cardRegexScripts>;
  charName: string;
  userName: string;
}) {
  const { message: m, charName, userName } = props;
  const regexed = applyRegexScripts(props.scripts, m.content, {
    target: "display",
    role: m.role,
    depth: props.depth,
    charName,
    userName,
  });
  const text = replaceMacros(regexed, charName, userName);
  if (regexed !== m.content) return <MessageHtml html={htmlMarkdown.render(text)} />;
  return (
    <div
      className="markdown"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: textMarkdown 关了 HTML，原文里的标签会被转义
      dangerouslySetInnerHTML={{ __html: textMarkdown.render(text) }}
    />
  );
});
