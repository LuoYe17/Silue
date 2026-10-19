// 核心逻辑：不依赖界面、Tauri 和浏览器，app 和 worker 共用。
// tsconfig 不带 DOM 类型，biome.json 禁止 import @tauri-apps/* 和 react，两道检查一起守住这条边界。

export const APP_NAME = "Silue";

export * from "./card/import.ts";
export * from "./card/schema.ts";
export * from "./chat/import-st.ts";
