import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  build: {
    // mi30/A4: emit source maps as hidden (no //# sourceMappingURL reference
    // in the bundles) so production crash stacks stay decodable without
    // shipping the maps to end users.
    sourcemap: "hidden",
    // mi31: Tauri v2 webviews are evergreen Chromium (WebView2) / WKWebView
    // ~Safari 15+ on supported macOS — no ES2020 down-transpile needed.
    target: ["es2022", "chrome105", "safari15"],
    // PERF (2026-09-06): no custom manualChunks. The previous rules ("babel"
    // for anything @babel/*, "syntax" for react-syntax-highlighter/highlight
    // .js/lowlight/refractor/prismjs, "stable vendor buckets for caching")
    // backfired: Rollup hoisted the shared vite module-loader helpers INTO
    // the syntax chunk, which made the ENTRY chunk statically import it
    // (syntax → babel too), and index.html modulepreloaded ~4.5 MB (babel
    // 2.98 MB + syntax 1.6 MB) at startup. With default chunking the heavy
    // libs stay behind their dynamic imports (own chunks, own hashes — still
    // cache-stable, since a chunk's hash changes only when its own module
    // graph changes) and shared helpers stay in the entry. Entry went
    // 1,179 KB → ~460 KB and the modulepreload tags are gone. Revisit only
    // with rollup-plugin-visualizer evidence, not to "re-add caching".
    rollupOptions: {},
  },
  server: {
    port: 1500,
    strictPort: true,
    host: "localhost",
    watch: {
      // tell vite to ignore watching `src-tauri`, plus scratch dirs whose
      // transient locked files (browser profiles, logs) crash the watcher
      // with EBUSY and take the whole dev server down
      ignored: ["**/src-tauri/**", "**/.playwright-mcp/**", "**/target/**", "**/logs/**"],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // `bridge_selfui.test.mjs` is a standalone node/jsdom script for the
    // Rust-injected self-UI bridge, NOT a vitest suite — it declares no
    // `test()` calls and drives the bridges by hand through jsdom. Vitest's
    // default glob sweeps it up under src-tauri and fails the whole run on a
    // missing suite. Run it separately: `npm run test:selfui`.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/src-tauri/**",
      "**/.playwright-mcp/**",
      "**/target/**",
    ],
  },
}));
