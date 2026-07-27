import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemSnapshotStore, type Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { reviewedExport, runFieldwork } from "../../src/fieldwork.js";
import { recheckFieldwork } from "../../src/recheck.js";
import { openRun } from "../../src/server.js";
import { tempRoot } from "../helpers.js";
import {
  formatImageBytes,
  formatPdfBytes,
  formatSourceAdapters,
} from "../format-fixtures.js";

const visualSnapshotsEnabled = process.env.FIELDWORK_VISUAL_SNAPSHOTS !== "0";

test("review presents grounded vendor-renewal evidence and a durable decision", async ({ page }) => {
  const run = await runFieldwork({ taskPath: "examples/vendor-obligations/task.json", sourcePath: "examples/vendor-obligations/source.txt", root: await tempRoot("browser-vendor-renewal") });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url); await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const candidate = page.getByRole("button", { name: /vendor\.name .*fieldwork-deterministic-v1/ });
    await candidate.click();
    const reviewField = page.locator('[data-field="vendor.name"]');
    await expect(page.getByLabel("Highlighted for vendor.name")).toBeVisible();
    // Survey's source anchor is a 1px keyboard skip-target ("activate to return
    // to candidate"), not a pointer-sized control; it only accepted a mouse
    // click while it was rendering as an unstyled native button.
    const anchor = page.getByRole("button", { name: /Source highlight for vendor\.name/ });
    await anchor.focus();
    await expect(anchor).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(candidate).toBeFocused();
    await reviewField.getByTestId("use-proposed").click();
    await expect(page.getByLabel("Fieldwork status")).toContainText("Saved");
    await expect(reviewField.getByTestId("decided-chip")).toHaveText("Accepted");
    await page.reload();
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    await expect(page.locator('[data-field="vendor.name"]').getByTestId("decided-chip")).toHaveText("Accepted");
    // Native select text/chevrons can vary slightly across otherwise identical
    // Chromium captures. Keep the allowance well below 0.1% of this full-page
    // image while structural and interaction assertions verify the controls.
    if (visualSnapshotsEnabled) {
      await expect(page).toHaveScreenshot("fieldwork-review.png", { fullPage: true, maxDiffPixels: 1_500 });
    }
  } finally { await server.close(); }
});

test("a reviewer can decide every field, including typed ones, and export", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-full-review"),
  });
  const server = await openRun(run.runDirectory);
  const mutations: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/review")) mutations.push(response.status());
  });
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const fields = await page.getByTestId("review-field")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-field")));
    // number and date fields were permanently undecidable: the click emitted no
    // request at all, so `export` could never be reached through the UI.
    expect(fields).toContain("commercial.annualFeeUsd");
    expect(fields).toContain("renewal.date");
    for (const field of fields) {
      const card = page.locator(`[data-field="${field}"]`);
      await card.getByTestId("use-proposed").click();
      await expect(card.getByTestId("decided-chip")).toHaveText("Accepted");
    }
    await expect(page.getByLabel("Fieldwork status")).toContainText(`Saved ${fields.length}`);
    // One accepted mutation per decision: no decision may be silently dropped,
    // and none may be rejected as a spurious append-only conflict.
    expect(mutations).toEqual(fields.map(() => 200));
    await page.reload();
    await expect(page.getByTestId("decided-chip").first()).toHaveText("Accepted");
    await expect(page.getByTestId("decided-chip")).toHaveCount(fields.length);
    const exported = await reviewedExport(run.runDirectory);
    expect(exported.claims.map((claim) => claim.fieldOrBehavior).sort()).toEqual([...fields].sort());
  } finally { await server.close(); }
});

test("one 1440x900 frame carries the document, the evidence, and an open decision", async ({ page }) => {
  // The measured failure this replaces: a single fixed-width column at every
  // viewport, 4245px tall for seven fields, whose first screen reached a filter
  // bar and never a decision.
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-first-screen"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const frame = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const source = box(".fieldwork-column-source");
      const review = box(".fieldwork-column-review");
      const document_ = box(".inspector-source pre");
      const highlights = [...document.querySelectorAll(".inspector-source mark")];
      const decision = box('[data-testid="use-proposed"]');
      return {
        sideBySide: source.right <= review.left + 1,
        documentTop: document_.top,
        documentShare: (document_.width * Math.min(document_.height, 900 - document_.top)) / (1440 * 900),
        highlightsInFrame: highlights.filter((mark) => mark.getBoundingClientRect().bottom <= 900).length,
        progressBottom: box(".rhead .progress").bottom,
        decisionBottom: decision.bottom,
        pageHeight: document.body.scrollHeight,
      };
    });
    expect(frame.sideBySide).toBe(true);
    // The document, its highlights, how far the review has got, and a decision
    // the reviewer can actually take — all above the fold.
    expect(frame.documentTop).toBeLessThan(400);
    expect(frame.highlightsInFrame).toBeGreaterThanOrEqual(7);
    expect(frame.progressBottom).toBeLessThan(900);
    expect(frame.decisionBottom).toBeLessThan(900);
    // The document was 3.5% of the screen. It is now the left column's subject.
    expect(frame.documentShare).toBeGreaterThan(0.15);
    expect(frame.pageHeight).toBeLessThan(3_000);
    // The frame itself is the acceptance criterion, so it gets a baseline of
    // its own — a viewport capture, not a full-page scroll.
    if (visualSnapshotsEnabled) {
      await expect(page).toHaveScreenshot("fieldwork-review-frame.png", { maxDiffPixels: 1_500 });
    }
  } finally {
    await server.close();
  }
});

test("every fact carries its locator and links to the source highlight it came from", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-locator"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const provenance = await page.evaluate(() => [...document.querySelectorAll('[data-testid="proposed-excerpt"] .from')]
      .map((from) => {
        const link = from.querySelector("a");
        const href = link?.getAttribute("href") ?? "";
        return {
          text: from.textContent ?? "",
          href,
          resolves: href.startsWith("#") && Boolean(document.getElementById(href.slice(1))),
        };
      }));
    expect(provenance).toHaveLength(7);
    for (const entry of provenance) {
      // The exact locator was sixth inside a collapsed audit accordion.
      expect(entry.text).toMatch(/chars:\d+-\d+/);
      expect(entry.text).toContain("Vendor renewal review");
      // ...and the 64-hex digest that used to print here belongs in the record.
      expect(entry.text).not.toMatch(/[0-9a-f]{32,}/);
      // Trip-wire for main.tsx's mirror of Survey's private highlight id.
      expect(entry.resolves).toBe(true);
    }
    // The digest is still one hover away, and still whole in the audit record.
    await expect(page.locator(".fieldwork-document-digest")).toHaveAttribute("title", /[0-9a-f]{64}/);
    await page.getByTestId("audit-details").first().click();
    await expect(page.getByTestId("audit-details").first()).toContainText("Raw Source ID");
  } finally {
    await server.close();
  }
});

test("selecting a fact shows it in the document, and selecting a span shows the fact", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-selection"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const card = page.locator('[data-field="renewal.date"]');
    await card.locator(".excerpt .from a").click();
    await expect(page.locator("mark[data-fw-active]")).toHaveText(/Renewal date: 2027-04-01/);
    // The fragment link must never navigate: the launch capability is the hash.
    expect(new URL(page.url()).hash).toContain("cap=");

    await page.locator("mark", { hasText: "Hosting region: United States" }).click();
    await expect(page.locator('[data-testid="review-field"][data-fw-active]'))
      .toHaveAttribute("data-field", "data.hostingRegion");

    // Clicking the fact itself is the obvious way to ask where it came from, and
    // it was the one gesture that did nothing: the link ran document-to-queue,
    // and queue-to-document only through the small `from` link inside a card.
    const posture = page.locator('[data-field="renewal.posture"]');
    await posture.locator(".fname").click();
    await expect(page.locator('[data-testid="review-field"][data-fw-active]'))
      .toHaveAttribute("data-field", "renewal.posture");
    await expect(page.locator("mark[data-fw-active]")).toHaveText(/Renewal posture: automatic/);

    // ...but a control inside the card still owns its own click.
    await posture.getByTestId("use-proposed").click();
    await expect(posture.getByTestId("decided-chip")).toHaveText("Accepted");

    // A decision rebuilds the queue; the selection has to survive that.
    await card.getByTestId("use-proposed").click();
    await expect(card.getByTestId("decided-chip")).toHaveText("Accepted");
    await expect(page.locator('[data-testid="review-field"][data-fw-active]')).toHaveCount(1);
    // Release the keep-alive socket the decision opened, so closing the loopback
    // server does not sit out Node's idle timeout.
    await page.close();
  } finally {
    await server.close();
  }
});

test("could not confirm asks for its reason instead of dying silently", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-unconfirmed"),
  });
  const server = await openRun(run.runDirectory);
  const mutations: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/review")) mutations.push(response.status());
  });
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    // The example is written around this decision: the security assurance names
    // a report that has not been delivered, and export stays refused until the
    // reviewer resolves it.
    const card = page.locator('[data-field="security.assurance"]');
    const note = card.getByTestId("reviewer-note");
    await expect(note).toBeHidden();

    // Survey requires a reason for this decision and renders the reason field
    // inside the collapsed audit accordion, so the button focused a hidden
    // textarea, reported validity on it, and did nothing a reviewer could see.
    await card.getByTestId("could-not-confirm").click();
    await expect(note).toBeVisible();
    expect(mutations).toEqual([]);
    await expect(card.getByTestId("decided-chip")).toHaveText("Needs review");

    await note.fill("2026 SOC 2 report has not been delivered.");
    await card.getByTestId("could-not-confirm").click();
    await expect(card.getByTestId("decided-chip")).toHaveText("Could not confirm");
    await expect(card).toHaveAttribute("data-decision", "could-not-confirm");
    expect(mutations.every((status) => status === 200)).toBe(true);
    await page.close();
  } finally {
    await server.close();
  }
});

test("a field reads as a field name, not as the identifier it is stored under", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-labels"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const labels = await page.locator('[data-testid="review-field"] .fname').allTextContents();
    // Survey's humanizeIdentifier renders these as `Commercial.Annual Fee Usd`.
    expect(labels).toEqual([
      "Vendor name",
      "Commercial annual fee (USD)",
      "Renewal date",
      "Renewal posture",
      "Renewal notice (days)",
      "Security assurance",
      "Data hosting region",
    ]);
    // No dotted path, no camelCase seam, no Title Case On Every Word.
    for (const label of labels) {
      expect(label).not.toContain(".");
      expect(label.replace(/\(USD\)|\(days\)/g, "")).not.toMatch(/[a-z] [A-Z]/);
    }
  } finally {
    await server.close();
  }
});

test("audit details reads as an audit trail, not a database dump", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-audit"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const card = page.locator('[data-field="vendor.name"]');
    // The Surface projection preview only renders once a decision exists — that
    // is the state that grew to 27 rows and a 2KB payload.
    await card.getByTestId("use-proposed").click();
    await expect(card.getByTestId("decided-chip")).toHaveText("Accepted");
    await card.getByTestId("audit-details").click();

    const audit = await card.evaluate((node) => {
      const details = node.querySelector('[data-testid="audit-details"]')!;
      for (const nested of details.querySelectorAll("details")) nested.setAttribute("open", "");
      const shown = (el: Element) => el.getClientRects().length > 0;
      const rows = [...details.querySelectorAll<HTMLElement>(".kv")];
      return {
        rendered: rows.length,
        visible: rows.filter(shown).map((row) => row.dataset.auditRow ?? ""),
        sections: [...details.querySelectorAll("[data-testid^='surface-']")]
          .filter(shown).map((section) => section.getAttribute("data-testid")),
      };
    });

    // Survey emits the rows; the host decides which a reviewer reads. Every
    // pruned row is either printed again under another label in the same
    // accordion, already on the face of the card, or a constant saying a thing
    // is absent. All of them stay whole in `fieldwork inspect` and the export.
    expect(audit.rendered).toBeGreaterThan(audit.visible.length);
    for (const gone of ["locator", "model", "extracted-at", "excerpt", "history"]) {
      expect(audit.visible).not.toContain(gone);
    }
    // What an audit trail is: the claim, the evidence, who decided and when.
    for (const kept of ["claim-id", "source-reference", "observed", "actor", "reviewed-at", "outcome", "checksum"]) {
      expect(audit.visible).toContain(kept);
    }
    // Each identifier survives exactly once, where it used to print two or three
    // times under "Raw Source ID", "Source Reference" and "Raw source ID".
    expect(audit.visible.filter((row) => row === "raw-source-id")).toHaveLength(1);
    expect(audit.visible.filter((row) => row === "extraction-id")).toHaveLength(1);
    // Two rows to report that no authority trace is present is not a record.
    expect(audit.sections).not.toContain("surface-authority-trace");
    expect(audit.sections).not.toContain("surface-candidate-history");
    expect(audit.sections).toContain("surface-review-event");
    await page.close();
  } finally {
    await server.close();
  }
});

test("the filter bar stays behind a disclosure until the queue needs it", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-filters"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    // Eight select elements filtering seven fields used to be the largest
    // visual mass on the screen.
    await expect(page.locator("select:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "Filter evidence" }).click();
    await expect(page.locator(".inspector-filters select:visible")).toHaveCount(7);
    await page.getByRole("button", { name: "Find fields" }).click();
    await expect(page.getByTestId("queue-disposition")).toBeVisible();
    await page.getByRole("button", { name: "Filter evidence" }).click();
    await expect(page.locator(".inspector-filters select:visible")).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("the review surface resolves shared @kontourai/ui tokens", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-tokens"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const measured = await page.evaluate(() => {
      const read = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const root = getComputedStyle(document.documentElement);
      const embed = read(".survey-workbench-embed");
      const mark = read(".inspector-source mark");
      const anchor = read(".highlight-anchor");
      return {
        rootBrand: root.getPropertyValue("--k-brand").trim(),
        shellBrand: read(".fieldwork-shell").getPropertyValue("--k-brand").trim(),
        embedBrand: embed.getPropertyValue("--k-brand").trim(),
        embedFont: embed.fontFamily,
        markBackground: mark.backgroundColor,
        markUnderline: mark.boxShadow,
        anchorWidth: anchor.width,
        anchorBorder: anchor.borderTopWidth,
        panelRadius: read(".panel").borderRadius,
        pageBackground: root.backgroundColor,
      };
    });
    // One brand across the page: the host shell, the Kontour shell tokens, and
    // the embedded Survey surface must all resolve the same value.
    expect(measured.embedBrand).not.toBe("");
    expect(measured.embedBrand).toBe(measured.shellBrand);
    expect(measured.shellBrand).toBe(measured.rootBrand);
    expect(measured.embedFont).toContain("Hanken Grotesk");
    // The grounded highlight is the product; it must actually be painted.
    expect(measured.markBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(measured.markBackground).not.toBe("transparent");
    expect(measured.markUnderline).not.toBe("none");
    // Survey's keyboard return-anchors must not render as native buttons.
    expect(measured.anchorWidth).toBe("1px");
    expect(measured.anchorBorder).toBe("0px");
    expect(measured.panelRadius).not.toBe("0px");
    expect(measured.pageBackground).not.toBe("rgba(0, 0, 0, 0)");
  } finally { await server.close(); }
});

test("the embed survives @kontourai/ui's unscoped global class names", async ({ page }) => {
  // `.progress`, `.empty` and `.eyebrow` are generic names that @kontourai/ui's
  // React primitives claim as unscoped globals and Survey's workbench uses for
  // different elements. This is a host-composition collision, not a Survey
  // defect: it is unaffected by survey#202/#203 and still live on survey 2.2.3.
  // Without src/browser/style.css's containment, ui's `.progress` collapses the
  // decided-count row to its own 8px determinate bar — with an opaque
  // background and a border — and the apply button overflows its container.
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-global-collisions"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const measured = await page.evaluate(() => {
      const el = (selector: string) => document.querySelector(selector);
      const progress = el(".survey-workbench-embed .progress")!;
      const apply = el(".survey-workbench-embed .apply")!;
      const style = getComputedStyle(progress);
      // A first-round `.val.current.empty` is hidden — the `New` chip already
      // says the field has no prior value. Force it back into flow before
      // measuring, or this assertion passes on a display:none element and stops
      // proving anything about ui's padding.
      const empty = el(".survey-workbench-embed .val.empty") as HTMLElement | null;
      if (empty) empty.style.display = "block";
      const eyebrow = el(".survey-workbench-embed .eyebrow");
      return {
        progressHeight: progress.getBoundingClientRect().height,
        progressBackground: style.backgroundColor,
        progressBorder: style.borderTopWidth,
        applyOverflow: apply.getBoundingClientRect().bottom - progress.getBoundingClientRect().bottom,
        emptyRendered: empty ? empty.getBoundingClientRect().height > 0 : false,
        emptyPadding: empty ? getComputedStyle(empty).padding : undefined,
        eyebrowFont: eyebrow ? getComputedStyle(eyebrow).fontFamily : undefined,
      };
    });
    // Survey's header row, not ui's 8px bar.
    expect(measured.progressHeight).toBeGreaterThan(24);
    expect(measured.progressBackground).toBe("rgba(0, 0, 0, 0)");
    expect(measured.progressBorder).toBe("0px");
    // The apply button must sit inside the row that holds it.
    expect(measured.applyOverflow).toBeLessThanOrEqual(0);
    expect(measured.emptyRendered).toBe(true);
    expect(measured.emptyPadding).toBe("0px");
    expect(measured.eyebrowFont).not.toMatch(/Mono/i);
  } finally {
    await server.close();
  }
});

test("a host can brand the selected run and inject bounded navigation", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("browser-host"),
  });
  const server = await openRun(run.runDirectory, {
    presentation: {
      apiVersion: "fieldwork.kontourai.io/v1",
      kind: "FieldworkHostPresentation",
      eyebrow: "Station",
      title: "Evidence review",
      theme: "light",
      navigation: [{ label: "Task overview", href: "https://station.kontourai.io/tasks/fixture" }],
      returnAction: { label: "Return to Station", href: "https://station.kontourai.io/" },
    },
  });
  try {
    await page.goto(server.url);
    await expect(page.getByRole("heading", { name: "Evidence review" })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Host navigation" });
    await expect(navigation.getByRole("link", { name: "Task overview" }))
      .toHaveAttribute("href", "https://station.kontourai.io/tasks/fixture");
    await expect(navigation.getByRole("link", { name: "Return to Station" }))
      .toHaveAttribute("href", "https://station.kontourai.io/");
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
  } finally {
    await server.close();
  }
});

test("an explicitly allowed host origin can embed the protected review UI", async ({ page }) => {
  let fieldworkUrl = "";
  const host = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; frame-src http://127.0.0.1:*",
    }).end(`<!doctype html><title>Host</title><iframe title="Hosted Fieldwork" src="${fieldworkUrl}"></iframe>`);
  });
  await new Promise<void>((resolvePromise, reject) => {
    host.once("error", reject);
    host.listen({ host: "127.0.0.1", port: 0 }, resolvePromise);
  });
  const address = host.address() as AddressInfo;
  const hostOrigin = `http://127.0.0.1:${address.port}`;
  const run = await runFieldwork({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("browser-embedded-host"),
  });
  const fieldwork = await openRun(run.runDirectory, { embeddingOrigin: hostOrigin });
  fieldworkUrl = fieldwork.url;
  const otherHost = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; frame-src http://127.0.0.1:*",
    }).end(`<!doctype html><title>Other host</title><iframe title="Hosted Fieldwork" src="${fieldworkUrl}"></iframe>`);
  });
  await new Promise<void>((resolvePromise, reject) => {
    otherHost.once("error", reject);
    otherHost.listen({ host: "127.0.0.1", port: 0 }, resolvePromise);
  });
  const otherAddress = otherHost.address() as AddressInfo;
  const otherHostOrigin = `http://127.0.0.1:${otherAddress.port}`;
  try {
    await page.goto(otherHostOrigin);
    await page.waitForTimeout(250);
    expect(page.frames().some((frame) => frame.url().startsWith(fieldwork.baseUrl))).toBe(false);

    await page.goto(hostOrigin);
    const frame = page.frameLocator('iframe[title="Hosted Fieldwork"]');
    await expect(frame.getByRole("heading", { name: "Grounded review" })).toBeVisible();
    await expect(frame.getByTestId("review-workbench-shell")).toBeVisible();
  } finally {
    await fieldwork.close();
    await new Promise<void>((resolvePromise, reject) => {
      otherHost.close((error) => error ? reject(error) : resolvePromise());
    });
    await new Promise<void>((resolvePromise, reject) => {
      host.close((error) => error ? reject(error) : resolvePromise());
    });
  }
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
    // A long queue is the case where filtering is the only way through, so the
    // disclosure opens itself rather than hiding the only usable control.
    await expect(page.getByTestId("queue-disposition")).toBeVisible();
    await expect(page.getByText("1–50 of 1005")).toBeVisible();
    await page.getByTestId("queue-search").fill("needle");
    await expect(page.getByTestId("review-field")).toHaveCount(1);
    await expect(page.locator('[data-field="needle-field"]')).toBeVisible();
  } finally {
    await server.close();
  }
});

test("review has a responsive mobile layout and optional visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const run = await runFieldwork({ taskPath: "examples/vendor-obligations/task.json", sourcePath: "examples/vendor-obligations/source.txt", root: await tempRoot("browser-mobile-vendor-renewal") });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url); await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    await expect(page.getByTestId("review-field")).toHaveCount(7);
    const primary = [page.getByTestId("keep-current").first(), page.getByTestId("use-proposed").first()];
    for (const control of primary) {
      await expect(control).toBeVisible();
      const visual = await control.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, box: node.getBoundingClientRect().toJSON() }));
      expect(visual.background).not.toBe("rgba(0, 0, 0, 0)"); expect(visual.background).not.toBe("transparent");
      expect(visual.box.x).toBeGreaterThanOrEqual(0); expect(visual.box.x + visual.box.width).toBeLessThanOrEqual(390);
    }
    await expect(page.getByTestId("could-not-confirm").first()).toBeVisible();
    const geometry = await page.evaluate(() => { const copy = document.querySelector(".topbar-copy")!.getBoundingClientRect(), meta = document.querySelector(".topbar-meta")!.getBoundingClientRect(); return { body: document.body.scrollWidth === document.body.clientWidth, doc: document.documentElement.scrollWidth === document.documentElement.clientWidth, overlap: !(copy.bottom <= meta.top || meta.bottom <= copy.top || copy.right <= meta.left || meta.right <= copy.left), brand: getComputedStyle(document.documentElement).getPropertyValue("--k-brand").trim(), topbar: getComputedStyle(document.querySelector(".topbar")!).backgroundColor }; });
    expect(geometry.body).toBe(true); expect(geometry.doc).toBe(true); expect(geometry.overlap).toBe(false); expect(geometry.brand).not.toBe(""); expect(geometry.topbar).not.toBe("rgba(0, 0, 0, 0)");
    // Stacked, not side by side, and in the same order the story is told: the
    // document first, bounded so it cannot push the queue off the page.
    const stacked = await page.evaluate(() => {
      const source = document.querySelector(".fieldwork-column-source")!.getBoundingClientRect();
      const review = document.querySelector(".fieldwork-column-review")!.getBoundingClientRect();
      const prepared = document.querySelector(".inspector-source pre")!;
      return { order: source.bottom <= review.top + 1, boundedDocument: prepared.getBoundingClientRect().height <= 844 * 0.5 };
    });
    expect(stacked.order).toBe(true);
    expect(stacked.boundedDocument).toBe(true);
    if (visualSnapshotsEnabled) {
      await expect(page).toHaveScreenshot("fieldwork-review-mobile.png", { fullPage: true, maxDiffPixels: 500 });
    }
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
    if (visualSnapshotsEnabled) {
      await expect(page).toHaveScreenshot("fieldwork-format-inspection.png", {
        fullPage: true,
        maxDiffPixels: 1_500,
      });
    }
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

/**
 * Builds a real recheck round: the shipped vendor-renewal brief, then its
 * amended revision, run through `recheckFieldwork` exactly as the CLI does. The
 * only substitution is the Lookout check itself, because a genuine one needs a
 * registered HTTPS source. Everything the screen reads — the semantic-transition
 * metadata, the current/proposed candidate pair, the Forage snapshot refs — is
 * what the shipped command produces.
 */
async function recheckedRun(label: string): Promise<{ runDirectory: string; itemCount: number }> {
  const root = await tempRoot(label);
  const snapshotRoot = join(root, "snapshots");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const task = JSON.parse(await readFile("examples/vendor-obligations/task.json", "utf8"));
  const snapshot = (body: string, fetchedAt: string): Snapshot => ({
    sourceId: "northstar-renewal-brief",
    url: "https://example.invalid/vendor-renewal",
    status: 200,
    fetchedAt,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  const prior = snapshot(await readFile("examples/vendor-obligations/source.txt", "utf8"), "2026-07-25T08:00:00.000Z");
  const current = snapshot(await readFile("examples/vendor-obligations/source-revised.txt", "utf8"), "2026-07-25T09:00:00.000Z");
  await Promise.all([store.put(prior), store.put(current)]);
  const priorRef = buildSnapshotSourceRef(prior), currentRef = buildSnapshotSourceRef(current);
  const first = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    snapshotRef: priorRef,
    snapshotRoot,
    root: join(root, "runs"),
  });
  const recheck = await recheckFieldwork({
    source: {
      id: "northstar-renewal-brief",
      url: "https://example.invalid/vendor-renewal",
      kind: "web-page",
      cadenceHint: "manual",
      renderPolicy: "never",
      targetSchema: task.spec.traverse.targetSchema,
    },
    priorRunDirectory: first.runDirectory,
    taskPath: "examples/vendor-obligations/task.json",
    root: join(root, "runs"),
    observationRoot: join(root, "observations"),
    snapshotRoot,
    acquisition: {
      check: async () => ({
        sourceId: "northstar-renewal-brief",
        sourceUrl: "https://example.invalid/vendor-renewal",
        checkedAt: "2026-07-25T09:00:30.000Z",
        warnings: [],
        kind: "changed",
        priorSnapshotRef: priorRef,
        currentSnapshotRef: currentRef,
        changeBasis: "hash",
      }),
    },
  });
  if (!recheck.run) throw new Error(`recheck produced no run (${recheck.classification})`);
  return { runDirectory: recheck.run.runDirectory, itemCount: recheck.review.itemCount };
}

test("a recheck round says what changed, and shows it in the document", async ({ page }) => {
  const { runDirectory, itemCount } = await recheckedRun("browser-recheck");
  const server = await openRun(runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();

    // `fieldwork recheck` raises two items per drifted field — a value change
    // and a provenance change — so two fields become four decisions.
    expect(itemCount).toBe(4);
    const summary = page.getByTestId("recheck-summary");
    await expect(summary).toContainText("The source moved");
    await expect(summary).toContainText("2 fields changed");
    await expect(summary).toContainText("4 items to re-decide");
    // The one fact a reviewer asks first: when did I last look at this?
    await expect(summary).toContainText(/Captured .+, previously .+/);

    // The panel badge used to count the new extraction's seven proposals while
    // the queue beside it read "4 fields to review".
    await expect(page.locator(".fieldwork-column-review .panel-head")).toContainText("4");
    await expect(page.locator(".fieldwork-column-review .panel-head")).toContainText("What changed");
    await expect(page.locator(".fieldwork-document-meta")).toContainText("2 of 7 spans changed");

    // Two items for one field read as a duplicate until each says why it is here.
    const kinds = await page.locator('[data-testid="review-field"] .fkind').allTextContents();
    expect(kinds.filter((kind) => kind === "Value changed")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "Evidence changed")).toHaveLength(2);

    // The document has to answer "which of these seven spans moved".
    const spans = await page.evaluate(() => [...document.querySelectorAll(".inspector-source mark")]
      .map((mark) => ({ text: mark.textContent ?? "", changed: mark.hasAttribute("data-fw-changed") })));
    expect(spans).toHaveLength(7);
    expect(spans.filter((span) => span.changed).map((span) => span.text)).toEqual([
      "Annual renewal fee USD: 52500",
      "Notice period days: 60",
    ]);

    // Stage 3's provenance link joined the two surfaces on review-item identity.
    // A recheck round's items are Lookout's and the inspector's are the new
    // extraction's, so every link resolved to nothing and the label fell back to
    // the raw 200-character Forage ref.
    const provenance = await page.evaluate(() => [...document.querySelectorAll('[data-testid="proposed-excerpt"] .from')]
      .map((from) => {
        const href = from.querySelector("a")?.getAttribute("href") ?? "";
        return { text: from.textContent ?? "", href, resolves: href.startsWith("#") && Boolean(document.getElementById(href.slice(1))) };
      }));
    expect(provenance).toHaveLength(4);
    for (const entry of provenance) {
      expect(entry.resolves).toBe(true);
      expect(entry.text).toContain("Northstar renewal brief");
      expect(entry.text).toMatch(/chars:\d+-\d+/);
      // No sha256, no percent-encoded url, no fetchedAt.
      expect(entry.text).not.toMatch(/[0-9a-f]{32,}|%3A|sha256/);
    }
  } finally {
    await server.close();
  }
});

/* The dead end fieldwork#59 recorded: every item of a recheck round decided in
   the browser, four HTTP 200s, decisions surviving a reload — and then `export`
   refusing, because it rebuilt its items from the new extraction's seven
   proposals instead of the four the reviewer actually decided. */
test("a decided recheck round exports a receipt of the round", async ({ page }) => {
  const { runDirectory, itemCount } = await recheckedRun("browser-recheck-export");
  const server = await openRun(runDirectory);
  const mutations: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/review")) mutations.push(response.status());
  });
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    const items = await page.getByTestId("review-field")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-item-name")!));
    expect(items).toHaveLength(itemCount);
    for (const item of items) {
      const card = page.locator(`[data-item-name="${item}"][data-testid="review-field"]`);
      await card.getByTestId("use-proposed").click();
      await expect(card.getByTestId("decided-chip")).toHaveText("Accepted");
    }
    // One accepted mutation per decision: no decision may be dropped, and none
    // may be rejected as a spurious append-only conflict.
    await expect.poll(() => mutations.length).toBe(itemCount);
    expect(mutations).toEqual(items.map(() => 200));
    await page.reload();
    await expect(page.getByTestId("decided-chip")).toHaveCount(itemCount);

    const exported = await reviewedExport(runDirectory) as unknown as {
      claims: { id: string; fieldOrBehavior: string; value: unknown }[];
      evidence: { claimId: string; excerptOrSummary?: string; metadata?: { producer?: Record<string, Record<string, string>> } }[];
    };
    // The round, not the document: the new extraction still carries seven
    // proposals, and five of them were never re-decided.
    expect(exported.claims).toHaveLength(itemCount);
    expect([...new Set(exported.claims.map((claim) => claim.fieldOrBehavior))].sort())
      .toEqual(["commercial.annualFeeUsd", "renewal.noticeDays"]);
    for (const claim of exported.claims) {
      const evidence = exported.evidence.find((entry) => entry.claimId === claim.id)!;
      const round = evidence.metadata?.producer?.["fieldwork.kontourai.io/recheck-round"];
      expect(round?.evidenceObservation).toBe("current");
      expect(round?.priorObservationId).not.toBe(round?.currentObservationId);
      expect(evidence.excerptOrSummary).toContain(String(claim.value));
    }
  } finally { await server.close(); }
});

test("a first round is not dressed as a recheck", async ({ page }) => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("browser-first-round"),
  });
  const server = await openRun(run.runDirectory);
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
    await expect(page.getByTestId("recheck-summary")).toHaveCount(0);
    await expect(page.locator(".fieldwork-column-review .panel-head")).toContainText("Facts to decide");
    await expect(page.locator(".fieldwork-document-meta")).toContainText("7 grounded spans");
    // Nothing is dimmed when every span is news.
    await expect(page.locator(".inspector-source mark[data-fw-changed]")).toHaveCount(0);
    // "Current — Not set" is what the `New` chip already says.
    await expect(page.locator(".val.current:visible")).toHaveCount(0);
    await expect(page.locator('[data-testid="review-field"] .fkind').first()).toHaveText("New");
  } finally {
    await server.close();
  }
});
