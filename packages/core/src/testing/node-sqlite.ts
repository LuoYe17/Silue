// 测试用的 SqlDriver：Node 24 自带的 SQLite，内存库，和 App 里的 tauri-plugin-sql 跑同一套 SQL。
import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "../store/driver.ts";

export function nodeSqliteDriver(path = ":memory:"): SqlDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  return {
    db,
    async execute(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return { rowsAffected: Number(result.changes) };
    },
    async select<T>(sql: string, params: (string | number | null)[] = []) {
      // node:sqlite 返回的行没有原型，转成普通对象，方便测试里直接比较
      return db
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row }) as T);
    },
  };
}
