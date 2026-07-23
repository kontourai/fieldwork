import { test, expect } from "@playwright/test";
import { runFieldwork } from "../../src/fieldwork.js";
import { openRun } from "../../src/server.js";
import { tempRoot } from "../helpers.js";

test("rendered review path exposes landmarks, names, focus, and keyboard activation", async ({ page }) => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("a11y") });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByRole("heading", { name: "Grounded review" })).toBeVisible();
    await expect(page.getByLabel("Fieldwork status")).toBeVisible();
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const proposed = page.getByTestId("use-proposed");
    await proposed.focus();
    await expect(proposed).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Fieldwork status")).toContainText("Saved");
    await expect(page.getByTestId("decided-chip")).toHaveText("Accepted");
    const unnamedButtons = await page.locator("button").evaluateAll((buttons) =>
      buttons.filter((button) => !(button.getAttribute("aria-label") || button.getAttribute("aria-labelledby") || button.textContent?.trim())).length
    );
    expect(unnamedButtons).toBe(0);
  } finally { await server.close(); }
});
