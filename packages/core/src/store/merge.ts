// 字段级「后写者胜」合并，见 .agents/notes/implemented/architecture/2026-10-19-doc-store.md
// 每个字段带一个时钟 [毫秒时间戳, 设备 id]，先比时间戳，相同再比设备 id，大的胜。
// 删除标记也当作一个字段，键是 DELETED_FIELD。合并满足交换律和结合律，两台设备按任意顺序收到对方的改动，结果都一样。

export type Clock = readonly [ts: number, deviceId: string];
export type Fields = Record<string, unknown>;

export const DELETED_FIELD = "$deleted";

export interface DocState {
  data: Fields;
  clocks: Record<string, Clock>;
  deleted: boolean;
}

export function compareClocks(a: Clock, b: Clock): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

export function mergeDocs(a: DocState, b: DocState): DocState {
  const data: Fields = {};
  const clocks: Record<string, Clock> = {};
  for (const field of new Set([...Object.keys(a.clocks), ...Object.keys(b.clocks)])) {
    const ca = a.clocks[field];
    const cb = b.clocks[field];
    const fromB = ca === undefined || (cb !== undefined && compareClocks(cb, ca) > 0);
    const winner = fromB ? b : a;
    clocks[field] = (fromB ? cb : ca) as Clock;
    if (field !== DELETED_FIELD && field in winner.data) data[field] = winner.data[field];
  }
  const deletedFromB =
    a.clocks[DELETED_FIELD] === undefined ||
    (b.clocks[DELETED_FIELD] !== undefined &&
      compareClocks(b.clocks[DELETED_FIELD], a.clocks[DELETED_FIELD]) > 0);
  return { data, clocks, deleted: deletedFromB ? b.deleted : a.deleted };
}

/** 文档里最新的那个时钟，用来填 updated_at 和 device_id 两列 */
export function latestClock(clocks: Record<string, Clock>): Clock {
  let latest: Clock = [0, ""];
  for (const c of Object.values(clocks)) if (compareClocks(c, latest) > 0) latest = c;
  return latest;
}
