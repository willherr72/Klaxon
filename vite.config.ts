import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    // 1430 rather than Tauri's default 1420: another Tauri project on this
    // machine already claims 1420, and strictPort means no silent fallback.
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1431 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        alert: resolve(__dirname, "alert.html"),
      },
    },
  },
});
