// 把角色卡和当前这条线的聊天拼成发给模型的消息。
// 顺序按缓存友好排（.agents/notes/proposed/feature/2026-10-19-prompt-cache-layout.md）：
// 不变的系统提示和角色卡在最前，聊天记录只往后追加，每轮都会变的 post_history_instructions 放最后。
// shortcut: 还没有预设、世界书、用户人设、正则，导入预设时换成按预设条目拼装
import type { CardData } from "../card/schema.ts";
import type { Role } from "../chat/tree.ts";
import type { ChatMessage } from "../llm/openai.ts";

/** 没导入预设时的系统提示，沿用 SillyTavern 默认的 Main Prompt */
export const DEFAULT_MAIN_PROMPT =
  "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.";

export interface ChatPromptInput {
  card: CardData;
  userName: string;
  /** 从开场白到最后一条，按顺序 */
  history: { role: Role; content: string }[];
}

/** 替换 {{char}}、{{user}} 和 V1 时代的 <BOT>、<USER>，不区分大小写 */
export function replaceMacros(text: string, charName: string, userName: string): string {
  return text
    .replace(/\{\{char\}\}|<BOT>/gi, () => charName)
    .replace(/\{\{user\}\}|<USER>/gi, () => userName);
}

export function buildChatPrompt({ card, userName, history }: ChatPromptInput): ChatMessage[] {
  const fill = (text: string) => replaceMacros(text, card.name, userName);
  // 卡片自带的系统提示优先，{{original}} 表示「在默认提示的基础上加」（V2 规格）
  const main = card.system_prompt.trim()
    ? card.system_prompt.replace(/\{\{original\}\}/gi, () => DEFAULT_MAIN_PROMPT)
    : DEFAULT_MAIN_PROMPT;
  const system = [
    main,
    card.description,
    card.personality.trim() && `{{char}}'s personality: ${card.personality}`,
    card.scenario.trim() && `Scenario: ${card.scenario}`,
    card.mes_example.trim() && `Example dialogue:\n${card.mes_example}`,
  ]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");

  const messages: ChatMessage[] = [{ role: "system", content: fill(system) }];
  for (const m of history) messages.push({ role: m.role, content: fill(m.content) });
  if (card.post_history_instructions.trim()) {
    messages.push({ role: "system", content: fill(card.post_history_instructions.trim()) });
  }
  return messages;
}
