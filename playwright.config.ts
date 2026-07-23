import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./test/browser", timeout: 15_000, use: { browserName: "chromium", headless: true, viewport: { width: 1280, height: 800 } }, reporter: "list" });
