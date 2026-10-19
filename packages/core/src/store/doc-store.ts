// 文档存储：所有数据都存在一张 docs 表里，一行一个文档，data 列是 JSON 对象。
// 设计和取舍见 .agents/notes/implemented/architecture/2026-10-19-doc-store.md
import type { SqlDriver, SqlValue } from "./driver.ts";
import {
  type Clock,
  DELETED_FIELD,
  type DocState,
  type Fields,
  latestClock,
  mergeDocs,
} from "./merge.ts";

export interface StoredDoc<T extends Fields = Fields> extends DocState {
  collection: string;
  id: string;
  data: T;
  /** 本机改动的顺序号，同步时按它找出还没上传的改动；从别的设备收到的新文档是 0 */
  seq: number;
}

interface DocRow {
  collection: string;
  id: string;
  data: string;
  clocks: string;
  deleted: number;
  seq: number;
}

// 每个版本是一组语句，逐条执行（没有事务）。全部写成 IF NOT EXISTS，中途崩溃后重跑也安全。
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      clocks TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (collection, id)
    )`,
    // 不用 WITHOUT ROWID（https://sqlite.org/withoutrowid.html）：它的主键本身就包含整行数据，没有统计信息时 SQLite 会优先走主键，
    // 不走下面的 docs_chat 索引（2026-10-19 用 EXPLAIN QUERY PLAN 实测）。SQLite 文档也说，
    // 行数据较大（超过页面的 1/20）时不适合用 WITHOUT ROWID，而聊天消息和角色卡正是大行。
    "CREATE INDEX IF NOT EXISTS docs_seq ON docs (seq)",
    // 按聊天取消息用；查询里的 json_extract 表达式必须和这里一字不差，索引才会生效
    "CREATE INDEX IF NOT EXISTS docs_chat ON docs (collection, json_extract(data, '$.chatId'))",
  ],
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// SQLite 默认一条语句最多 32766 个参数；每行 8 个参数，留足余量
const INSERT_BATCH = 500;

export class DocStore {
  readonly deviceId: string;
  private readonly sql: SqlDriver;
  private readonly now: () => number;
  private lastTs = 0;
  private seq = 0;
  // 读-改-写必须串行，不然两个并发的 put 会互相覆盖
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(sql: SqlDriver, deviceId: string, now: () => number) {
    this.sql = sql;
    this.deviceId = deviceId;
    this.now = now;
  }

  static async open(sql: SqlDriver, deviceId: string, now: () => number = Date.now) {
    const store = new DocStore(sql, deviceId, now);
    const [{ user_version: version } = { user_version: 0 }] = await sql.select<{
      user_version: number;
    }>("PRAGMA user_version");
    for (let v = version; v < MIGRATIONS.length; v++) {
      for (const statement of MIGRATIONS[v] ?? []) await sql.execute(statement);
      await sql.execute(`PRAGMA user_version = ${v + 1}`);
    }
    const [row] = await sql.select<{ seq: number | null }>("SELECT max(seq) AS seq FROM docs");
    store.seq = row?.seq ?? 0;
    return store;
  }

  async get<T extends Fields>(collection: string, id: string): Promise<StoredDoc<T> | undefined> {
    const doc = await this.getIncludingDeleted<T>(collection, id);
    return doc?.deleted ? undefined : doc;
  }

  /** 列出一个集合里没删除的文档；where 只支持按顶层字段判等 */
  async list<T extends Fields>(
    collection: string,
    where: Record<string, SqlValue> = {},
  ): Promise<StoredDoc<T>[]> {
    const conditions = ["collection = ?", "deleted = 0"];
    const params: SqlValue[] = [collection];
    for (const [field, value] of Object.entries(where)) {
      // 字段名要拼进 SQL（索引要求路径是字面量），所以只允许标识符
      if (!NAME.test(field)) throw new Error(`invalid field name: ${field}`);
      conditions.push(`json_extract(data, '$.${field}') = ?`);
      params.push(value);
    }
    const rows = await this.sql.select<DocRow>(
      `SELECT * FROM docs WHERE ${conditions.join(" AND ")}`,
      params,
    );
    return rows.map((r) => toDoc<T>(r));
  }

  /** 改文档里的若干字段（没有就新建）。只有 patch 里出现的字段会更新时钟。 */
  put<T extends Fields>(collection: string, id: string, patch: Partial<T>): Promise<StoredDoc<T>> {
    return this.serial(async () => {
      const existing = await this.getIncludingDeleted<T>(collection, id);
      const data: Fields = { ...existing?.data };
      const clocks = { ...existing?.clocks };
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        data[field] = value;
        clocks[field] = this.tick(existing?.clocks[field]);
      }
      if (existing?.deleted) clocks[DELETED_FIELD] = this.tick(existing.clocks[DELETED_FIELD]);
      const doc = { collection, id, data: data as T, clocks, deleted: false, seq: ++this.seq };
      await this.write([doc], "upsert");
      return doc;
    });
  }

  /** 一次插入很多新文档（导入用）。id 已存在会报错，不会覆盖。 */
  insertMany(docs: { collection: string; id: string; data: Fields }[]): Promise<void> {
    return this.serial(async () => {
      const stored = docs.map(({ collection, id, data }) => {
        const clocks: Record<string, Clock> = {};
        for (const field of Object.keys(data)) clocks[field] = this.tick();
        return { collection, id, data, clocks, deleted: false, seq: ++this.seq };
      });
      for (let i = 0; i < stored.length; i += INSERT_BATCH) {
        await this.write(stored.slice(i, i + INSERT_BATCH), "insert");
      }
    });
  }

  /** 打删除标记，不真删：同步时对方要知道这条被删了 */
  remove(collection: string, id: string): Promise<void> {
    return this.removeMany(collection, [id]);
  }

  removeMany(collection: string, ids: string[]): Promise<void> {
    return this.serial(async () => {
      const docs: StoredDoc[] = [];
      for (const id of ids) {
        const existing = await this.getIncludingDeleted(collection, id);
        if (!existing || existing.deleted) continue;
        const clocks = { ...existing.clocks };
        clocks[DELETED_FIELD] = this.tick(existing.clocks[DELETED_FIELD]);
        docs.push({ ...existing, clocks, deleted: true, seq: ++this.seq });
      }
      for (let i = 0; i < docs.length; i += INSERT_BATCH) {
        await this.write(docs.slice(i, i + INSERT_BATCH), "upsert");
      }
    });
  }

  /** 合并从别的设备收到的文档。不改 seq：合并结果里本机的字段早就记过 seq 了。 */
  applyRemote(remote: Omit<StoredDoc, "seq">): Promise<void> {
    return this.serial(async () => {
      const existing = await this.getIncludingDeleted(remote.collection, remote.id);
      const merged = existing ? mergeDocs(existing, remote) : remote;
      // 别的设备的时钟可能比本机快；以后本机再写，时间戳要比它大
      this.lastTs = Math.max(this.lastTs, latestClock(merged.clocks)[0]);
      await this.write(
        [{ ...merged, collection: remote.collection, id: remote.id, seq: existing?.seq ?? 0 }],
        "upsert",
      );
    });
  }

  /** 本机在 seq 之后的改动（含删除），按顺序 */
  async changesSince(seq: number, limit = 500): Promise<StoredDoc[]> {
    const rows = await this.sql.select<DocRow>(
      "SELECT * FROM docs WHERE seq > ? ORDER BY seq LIMIT ?",
      [seq, limit],
    );
    return rows.map((r) => toDoc(r));
  }

  private async getIncludingDeleted<T extends Fields>(collection: string, id: string) {
    const [row] = await this.sql.select<DocRow>(
      "SELECT * FROM docs WHERE collection = ? AND id = ?",
      [collection, id],
    );
    return row ? toDoc<T>(row) : undefined;
  }

  /** 本机单调递增的毫秒时间，给消息的 createdAt 用：同一毫秒里连发两条也能分出先后 */
  timestamp(): number {
    return this.tick()[0];
  }

  // 本机时钟只增不减；同一字段的新时钟一定大于旧时钟，即使系统时间被往回调过
  private tick(previous?: Clock): Clock {
    const ts = Math.max(this.now(), this.lastTs + 1, (previous?.[0] ?? 0) + 1);
    this.lastTs = ts;
    return [ts, this.deviceId];
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  private async write(docs: StoredDoc[], mode: "insert" | "upsert") {
    if (docs.length === 0) return;
    const params: SqlValue[] = [];
    for (const d of docs) {
      const [updatedAt, deviceId] = latestClock(d.clocks);
      params.push(
        d.collection,
        d.id,
        JSON.stringify(d.data),
        JSON.stringify(d.clocks),
        d.deleted ? 1 : 0,
        updatedAt,
        deviceId,
        d.seq,
      );
    }
    const values = docs.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const upsert =
      mode === "upsert"
        ? ` ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, clocks = excluded.clocks,
            deleted = excluded.deleted, updated_at = excluded.updated_at,
            device_id = excluded.device_id, seq = excluded.seq`
        : "";
    await this.sql.execute(
      `INSERT INTO docs (collection, id, data, clocks, deleted, updated_at, device_id, seq)
       VALUES ${values}${upsert}`,
      params,
    );
  }
}

function toDoc<T extends Fields>(row: DocRow): StoredDoc<T> {
  return {
    collection: row.collection,
    id: row.id,
    data: JSON.parse(row.data) as T,
    clocks: JSON.parse(row.clocks) as Record<string, Clock>,
    deleted: row.deleted === 1,
    seq: row.seq,
  };
}
