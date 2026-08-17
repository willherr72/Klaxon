import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Separate from vite.config.ts on purpose: that config declares the three
// real HTML entry points and a fixed dev-server port, neither of which a
// test run should care about.
//
// `hot: false` matters — the Svelte plugin's HMR wrapper interferes with
// component teardown between tests.
export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Components under test import from @tauri-apps/api, which expects a
    // Tauri host. Individual tests mock the modules they need; this just
    // keeps the browser-condition resolution the plugin expects.
    environmentOptions: {
      jsdom: { pretendToBeVisual: true },
    },
  },
  resolve: {
    // Vitest would otherwise resolve Svelte's server build, which has no
    // DOM lifecycle and silently renders nothing.
    conditions: ["browser"],
  },
});
