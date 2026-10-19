// 最简界面：用来在真 App 里把存储层和模型调用跑一遍（导入卡、导入聊天、发消息、生成回复、切换备选）。
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
  importPreset,
  importStChat,
  importStChatToStore,
  listCharacters,
  listChats,
  listPresets,
  loadChat,
  loadPersona,
  type Message,
  movedPresetPrompts,
  type Persona,
  type PresetItem,
  type ProviderProfile,
  reasoningEffort,
  replaceMacros,
  savePersona,
  selectBranch,
  setActivePreset,
  setActiveProviderProfile,
  siblingsOf,
  THINKING_LEVELS,
  type ThinkingLevel,
  activePath as toActivePath,
  type Usage,
} from "@silue/core";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { openStore } from "./db.ts";
import { errorText, t } from "./i18n/index.ts";
import { MessageHtml } from "./MessageHtml.tsx";
import {
  deleteProvider,
  EMPTY_FORM,
  isProviderReady,
  loadProviders,
  type ProviderForm,
  saveProvider,
  streamChat,
} from "./provider.ts";
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
  /** 当前在用的配置（已保存的），生成回复用它 */
  const [provider, setProvider] = useState<ProviderForm>();
  /** 设置面板里正在编辑的配置，保存前不影响生成 */
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  /** 已保存的人设；personaForm 是面板里正在改的 */
  const [persona, setPersona] = useState<Persona>({ name: "", description: "" });
  const [personaForm, setPersonaForm] = useState<Persona>(persona);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [personaSaved, setPersonaSaved] = useState(false);
  const [presets, setPresets] = useState<PresetItem[]>([]);
  /** 当前选中的预设和它被挪到聊天记录之后的条目名 */
  const [preset, setPreset] = useState<{ id: string; moved: string[] }>();
  const [presetOpen, setPresetOpen] = useState(false);
  const [streaming, setStreaming] = useState<Streaming>();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [deleting, setDeleting] = useState<string>();
  const abort = useRef<AbortController>(undefined);
  const [now, setNow] = useState(Date.now);

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

  const refreshPresets = useCallback(async (s: DocStore) => {
    const [list, active] = await Promise.all([listPresets(s), activePreset(s)]);
    setPresets(list);
    setPreset(
      active && { id: active.id, moved: movedPresetPrompts(active.preset).map((p) => p.name) },
    );
  }, []);

  const refreshProviders = useCallback(async (s: DocStore) => {
    const { profiles, active } = await loadProviders(s);
    setProfiles(profiles);
    setProvider(active);
    setForm(active ?? EMPTY_FORM);
    setDeletingProvider(false);
  }, []);

  useEffect(() => {
    if (!store) return;
    void refreshCharacters(store);
    refreshProviders(store).catch((err) => setError(errorText(err)));
    refreshPresets(store).catch((err) => setError(errorText(err)));
    loadPersona(store).then(
      (p) => {
        setPersona(p);
        setPersonaForm(p);
      },
      (err) => setError(errorText(err)),
    );
  }, [store, refreshCharacters, refreshProviders, refreshPresets]);
  useEffect(() => {
    if (store) void refreshChats(store, characterId);
  }, [store, characterId, refreshChats]);
  useEffect(() => {
    if (store) void refreshView(store, chatId);
  }, [store, chatId, refreshView]);

  if (fatal) return <div className="center">{`${t("app.loadFailed")}: ${fatal}`}</div>;
  if (!store) return <div className="center">{t("app.loading")}</div>;

  /** 生成一条回复，挂在 parentId 下面（发新消息后、重新生成时）。中途停止或出错，已收到的部分照样保存 */
  const generate = async (parentId: string) => {
    if (!chatId || !characterId) return;
    if (!provider || !isProviderReady(provider)) {
      setSettingsOpen(true);
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
      await streamChat(provider, messages, controller.signal, (event) => {
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

  const onImportPreset = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(async () => {
      const id = await importPreset(store, await file.text(), file.name.replace(/\.json$/i, ""));
      await setActivePreset(store, id);
      await refreshPresets(store);
    });
  };

  const onPickPreset = (id: string) => {
    void run(async () => {
      await setActivePreset(store, id);
      await refreshPresets(store);
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

  /** {{user}} 用人设的名字；没填时沿用这段聊天里最后一条用户消息的名字（导入的 ST 聊天带名字） */
  const userNameOf = (path: Message[]) =>
    persona.name || path.findLast((m) => m.role === "user")?.name || t("chat.you");

  const onSavePersona = () => {
    void run(async () => {
      await savePersona(store, personaForm);
      const saved = await loadPersona(store);
      setPersona(saved);
      setPersonaForm(saved);
      setPersonaSaved(true);
    });
  };

  const onSaveSettings = () => {
    void run(async () => {
      await saveProvider(store, form);
      await refreshProviders(store);
      setSettingsSaved(true);
    });
  };

  /** 下拉框选一套配置就切过去用；选「新建」只清空表单，保存后才生效 */
  const onPickProvider = (id: string) => {
    setSettingsSaved(false);
    if (id === "") return setForm(EMPTY_FORM);
    void run(async () => {
      await setActiveProviderProfile(store, id);
      await refreshProviders(store);
    });
  };

  const onDeleteProvider = () => {
    const id = form.id;
    if (!id) return;
    void run(async () => {
      await deleteProvider(store, id);
      await refreshProviders(store);
    });
  };

  const card = characters.find((c) => c.id === characterId)?.card.data;
  const scripts = card ? cardRegexScripts(card) : [];
  // 生成中只显示到要接回复的那条为止：从中间某条重新生成时，后面的旧消息属于另一条分支
  const shown = streaming
    ? view.messages.slice(0, view.messages.findIndex((m) => m.id === streaming.parentId) + 1)
    : view.messages;
  const effort = reasoningEffort(form.baseUrl, form.thinking ?? "default");

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
        <button
          type="button"
          className="item settings-toggle"
          onClick={() => {
            setSettingsOpen(!settingsOpen);
            setSettingsSaved(false);
          }}
        >
          {t("settings.title")}
        </button>
        {settingsOpen && (
          <form
            className="settings"
            onSubmit={(e) => {
              e.preventDefault();
              onSaveSettings();
            }}
          >
            <label>
              {t("settings.profile")}
              <select value={form.id ?? ""} onChange={(e) => onPickProvider(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.model || p.baseUrl}
                  </option>
                ))}
                <option value="">{t("settings.newProfile")}</option>
              </select>
            </label>
            <label>
              {t("settings.name")}
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              {t("settings.baseUrl")}
              <input
                value={form.baseUrl}
                placeholder="https://api.example.com"
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label>
              {t("settings.model")}
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            </label>
            <label>
              {t("settings.apiKey")}
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </label>
            <label>
              {t("settings.thinking")}
              <select
                value={form.thinking ?? "default"}
                onChange={(e) => setForm({ ...form, thinking: e.target.value as ThinkingLevel })}
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`thinking.${level}`)}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">
              {effort === undefined
                ? t("settings.thinkingNone")
                : t("settings.thinkingActual", { value: effort })}
            </span>
            <button type="submit" className="button">
              {t("settings.save")}
            </button>
            {settingsSaved && <span className="hint">{t("settings.saved")}</span>}
            {form.id &&
              (deletingProvider ? (
                <span className="actions">
                  <button type="button" className="link danger" onClick={onDeleteProvider}>
                    {t("settings.confirmDeleteProfile")}
                  </button>
                  <button type="button" className="link" onClick={() => setDeletingProvider(false)}>
                    {t("chat.cancel")}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="link danger"
                  onClick={() => setDeletingProvider(true)}
                >
                  {t("settings.deleteProfile")}
                </button>
              ))}
          </form>
        )}
        <button
          type="button"
          className="item settings-toggle"
          onClick={() => {
            setPersonaOpen(!personaOpen);
            setPersonaSaved(false);
          }}
        >
          {t("persona.title")}
        </button>
        {personaOpen && (
          <form
            className="settings"
            onSubmit={(e) => {
              e.preventDefault();
              onSavePersona();
            }}
          >
            <label>
              {t("persona.name")}
              <input
                value={personaForm.name}
                onChange={(e) => setPersonaForm({ ...personaForm, name: e.target.value })}
              />
            </label>
            <label>
              {t("persona.description")}
              <textarea
                rows={6}
                value={personaForm.description}
                onChange={(e) => setPersonaForm({ ...personaForm, description: e.target.value })}
              />
            </label>
            <button type="submit" className="button">
              {t("settings.save")}
            </button>
            {personaSaved && <span className="hint">{t("settings.saved")}</span>}
          </form>
        )}
        <button
          type="button"
          className="item settings-toggle"
          onClick={() => setPresetOpen(!presetOpen)}
        >
          {t("preset.title")}
        </button>
        {presetOpen && (
          <div className="settings">
            <label>
              {t("preset.active")}
              <select value={preset?.id ?? ""} onChange={(e) => onPickPreset(e.target.value)}>
                <option value="">{t("preset.none")}</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {preset && preset.moved.length > 0 && (
              <span className="hint">{t("preset.moved", { names: preset.moved.join("、") })}</span>
            )}
            <label className="button">
              {t("preset.import")}
              <input type="file" accept=".json" hidden onChange={onImportPreset} />
            </label>
          </div>
        )}
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
          {shown.map((m, i) => {
            const siblings = view.siblings.get(m.id) ?? [m];
            const index = siblings.findIndex((s) => s.id === m.id);
            const usage = m.usage as Usage | undefined;
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
                  {!streaming && editing?.id !== m.id && (
                    <span className="actions-inline">
                      {m.role === "assistant" && m.parentId !== null && (
                        <button type="button" className="link" onClick={() => onRegenerate(m)}>
                          {t("chat.regenerate")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="link"
                        onClick={() => setEditing({ id: m.id, text: m.content })}
                      >
                        {t("chat.edit")}
                      </button>
                      {deleting === m.id ? (
                        <>
                          <button type="button" className="link danger" onClick={() => onDelete(m)}>
                            {t("chat.confirmDelete")}
                          </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => setDeleting(undefined)}
                          >
                            {t("chat.cancel")}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="link" onClick={() => setDeleting(m.id)}>
                          {t("chat.delete")}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {typeof m.reasoning === "string" && m.reasoning && (
                  <details className="reasoning">
                    <summary>{t("chat.reasoning")}</summary>
                    <div className="content">{m.reasoning}</div>
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
                    <div className="actions">
                      <button type="submit" className="button">
                        {t("chat.save")}
                      </button>
                      <button type="button" className="link" onClick={() => setEditing(undefined)}>
                        {t("chat.cancel")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <MessageBody
                    message={m}
                    depth={shown.length - 1 - i}
                    scripts={scripts}
                    charName={card?.name ?? m.name}
                    userName={userNameOf(shown)}
                  />
                )}
                {usage && (
                  <div className="usage">
                    {t("chat.usage", {
                      input: usage.input,
                      cached: usage.cachedInput ?? t("chat.cacheUnknown"),
                      output: usage.output,
                    })}
                    {usage.reasoning != null &&
                      t("chat.usageReasoning", { reasoning: usage.reasoning })}
                  </div>
                )}
              </article>
            );
          })}
          {streaming && (
            <article className="message assistant">
              <div className="meta">
                <span className="name">
                  {streaming.text
                    ? t("chat.generating")
                    : t(streaming.reasoning ? "chat.thinking" : "chat.waiting", {
                        seconds: Math.max(0, Math.round((now - streaming.startedAt) / 1000)),
                      })}
                </span>
                <button type="button" className="link" onClick={() => abort.current?.abort()}>
                  {t("chat.stop")}
                </button>
              </div>
              {streaming.reasoning && (
                <details className="reasoning">
                  <summary>{t("chat.reasoning")}</summary>
                  <div className="content">{streaming.reasoning}</div>
                </details>
              )}
              <div className="content">{streaming.text}</div>
            </article>
          )}
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
            <button type="submit" className="button" disabled={Boolean(streaming)}>
              {t("chat.send")}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

/** 显示前先过角色卡里只改显示的正则；改出了 HTML 就放进沙盒 iframe，没改就按纯文本显示 */
function MessageBody(props: {
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
  return regexed === m.content ? (
    <div className="content">{text}</div>
  ) : (
    <MessageHtml html={text} />
  );
}
