import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时把 /api 代理到本地后端（只绑定 127.0.0.1）。
export default defineConfig({
  plugins: [react()],
  // Keep the reference's inline declarations, including backdrop-filter and its fallback.
  build: { cssMinify: false },
  resolve: { alias: process.env.ZB_TEST_BUNDLE ? { "../../public/offline/bundle.json": process.env.ZB_TEST_BUNDLE } : {} },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", port: 4173 },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], pool: "vmThreads" },
});
