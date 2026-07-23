import { test, expect } from "@playwright/test";
import { runFieldwork } from "../../src/fieldwork.js";
import { openRun } from "../../src/server.js";
import { tempRoot } from "../helpers.js";

test("review links a grounded candidate to a durable browser decision", async ({ page }) => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("browser") });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url); await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const candidate = page.getByRole("button", { name: /record\.status .*fieldwork-deterministic-v1/ });
    await candidate.click();
    await expect(page.getByLabel("Highlighted for record.status")).toBeVisible();
    await page.getByRole("button", { name: /Source highlight for record\.status/ }).click();
    await expect(candidate).toBeFocused();
    await page.getByTestId("use-proposed").click();
    await expect(page.getByLabel("Fieldwork status")).toContainText("Saved");
    await page.reload(); await expect(page.getByTestId("decided-chip")).toHaveText("Accepted");
    await expect(page).toHaveScreenshot("fieldwork-review.png", { fullPage: true, maxDiffPixels: 500 });
  } finally { await server.close(); }
});

test("review has a mobile visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("browser-mobile") });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url); await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const primary = [page.getByTestId("keep-current"), page.getByTestId("use-proposed")];
    for (const control of primary) {
      await expect(control).toBeVisible();
      const visual = await control.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, box: node.getBoundingClientRect().toJSON() }));
      expect(visual.background).not.toBe("rgba(0, 0, 0, 0)"); expect(visual.background).not.toBe("transparent");
      expect(visual.box.x).toBeGreaterThanOrEqual(0); expect(visual.box.x + visual.box.width).toBeLessThanOrEqual(390);
    }
    await expect(page.getByTestId("could-not-confirm")).toBeVisible();
    const geometry = await page.evaluate(() => { const copy = document.querySelector(".topbar-copy")!.getBoundingClientRect(), meta = document.querySelector(".topbar-meta")!.getBoundingClientRect(); return { body: document.body.scrollWidth === document.body.clientWidth, doc: document.documentElement.scrollWidth === document.documentElement.clientWidth, overlap: !(copy.bottom <= meta.top || meta.bottom <= copy.top || copy.right <= meta.left || meta.right <= copy.left), brand: getComputedStyle(document.documentElement).getPropertyValue("--k-brand").trim(), topbar: getComputedStyle(document.querySelector(".topbar")!).backgroundColor }; });
    expect(geometry.body).toBe(true); expect(geometry.doc).toBe(true); expect(geometry.overlap).toBe(false); expect(geometry.brand).not.toBe(""); expect(geometry.topbar).not.toBe("rgba(0, 0, 0, 0)");
    await expect(page).toHaveScreenshot("fieldwork-review-mobile.png", { fullPage: true, maxDiffPixels: 500 });
  }
  finally { await server.close(); }
});

test("a stale page surfaces the conflict and reconciles to server-owned review state", async ({ browser }) => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("browser-conflict") });
  const server = await openRun(run.runDirectory);
  const context = await browser.newContext();
  const first = await context.newPage(), stale = await context.newPage();
  try {
    await Promise.all([first.goto(server.url), stale.goto(server.url)]);
    await Promise.all([
      expect(first.getByTestId("review-workbench-shell")).toBeVisible(),
      expect(stale.getByTestId("review-workbench-shell")).toBeVisible()
    ]);
    await first.getByTestId("use-proposed").click();
    await expect(first.getByLabel("Fieldwork status")).toContainText("Saved");
    await stale.getByTestId("wrong-toggle").check();
    await stale.getByTestId("use-proposed").click();
    await expect(stale.getByLabel("Fieldwork status")).toContainText("conflict", { ignoreCase: true });
    await expect(stale.getByTestId("decided-chip")).toContainText("Accepted");
  } finally {
    await context.close();
    await server.close();
  }
});
