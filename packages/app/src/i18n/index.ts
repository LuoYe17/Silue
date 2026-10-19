import { CardImportError, ChatImportError, PresetImportError, ProviderError } from "@silue/core";
import { en } from "./en.ts";
import { type MessageKey, zhCN } from "./zh-CN.ts";

const messages: Record<MessageKey, string> = navigator.language.toLowerCase().startsWith("zh")
  ? zhCN
  : en;

/** 取界面文字，{name} 换成 params 里的值 */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** core 抛出的错误只带代码，在这里翻译成给用户看的话 */
export function errorText(err: unknown): string {
  if (err instanceof CardImportError) return t(`error.card.${err.code}`);
  if (err instanceof ChatImportError) return t(`error.chat.${err.code}`, { line: err.line ?? "?" });
  if (err instanceof PresetImportError) return t(`error.preset.${err.code}`);
  if (err instanceof ProviderError) {
    return t(`error.provider.${err.code}`, { status: err.status ?? "", detail: err.detail });
  }
  return t("error.unknown", { message: err instanceof Error ? err.message : String(err) });
}
