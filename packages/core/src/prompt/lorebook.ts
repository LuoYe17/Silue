// 世界书：决定这一轮哪些条目生效、放在提示词的哪里。
// 放置规则按缓存排布（.agents/notes/proposed/feature/2026-10-19-prompt-cache-layout.md）：
// 只有「常驻 + 放在角色设定前后」的条目进最前面的不变区，每轮都一样，能命中缓存；
// 关键词触发的、以及 SillyTavern 里插在聊天记录中间（@D）的条目，一律放到聊天记录之后。
// shortcut: 不做递归触发、token 预算、分组，导入 ST 世界书文件时一起做
import type { Lorebook, LorebookEntry } from "../card/schema.ts";

export interface LoreInput {
  book: Lorebook | undefined;
  /** 从旧到新，最后一条是这一轮用户刚发的 */
  history: { content: string }[];
  /** 抽签用，返回 [0, 1)。测试里传固定值 */
  random?: () => number;
}

export interface ActiveLore {
  /** 不变区，放在角色描述前面 */
  before: string[];
  /** 不变区，放在角色描述、性格、场景后面 */
  after: string[];
  /** 聊天记录之后 */
  tail: string[];
}

/** SillyTavern 默认只扫最近 2 条消息 */
const DEFAULT_SCAN_DEPTH = 2;
/** SillyTavern 的 extensions.position：4 表示插在聊天记录里的某个深度（@D） */
const ST_AT_DEPTH = 4;

const ext = (entry: LorebookEntry) => entry.extensions as Record<string, unknown>;

/** ST 写在 extensions 里的、V3 写在顶层的，都认；顶层优先 */
function caseSensitive(entry: LorebookEntry): boolean {
  return entry.case_sensitive ?? ext(entry).case_sensitive === true;
}

/** 关键词是否出现在文本里。use_regex 时关键词是正则，写成 /x/i 或直接写 x 都认，写错的忽略 */
export function keyMatches(entry: LorebookEntry, key: string, text: string): boolean {
  if (key.trim() === "") return false;
  const sensitive = caseSensitive(entry);
  const slashed = key.match(/^\/(.+)\/([a-z]*)$/s);
  if (entry.use_regex || slashed) {
    try {
      const flags = slashed ? (slashed[2] ?? "") : sensitive ? "" : "i";
      return new RegExp(slashed ? (slashed[1] ?? "") : key, flags.replace(/[gy]/g, "")).test(text);
    } catch {
      return false;
    }
  }
  const [k, t] = sensitive ? [key, text] : [key.toLowerCase(), text.toLowerCase()];
  // 整词匹配只对英文这类有空格分词的有意义，中文按包含处理
  if (ext(entry).match_whole_words === true && /^[\w\s]+$/.test(k)) {
    return new RegExp(`(?:^|\\W)${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\W|$)`).test(t);
  }
  return t.includes(k);
}

/** ST 的 selectiveLogic：0 任一副关键词、1 不是全部、2 一个都没有、3 全部 */
function secondaryPasses(entry: LorebookEntry, text: string): boolean {
  const keys = (entry.secondary_keys ?? []).filter((k) => k.trim() !== "");
  if (!entry.selective || keys.length === 0) return true;
  const hits = keys.filter((k) => keyMatches(entry, k, text)).length;
  switch (ext(entry).selectiveLogic) {
    case 1:
      return hits < keys.length;
    case 2:
      return hits === 0;
    case 3:
      return hits === keys.length;
    default:
      return hits > 0;
  }
}

function triggered(entry: LorebookEntry, book: Lorebook, history: { content: string }[]): boolean {
  const own = ext(entry).scan_depth;
  const depth = typeof own === "number" ? own : (book.scan_depth ?? DEFAULT_SCAN_DEPTH);
  const text = history
    .slice(Math.max(0, history.length - depth))
    .map((m) => m.content)
    .join("\n");
  return entry.keys.some((k) => keyMatches(entry, k, text)) && secondaryPasses(entry, text);
}

export function activeLore({ book, history, random = Math.random }: LoreInput): ActiveLore {
  const result: ActiveLore = { before: [], after: [], tail: [] };
  if (!book) return result;
  const entries = book.entries
    .filter((e) => e.enabled && e.content.trim() !== "")
    .filter((e) => e.constant || triggered(e, book, history))
    .filter((e) => {
      const x = ext(e);
      const probability = typeof x.probability === "number" ? x.probability : 100;
      return x.useProbability === false || probability >= 100 || random() * 100 < probability;
    })
    // ST：insertion_order 大的离结尾更近
    .sort((a, b) => a.insertion_order - b.insertion_order);

  for (const e of entries) {
    const atDepth = ext(e).position === ST_AT_DEPTH;
    if (!e.constant || atDepth) result.tail.push(e.content.trim());
    else if (e.position === "before_char" || e.position === 0) result.before.push(e.content.trim());
    else result.after.push(e.content.trim());
  }
  return result;
}
