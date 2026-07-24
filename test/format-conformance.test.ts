import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFilesystemSnapshotStore,
  type Snapshot,
} from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  buildReviewSessionEvents,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import { runFieldworkBatch, reviewedExport } from "../src/fieldwork.js";
import { assertPortableOutput } from "../src/run-store.js";
import { openRun } from "../src/server.js";
import type {
  FieldworkRunResult,
  FieldworkRunViewV1,
} from "../src/api-contracts.js";
import { apiFetch } from "./helpers.js";
import {
  formatFailingImageBytes,
  formatImageBytes,
  formatPdfBytes,
  formatSourceAdapters,
  formatStatusRange,
} from "./format-fixtures.js";

const fixtureRoot = resolve("conformance/formats");
const taskPath = join(fixtureRoot, "task.json");

test("replayable document formats preserve exact grounding, inspection, review, and portable output", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-format-snapshots-"));
  const runRoot = await mkdtemp(join(tmpdir(), "fieldwork-format-runs-"));
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const snapshots = [
    snapshot("format-html", await readFile(join(fixtureRoot, "source.html"), "utf8"), "text/html"),
    snapshot("format-transcript", await readFile(join(fixtureRoot, "source.vtt"), "utf8"), "text/vtt"),
    snapshot("format-pdf", formatPdfBytes, "application/pdf"),
    snapshot("format-image", formatImageBytes, "image/png"),
    snapshot("format-image-failure", formatFailingImageBytes, "image/jpeg"),
  ] as const;
  for (const entry of snapshots) await store.put(entry);
  const refs = Object.fromEntries(snapshots.map((entry) => [entry.sourceId, buildSnapshotSourceRef(entry)]));

  const batch = await runFieldworkBatch({
    taskPath,
    root: runRoot,
    sourceAdapters: formatSourceAdapters,
    sources: [
      { id: "html", snapshotRef: refs["format-html"], snapshotRoot },
      { id: "transcript", snapshotRef: refs["format-transcript"], snapshotRoot },
      { id: "pdf", snapshotRef: refs["format-pdf"], snapshotRoot },
      { id: "image", snapshotRef: refs["format-image"], snapshotRoot },
      { id: "image-failure", snapshotRef: refs["format-image-failure"], snapshotRoot },
    ],
  });

  assert.deepEqual(
    batch.items.map((item) => [item.id, item.ok]),
    [
      ["html", true],
      ["transcript", true],
      ["pdf", true],
      ["image", true],
      ["image-failure", false],
    ],
    JSON.stringify(batch, null, 2),
  );
  assert.deepEqual(batch.items[4], {
    id: "image-failure",
    ok: false,
    error: { code: "SOURCE_FAILED", message: "Source processing failed" },
  });
  assert.doesNotMatch(JSON.stringify(batch.items[4]), /synthetic private OCR diagnostic/);

  const oracle = JSON.parse(await readFile(join(fixtureRoot, "oracle.json"), "utf8")) as FormatOracle;
  const successful = new Map(
    batch.items.filter((item): item is { id: string; ok: true; run: FieldworkRunResult } => item.ok)
      .map((item) => [item.id, item.run]),
  );
  assert.equal(new Set([...successful.values()].map((run) => run.runResource)).size, 4);

  for (const id of ["html", "transcript", "pdf", "image"] as const) {
    const run = successful.get(id)!;
    const envelope = JSON.parse(
      await readFile(join(run.runDirectory, "extraction-envelope.json"), "utf8"),
    );
    assert.equal(await readFile(join(run.runDirectory, "prepared.txt"), "utf8"), oracle.prepared[id]);
    assert.equal(envelope.source.ref, refs[`format-${id}`]);
    assert.equal(envelope.source.snapshotRef, refs[`format-${id}`]);
    assert.equal(envelope.result.preparedArtifact.sourceSnapshotRef, refs[`format-${id}`]);
    assert.equal(envelope.result.proposals[0].provenance.locator, oracle.locators[id]);
    assert.equal(envelope.result.proposals[0].provenance.excerpt, "Status: Active");
  }

  const pdfRun = successful.get("pdf")!;
  const pdfEnvelope = JSON.parse(
    await readFile(join(pdfRun.runDirectory, "extraction-envelope.json"), "utf8"),
  );
  assert.deepEqual(pdfEnvelope.result.pdfPageOffsets, [0, 6]);
  assert.equal(pdfEnvelope.result.pdfLayout.elements[0].providerType, "fixture-cell");
  assert.deepEqual(pdfEnvelope.result.pdfLayout.elements[0].range, formatStatusRange);
  assert.deepEqual(pdfEnvelope.result.pdfLayout.tables[0].cells[0].range, formatStatusRange);

  const imageRun = successful.get("image")!;
  const imageEnvelope = JSON.parse(
    await readFile(join(imageRun.runDirectory, "extraction-envelope.json"), "utf8"),
  );
  assert.equal(imageEnvelope.result.ocrDerived, true);

  const pdfView = await runView(pdfRun);
  const pdfCandidate = pdfView.inspector.candidates[0] as Record<string, unknown>;
  const pdfRegion = pdfCandidate.pdfRegion as {
    pages: number[];
    elements: unknown[];
    tableCells: unknown[];
  };
  assert.deepEqual(pdfRegion.pages, oracle.pdfRegion.pages);
  assert.equal(pdfRegion.elements.length, oracle.pdfRegion.elementCount);
  assert.equal(pdfRegion.tableCells.length, oracle.pdfRegion.tableCellCount);

  const imageView = await runView(imageRun);
  assert.equal(imageView.inspector.candidates[0]?.ocrDerived, true);
  assert.equal(imageView.inspector.sources[0]?.ocrDerived, true);
  assert.match(String(imageView.inspector.sources[0]?.message), /OCR-derived/);

  for (const run of successful.values()) {
    const output = await acceptAndExport(run);
    assertPortableOutput(output);
    const serialized = JSON.stringify(output);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(snapshotRoot)));
    assert.doesNotMatch(serialized, /source\.(?:html|vtt)|format-fixture-(?:pdf|ocr)/);
  }
});

async function runView(run: FieldworkRunResult): Promise<FieldworkRunViewV1> {
  const server = await openRun(run.runDirectory);
  try {
    return await apiFetch(server, "/api/v1/run").then((response) => response.json());
  } finally {
    await server.close();
  }
}

async function acceptAndExport(run: FieldworkRunResult): Promise<Record<string, unknown>> {
  const server = await openRun(run.runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run")
      .then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const itemName = snapshot.items[0]!.metadata.name;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: { [itemName]: "accept-proposed" },
      reviewedAt: "2026-07-23T00:00:00.000Z",
      actorId: "format-conformance-reviewer",
    });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await server.close();
  }
  return await reviewedExport(run.runDirectory) as Record<string, unknown>;
}

function snapshot(
  sourceId: string,
  body: string | Uint8Array,
  contentType: string,
): Snapshot {
  return {
    sourceId,
    url: `https://example.invalid/${sourceId}`,
    status: 200,
    fetchedAt: "2026-07-23T12:00:00.000Z",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": contentType },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface FormatOracle {
  prepared: Record<"html" | "transcript" | "pdf" | "image", string>;
  locators: Record<"html" | "transcript" | "pdf" | "image", string>;
  pdfRegion: {
    pages: number[];
    elementCount: number;
    tableCellCount: number;
  };
}
