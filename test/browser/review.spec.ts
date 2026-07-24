import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFieldwork } from "../../src/fieldwork.js";
import { openRun } from "../../src/server.js";
import { tempRoot } from "../helpers.js";
import {
  formatImageBytes,
  formatPdfBytes,
  formatSourceAdapters,
} from "../format-fixtures.js";

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
    // Native select text/chevrons can vary slightly across otherwise identical
    // Chromium captures. Keep the allowance well below 0.1% of this full-page
    // image while structural and interaction assertions verify the controls.
    await expect(page).toHaveScreenshot("fieldwork-review.png", { fullPage: true, maxDiffPixels: 1_500 });
  } finally { await server.close(); }
});

test("composed Survey workbench bounds and searches a thousand review items", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("browser-large-review"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.route("**/api/v1/run", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const template = body.review.snapshot.items[0];
      const items = Array.from({ length: 1_005 }, (_, index) => ({
        ...structuredClone(template),
        metadata: {
          ...structuredClone(template.metadata),
          name: `large-item-${String(index).padStart(4, "0")}`,
        },
        spec: {
          ...structuredClone(template.spec),
          target: index === 1_004 ? "needle-field" : `large.field.${index}`,
        },
      }));
      body.review.snapshot = {
        ...body.review.snapshot,
        items,
        activeItemName: items[0].metadata.name,
      };
      body.review.items = items;
      await route.fulfill({ response, json: body });
    });
    await page.goto(server.url);
    await expect(page.getByTestId("review-field")).toHaveCount(50);
    await expect(page.getByText("1–50 of 1005")).toBeVisible();
    await page.getByTestId("queue-search").fill("needle");
    await expect(page.getByTestId("review-field")).toHaveCount(1);
    await expect(page.locator('[data-field="needle-field"]')).toBeVisible();
  } finally {
    await server.close();
  }
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

test("format-native PDF and OCR context is visible in the shared inspector", async ({ page }) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "fieldwork-format-browser-"));
  const pdfPath = join(sourceRoot, "source.pdf");
  const imagePath = join(sourceRoot, "source.png");
  await writeFile(pdfPath, formatPdfBytes);
  await writeFile(imagePath, formatImageBytes);

  const pdfRun = await runFieldwork({
    taskPath: "conformance/formats/task.json",
    sourcePath: pdfPath,
    sourceAdapters: formatSourceAdapters,
    root: await tempRoot("browser-format-pdf"),
  });
  const pdfServer = await openRun(pdfRun.runDirectory);
  try {
    await page.goto(pdfServer.url);
    const candidate = page.getByRole("button", {
      name: /record\.status .*PDF page 2 .*1 layout element .*1 table cell/,
    });
    await expect(candidate).toBeVisible();
    await expect(page.getByLabel(/Prepared source for fieldwork-import:format-conformance/))
      .toContainText("Status: Active");
    await expect(page).toHaveScreenshot("fieldwork-format-inspection.png", {
      fullPage: true,
      maxDiffPixels: 1_500,
    });
  } finally {
    await pdfServer.close();
  }

  const imageRun = await runFieldwork({
    taskPath: "conformance/formats/task.json",
    sourcePath: imagePath,
    sourceAdapters: formatSourceAdapters,
    root: await tempRoot("browser-format-image"),
  });
  const imageServer = await openRun(imageRun.runDirectory);
  try {
    await page.goto(imageServer.url);
    await expect(page.getByRole("button", { name: /record\.status .*OCR-derived/ })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Prepared text is OCR-derived");
  } finally {
    await imageServer.close();
  }
});
