// 消息树的纯函数：不碰数据库，输入一段聊天的全部消息。
// 每条消息记着 parentId；同一个父消息下的多条消息是兄弟（左右滑动看的备选回复、分支）。
// 开场白和备选开场白是 parentId 为 null 的兄弟。聊天当前显示哪条线，由 chat.leafId 决定。

export type Role = "user" | "assistant" | "system";

export interface MessageData {
  [key: string]: unknown;
  chatId: string;
  parentId: string | null;
  role: Role;
  name: string;
  content: string;
  createdAt: number;
}

export interface Message extends MessageData {
  id: string;
}

export interface Tree {
  byId: Map<string, Message>;
  /** 键是父消息 id（根是 null），值按 createdAt、id 排好序 */
  children: Map<string | null, Message[]>;
}

export function buildTree(messages: Message[]): Tree {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const children = new Map<string | null, Message[]>();
  for (const m of messages) {
    // 父消息不在（被删了）的消息挂不上树，当作不存在
    if (m.parentId !== null && !byId.has(m.parentId)) continue;
    const list = children.get(m.parentId) ?? [];
    list.push(m);
    children.set(m.parentId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }
  return { byId, children };
}

/** 从根到 leafId 的那条线。leafId 找不到时返回空数组。 */
export function activePath(tree: Tree, leafId: string | null): Message[] {
  const path: Message[] = [];
  let current = leafId === null ? undefined : tree.byId.get(leafId);
  while (current) {
    path.push(current);
    current = current.parentId === null ? undefined : tree.byId.get(current.parentId);
  }
  return path.reverse();
}

/** 从 id 往下一直走最新的那个子消息，返回走到底的消息 id。切换分支后用它决定显示到哪。 */
export function latestLeaf(tree: Tree, id: string): string {
  let current = id;
  for (;;) {
    const kids = tree.children.get(current);
    const last = kids?.[kids.length - 1];
    if (!last) return current;
    current = last.id;
  }
}

/** 和这条消息同一个父消息的所有消息（包括它自己），按顺序 */
export function siblingsOf(tree: Tree, message: Message): Message[] {
  return tree.children.get(message.parentId) ?? [message];
}

/** 这条消息和它下面的所有消息 */
export function subtreeIds(tree: Tree, id: string): string[] {
  const ids: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    ids.push(current);
    for (const child of tree.children.get(current) ?? []) stack.push(child.id);
  }
  return ids;
}
