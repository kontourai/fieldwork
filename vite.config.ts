import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist/browser", emptyOutDir: true },
  server: { host: "127.0.0.1" }
});
