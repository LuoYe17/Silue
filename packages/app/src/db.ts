// 打开本机的 SQLite（tauri-plugin-sql），包成 core 的 SqlDriver，再交给 DocStore。
import { DocStore, type SqlDriver } from "@silue/core";
import Database from "@tauri-apps/plugin-sql";

const DEVICE_ID_KEY = "silue.deviceId";

// shortcut: 设备 id 存在 WebView 的 localStorage 里，清掉 WebView 数据会换一个新 id；
// 做同步之前要挪进数据库或系统安全存储
function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_ID_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export async function openStore(): Promise<DocStore> {
  const db = await Database.load("sqlite:silue.db");
  const driver: SqlDriver = {
    execute: (sql, params) => db.execute(sql, params),
    select: <T>(sql: string, params?: (string | number | null)[]) => db.select<T[]>(sql, params),
  };
  return DocStore.open(driver, deviceId());
}
