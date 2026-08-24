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
    rollupOptions: {
      output: {
        // mi32: stable vendor buckets for long-term caching. Only names the
        // already-lazy heavy libs (so app-code edits don't invalidate them);
        // everything else keeps Vite's default dynamic-import chunking.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@babel")) return "babel";
          if (id.includes("mermaid") || id.includes("katex")) return undefined; // already own chunks
          if (
            id.includes("react-syntax-highlighter") ||
            id.includes("highlight.js") ||
            id.includes("lowlight") ||
            id.includes("refractor") ||
            id.includes("prismjs")
          ) {
            return "syntax";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1500,
    strictPort: true,
    host: "localhost",
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
