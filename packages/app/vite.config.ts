import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri 开发时连这个固定端口，见 src-tauri/tauri.conf.json 的 build.devUrl
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
