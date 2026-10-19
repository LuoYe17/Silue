// 设置面板：iOS 风格的弹出页，分「模型」「人设」「预设」三页。
// 表单状态都在这里；保存后通过回调把生效的配置交给 App（生成回复要用）。
import {
  activePreset,
  type DocStore,
  importPreset,
  listPresets,
  loadPersona,
  movedPresetPrompts,
  type Persona,
  type PresetItem,
  type ProviderProfile,
  presetSampling,
  reasoningEffort,
  removePreset,
  type Sampling,
  savePersona,
  setActivePreset,
  setActiveProviderProfile,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@silue/core";
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "./i18n/index.ts";
import { Icon } from "./icons.tsx";
import {
  deleteProvider,
  EMPTY_FORM,
  loadProviders,
  type ProviderForm,
  saveProvider,
} from "./provider.ts";

export type SettingsTab = "model" | "persona" | "preset";

const TABS: SettingsTab[] = ["model", "persona", "preset"];

interface Props {
  store: DocStore;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  /** 包一层错误处理：出错时 App 顶部显示提示 */
  run: (fn: () => Promise<void>) => Promise<void>;
  onProviderChange: (active: ProviderForm | undefined) => void;
  onPersonaChange: (persona: Persona) => void;
}

export function SettingsSheet({ store, tab, onTab, onClose, run, ...notify }: Props) {
  const { onProviderChange, onPersonaChange } = notify;
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [persona, setPersona] = useState<Persona>({ name: "", description: "" });
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [preset, setPreset] = useState<{ id: string; moved: string[]; sampling: Sampling }>();
  const [deletingPreset, setDeletingPreset] = useState(false);
  /** 刚保存过的那一页，显示「已保存」 */
  const [saved, setSaved] = useState<SettingsTab>();

  const refreshProviders = useCallback(async () => {
    const { profiles, active } = await loadProviders(store);
    setProfiles(profiles);
    setForm(active ?? EMPTY_FORM);
    setDeletingProvider(false);
    onProviderChange(active);
  }, [store, onProviderChange]);

  const refreshPresets = useCallback(async () => {
    const [list, active] = await Promise.all([listPresets(store), activePreset(store)]);
    setPresets(list);
    setPreset(
      active && {
        id: active.id,
        moved: movedPresetPrompts(active.preset).map((p) => p.name),
        sampling: presetSampling(active.preset),
      },
    );
    setDeletingPreset(false);
  }, [store]);

  useEffect(() => {
    void run(async () => {
      await Promise.all([refreshProviders(), refreshPresets()]);
      setPersona(await loadPersona(store));
    });
  }, [store, run, refreshProviders, refreshPresets]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const edit = (patch: Partial<ProviderForm>) => {
    setSaved(undefined);
    setForm({ ...form, ...patch });
  };

  const onSaveProvider = () =>
    run(async () => {
      await saveProvider(store, form);
      await refreshProviders();
      setSaved("model");
    });

  /** 选一套配置就切过去用；选「新建」只清空表单，保存后才生效 */
  const onPickProvider = (id: string) => {
    setSaved(undefined);
    if (id === "") return setForm(EMPTY_FORM);
    void run(async () => {
      await setActiveProviderProfile(store, id);
      await refreshProviders();
    });
  };

  const onDeleteProvider = () => {
    const id = form.id;
    if (!id) return;
    void run(async () => {
      await deleteProvider(store, id);
      await refreshProviders();
    });
  };

  const onSavePersona = () =>
    run(async () => {
      await savePersona(store, persona);
      const fresh = await loadPersona(store);
      setPersona(fresh);
      onPersonaChange(fresh);
      setSaved("persona");
    });

  const onImportPreset = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(async () => {
      const id = await importPreset(store, await file.text(), file.name.replace(/\.json$/i, ""));
      await setActivePreset(store, id);
      await refreshPresets();
    });
  };

  const onPickPreset = (id: string) =>
    run(async () => {
      await setActivePreset(store, id);
      await refreshPresets();
    });

  const onDeletePreset = (id: string) =>
    run(async () => {
      await removePreset(store, id);
      await setActivePreset(store, "");
      await refreshPresets();
    });

  const effort = reasoningEffort(form.baseUrl, form.thinking ?? "default");

  return (
    // 点遮罩关闭（键盘用 Esc，见上面的 useEffect）
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩只是点击关闭的补充，键盘有 Esc
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={t("settings.title")}>
        <header className="sheet-bar">
          <span />
          <h2>{t("settings.title")}</h2>
          <button type="button" className="text-button strong" onClick={onClose}>
            {t("settings.done")}
          </button>
        </header>
        <div className="segmented" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? "selected" : ""}
              onClick={() => onTab(name)}
            >
              {t(`settings.tab.${name}`)}
            </button>
          ))}
        </div>

        <div className="sheet-body">
          {tab === "model" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onSaveProvider();
              }}
            >
              <Group>
                <Row label={t("settings.profile")}>
                  <select value={form.id ?? ""} onChange={(e) => onPickProvider(e.target.value)}>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.model || p.baseUrl}
                      </option>
                    ))}
                    <option value="">{t("settings.newProfile")}</option>
                  </select>
                </Row>
              </Group>
              <Group footer={t("settings.apiKeyFooter")}>
                <Row label={t("settings.name")}>
                  <input
                    value={form.name}
                    placeholder={t("settings.namePlaceholder")}
                    onChange={(e) => edit({ name: e.target.value })}
                  />
                </Row>
                <Row label={t("settings.baseUrl")}>
                  <input
                    value={form.baseUrl}
                    placeholder="https://api.example.com"
                    onChange={(e) => edit({ baseUrl: e.target.value })}
                  />
                </Row>
                <Row label={t("settings.model")}>
                  <input value={form.model} onChange={(e) => edit({ model: e.target.value })} />
                </Row>
                <Row label={t("settings.apiKey")}>
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => edit({ apiKey: e.target.value })}
                  />
                </Row>
              </Group>
              <Group
                footer={
                  effort === undefined
                    ? t("settings.thinkingNone")
                    : t("settings.thinkingActual", { value: effort })
                }
              >
                <Row label={t("settings.thinking")}>
                  <select
                    value={form.thinking ?? "default"}
                    onChange={(e) => edit({ thinking: e.target.value as ThinkingLevel })}
                  >
                    {THINKING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`thinking.${level}`)}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
              <Group footer={saved === "model" ? t("settings.saved") : undefined}>
                <button type="submit" className="row-button">
                  {t("settings.save")}
                </button>
              </Group>
              {form.id && (
                <Group>
                  {deletingProvider ? (
                    <>
                      <button
                        type="button"
                        className="row-button danger"
                        onClick={onDeleteProvider}
                      >
                        {t("settings.confirmDeleteProfile")}
                      </button>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => setDeletingProvider(false)}
                      >
                        {t("chat.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="row-button danger"
                      onClick={() => setDeletingProvider(true)}
                    >
                      {t("settings.deleteProfile")}
                    </button>
                  )}
                </Group>
              )}
            </form>
          )}

          {tab === "persona" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onSavePersona();
              }}
            >
              <Group footer={t("persona.footer")}>
                <Row label={t("persona.name")}>
                  <input
                    value={persona.name}
                    placeholder={t("persona.namePlaceholder")}
                    onChange={(e) => {
                      setSaved(undefined);
                      setPersona({ ...persona, name: e.target.value });
                    }}
                  />
                </Row>
                <label className="row stacked">
                  <span className="row-label">{t("persona.description")}</span>
                  <textarea
                    rows={8}
                    value={persona.description}
                    placeholder={t("persona.descriptionPlaceholder")}
                    onChange={(e) => {
                      setSaved(undefined);
                      setPersona({ ...persona, description: e.target.value });
                    }}
                  />
                </label>
              </Group>
              <Group footer={saved === "persona" ? t("settings.saved") : undefined}>
                <button type="submit" className="row-button">
                  {t("settings.save")}
                </button>
              </Group>
            </form>
          )}

          {tab === "preset" && (
            <>
              <Group
                footer={
                  preset &&
                  [
                    Object.keys(preset.sampling).length > 0
                      ? t("preset.sampling", {
                          values: Object.entries(preset.sampling)
                            .map(([k, v]) => `${k === "maxTokens" ? "max_tokens" : k}: ${v}`)
                            .join(", "),
                        })
                      : t("preset.noSampling"),
                    preset.moved.length > 0 &&
                      t("preset.moved", { names: preset.moved.join("、") }),
                  ]
                    .filter(Boolean)
                    .join("\n")
                }
              >
                <Row label={t("preset.active")}>
                  <select
                    value={preset?.id ?? ""}
                    onChange={(e) => void onPickPreset(e.target.value)}
                  >
                    <option value="">{t("preset.none")}</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
              <Group>
                <label className="row-button">
                  <Icon name="import" />
                  {t("preset.import")}
                  <input type="file" accept=".json" hidden onChange={onImportPreset} />
                </label>
              </Group>
              {preset && (
                <Group>
                  {deletingPreset ? (
                    <>
                      <button
                        type="button"
                        className="row-button danger"
                        onClick={() => void onDeletePreset(preset.id)}
                      >
                        {t("preset.confirmDelete")}
                      </button>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => setDeletingPreset(false)}
                      >
                        {t("chat.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="row-button danger"
                      onClick={() => setDeletingPreset(true)}
                    >
                      {t("preset.delete")}
                    </button>
                  )}
                </Group>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** iOS 的分组列表：圆角白底的一组行，下面可以带一行灰色说明 */
function Group({ children, footer }: { children: ReactNode; footer?: string | undefined }) {
  return (
    <section className="group">
      <div className="group-rows">{children}</div>
      {footer && <p className="group-footer">{footer}</p>}
    </section>
  );
}

/** 左边是名字、右边是输入框的一行 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: children 是 input 或 select
    <label className="row">
      <span className="row-label">{label}</span>
      {children}
    </label>
  );
}
