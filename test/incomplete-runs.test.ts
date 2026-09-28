import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { extractionCoverageSummary, reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { inspectionExport } from "../src/inspection.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";
import { outputTruncatedRun, partialRunWithProposals, runFromOlderFieldwork, zeroProposalPartialRun } from "./helpers/incomplete-runs.js";
import { readRun } from "../src/run-store.js";

/*
 * A run that lost content must never read as complete, wherever it is read:
 * the run view the workbench renders, `inspect`, and export.
 */

async function view(runDirectory: string): Promise<FieldworkRunViewV1> {
  const server = await openRun(runDirectory);
  try { return await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1; }
  finally { await server.close(); }
}

test("a partial run that proposed values tells the workbench what it did not read", async () => {
  const run = await partialRunWithProposals("view");
  const served = await view(run);
  assert.deepEqual(served.extraction.outcome, { status: "partial", reason: "provider-failure" });
  assert.deepEqual(served.extraction.coverage, { chunkCount: 2, incompleteChunkCount: 1 });
  assert.equal((served.review.snapshot as unknown as ReviewQueueSessionState).items.length, 1);
  assert.equal(served.reviewBlocked, undefined);
});

test("a complete run carries its success outcome and no coverage count", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("complete-view") });
  const served = await view(run.runDirectory);
  assert.deepEqual(served.extraction, { outcome: { status: "success" } });
});

test("a zero-proposal partial run is served, inspected with its coverage, and refused at export", async () => {
  const run = await zeroProposalPartialRun("pinned");
  const served = await view(run);
  assert.deepEqual(served.extraction.outcome, { status: "partial", reason: "cancelled" });
  assert.ok(served.extraction.coverage && served.extraction.coverage.incompleteChunkCount === served.extraction.coverage.chunkCount,
    JSON.stringify(served.extraction.coverage));
  assert.equal((served.review.snapshot as unknown as ReviewQueueSessionState).items.length, 0);

  const inspected = JSON.parse(await inspectionExport(run)) as {
    spec: { extraction: { outcome: unknown; coverage?: { status: string; reason?: string }[] } };
  };
  assert.deepEqual(inspected.spec.extraction.outcome, { status: "partial", reason: "cancelled" });
  assert.ok(inspected.spec.extraction.coverage?.length);
  assert.ok(inspected.spec.extraction.coverage.every((entry) => entry.status === "unread"));

  await assert.rejects(() => reviewedExport(run), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_COVERAGE_INCOMPLETE");
    assert.match(error.message, /partial: cancelled/);
    return true;
  });
});

test("a run from an older Fieldwork opens blocked, refuses decisions, and says why at export", async () => {
  const run = await runFromOlderFieldwork("blocked");
  const server = await openRun(run);
  try {
    const served = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    assert.equal(served.reviewBlocked?.reason, "created-by-older-fieldwork");
    assert.match(served.reviewBlocked!.message, /older Fieldwork.*re-run the source/s);
    const snapshot = served.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"])),
    });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean; error?: { code: string } };
    assert.equal(saved.ok, false);
    assert.equal(saved.error?.code, "RUN_FROM_OLDER_FIELDWORK");
  } finally { await server.close(); }

  const inspected = JSON.parse(await inspectionExport(run)) as { spec: { reviewBlocked?: { reason: string } } };
  assert.equal(inspected.spec.reviewBlocked?.reason, "created-by-older-fieldwork");

  await assert.rejects(() => reviewedExport(run), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_RUN_FROM_OLDER_FIELDWORK");
    assert.match(error.message, /created by an older Fieldwork/);
    assert.match(error.message, /re-run the source/);
    return true;
  });
});

test("a current run is never mistaken for one from an older Fieldwork", async () => {
  const run = await partialRunWithProposals("not-older");
  assert.equal((await view(run)).reviewBlocked, undefined);
  const inspected = JSON.parse(await inspectionExport(run)) as { spec: { reviewBlocked?: unknown } };
  assert.equal(inspected.spec.reviewBlocked, undefined);
});

test("chunks whose answers stopped at the output cap count as not read in full", async () => {
  const run = await outputTruncatedRun("count");
  const stored = await readRun(run);
  assert.deepEqual(stored.envelope.result.outcome, { status: "partial", reason: "output-truncated" });
  assert.deepEqual(stored.envelope.result.coverage?.map((entry) => entry.status), ["complete", "output-truncated", "output-truncated"]);
  assert.deepEqual((await view(run)).extraction.coverage, { chunkCount: 3, incompleteChunkCount: 2 });
});

test("a chunk cut at the content limit counts once, though it has two coverage records", () => {
  // Traverse's documented shape for a content-truncated chunk: the sent part
  // and the cut-off tail are separate records for the same chunk.
  const envelope = { result: { coverage: [
    { chunk: 1, start: 0, end: 8_000, status: "complete" },
    { chunk: 1, start: 8_000, end: 12_000, status: "unread", reason: "content-truncated" },
    { chunk: 2, start: 11_800, end: 20_000, status: "complete" },
  ] } } as unknown as Parameters<typeof extractionCoverageSummary>[0];
  assert.deepEqual(extractionCoverageSummary(envelope), { chunkCount: 2, incompleteChunkCount: 1 });
});
