// 存储层只通过这两个方法访问 SQLite。App 里用 tauri-plugin-sql 的 Database 实现，测试里用 Node 自带的 node:sqlite。
// 参数一律用 `?` 占位，值只能是 string、number、null：node:sqlite 不接受 boolean，两边都能用的只有这几种。
// tauri-plugin-sql 没有事务接口（每次调用可能落在连接池里不同的连接上），所以每次写入都必须是单条 SQL 语句。

export type SqlValue = string | number | null;

export interface SqlDriver {
  execute(sql: string, params?: SqlValue[]): Promise<{ rowsAffected: number }>;
  select<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}
