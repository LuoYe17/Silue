// 核心逻辑：不依赖界面、Tauri 和浏览器，app 和 worker 共用。
// tsconfig 不带 DOM 类型，biome.json 禁止 import @tauri-apps/* 和 react，两道检查一起守住这条边界。

export const APP_NAME = "Silue";

export * from "./card/import.ts";
export * from "./card/schema.ts";
export * from "./chat/import-st.ts";
export * from "./chat/repo.ts";
export * from "./chat/tree.ts";
export * from "./llm/openai.ts";
export * from "./llm/profiles.ts";
export * from "./llm/thinking.ts";
export * from "./prompt/chat-prompt.ts";
export * from "./store/doc-store.ts";
export type { SqlDriver, SqlValue } from "./store/driver.ts";
export * from "./store/merge.ts";
