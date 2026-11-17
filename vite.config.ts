import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // Plain CSS needs no external PostCSS configuration lookup at startup.
  css: { postcss: { plugins: [] } },
  optimizeDeps: {
    // The application has one HTML entry. Do not crawl tools, UE or temporary
    // preview artifacts to discover unrelated HTML entry points.
    entries: ["index.html"],
    include: ["fuse.js", "pinyin"]
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    warmup: { clientFiles: ["./src/main.tsx"] },
    // Bootstrap caches, portable tools and prototype documents are not renderer
    // sources. Their changes must not interrupt or reload the application.
    watch: {
      ignored: ["**/.cache/**", "**/.tmp/**", "**/tools/**", "**/Output/**", "**/docs/**", "**/UE/**"]
    }
  }
});
