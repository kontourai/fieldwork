import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFilesystemSnapshotStore, type Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ModelRuntime } from "@kontourai/relay";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../../src/api-contracts.js";
import { bindExtraction, importNameFor, newReviewRound, runFieldwork } from "../../src/fieldwork.js";
import { readRun, type StoredRun } from "../../src/run-store.js";
import type { FieldworkRuntimeBinding } from "../../src/runtime-contracts.js";
import { openRun } from "../../src/server.js";
import { apiFetch, tempRoot } from "../helpers.js";
import { conflictRun } from "./conflict-run.js";

export interface QueueItem { readonly name: string; readonly fieldPath: string; readonly candidateCount: number }

export const MIXED_FIELDS = ["alpha", "bravo", "charlie", "delta"] as const;

/**
 * Four uncontested fields and `record.status`, which two chunks state as
 * "Active" and "Paused" (one conflict item). Five review items over five fields.
 * The source text is fixed, so the run's source snapshot ref, and with it every
 * memory claim id, is the same on every run.
 */
export async function mixedRun(label: string, extraSourceText = ""): Promise<string> {
  const root = await tempRoot(`memory-source-${label}`);
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  const [statusProjection] = task.spec.projections;
  for (const field of MIXED_FIELDS) {
    task.spec.traverse.targetSchema.push({ path: `record.${field}`, type: "string", inferenceType: "explicit" });
    task.spec.projections.push({ ...statusProjection, fieldPath: `record.${field}`, pattern: `${field}: ([^\\n]+)` });
  }
  const taskPath = join(root, "task.json");
  const sourcePath = join(root, "source.txt");
  await writeFile(taskPath, JSON.stringify(task));
  // Enough filler that Traverse prepares two chunks, each with its own Status line.
  await writeFile(sourcePath, `${MIXED_FIELDS.map((field) => `${field}: ${field}-value\n`).join("")}Status: Active\n`
    + `${"filler line of text.\n".repeat(700)}Status: Paused\n${extraSourceText}`);
  return (await runFieldwork({ taskPath, sourcePath, root })).runDirectory;
}

export async function queueOf(runDirectory: string): Promise<QueueItem[]> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    return (view.review.snapshot as unknown as ReviewQueueSessionState).items.map((item) => ({
      name: item.metadata.name,
      fieldPath: item.spec.candidates[0]!.claimTarget.fieldOrBehavior,
      candidateCount: item.spec.candidates.length,
    }));
  } finally { await service.close(); }
}

/** Decide items through the review API, as the workbench does. `selected` names the candidate a `select-proposed` chooses. */
export async function decide(
  runDirectory: string,
  decisionsByItemName: Record<string, string>,
  selectedCandidateIdsByItemName?: Record<string, string>,
): Promise<void> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot, decisionsByItemName,
      ...(selectedCandidateIdsByItemName ? { selectedCandidateIdsByItemName } : {}),
    } as Parameters<typeof buildReviewSessionEvents>[0]);
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true, JSON.stringify(saved));
  } finally { await service.close(); }
}

/**
 * The mixed run, decided: alpha and charlie accepted, bravo rejected, delta and
 * the status conflict left undecided.
 */
export async function decidedMixedRun(label: string, extraSourceText = ""): Promise<string> {
  const run = await mixedRun(label, extraSourceText);
  const items = await queueOf(run);
  const byField = (field: string) => items.find((item) => item.fieldPath === `record.${field}`)!.name;
  await decide(run, {
    [byField("alpha")]: "accept-proposed",
    [byField("bravo")]: "reject-proposed",
    [byField("charlie")]: "accept-proposed",
  });
  return run;
}

/**
 * `conflictRun` with the "Active" proposal's excerpt replaced by same-length
 * text the source does not contain there, re-bound through the writer the run
 * was created with (as test/extraction-binding.test.ts does). Survey then
 * excludes that proposal at import: it is no review candidate, and the import
 * record carries an `excerpt-mismatch` diagnostic for it.
 */
export async function forgedUnverifiedConflictRun(label: string): Promise<string> {
  const run = await conflictRun(label);
  const runPath = join(run, "run.json");
  const envelopePath = join(run, "extraction-envelope.json");
  const stored = JSON.parse(await readFile(runPath, "utf8")) as StoredRun;
  const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as { result: { proposals: { candidateValue: unknown; provenance: { excerpt: string } }[] } };
  const proposal = envelope.result.proposals.find((entry) => entry.candidateValue === "Active")!;
  proposal.provenance.excerpt = "Status: Actiff";
  proposal.candidateValue = "Actiff";
  const { imported, extraction } = bindExtraction(stored.task, importNameFor(stored), envelope as never, (await readRun(run)).preparedText);
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  await writeFile(runPath, JSON.stringify({ ...stored, extraction, review: newReviewRound(imported.reviewItems, stored.createdAt) }, null, 2));
  return run;
}

/**
 * A run whose model answers `record.status` and two values of one multi-valued
 * field, `record.items[]`, which Survey reviews as two items (one per indexed
 * proposal) that share a field. Used to tell sibling items apart.
 */
export async function indexedItemsRun(label: string): Promise<string> {
  const root = await tempRoot(`memory-source-${label}`);
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  task.spec.traverse.targetSchema = [
    { path: "record.status", type: "string", inferenceType: "explicit" },
    { path: "record.items[]", type: "string", inferenceType: "explicit" },
  ];
  task.spec.projections.push({ ...task.spec.projections[0], fieldPath: "record.items[]" });
  const taskPath = join(root, "task.json");
  const sourcePath = join(root, "source.txt");
  await writeFile(taskPath, JSON.stringify(task));
  await writeFile(sourcePath, "Status: Active\nValue: one\nValue: two\n");
  const proposal = (fieldPath: string, value: string, excerpt: string) => ({ fieldPath, value, confidence: 1, excerpt, locator: null, occurrenceHint: null });
  const runtime: ModelRuntime = {
    id: "fake:indexed-items",
    capabilities: () => ({
      structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native",
      streaming: false, abort: true, usage: true,
    }),
    invoke: async () => ({
      provider: "fixture-runtime", model: "fixture-model", outputText: "",
      toolCalls: [{
        id: "tool-indexed", name: "submit_extraction_proposals",
        input: { proposals: [
          proposal("record.status", "Active", "Status: Active"),
          proposal("record.items[0]", "one", "Value: one"),
          proposal("record.items[1]", "two", "Value: two"),
        ] },
      }],
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, latencyMs: 1, stopReason: "tool_use",
    }),
  };
  const binding: FieldworkRuntimeBinding = { role: "fieldwork-extraction", candidates: [{ id: "scripted", runtime }], budget: { maxAttempts: 4, maxElapsedMs: 60_000 } };
  return (await runFieldwork({ taskPath, sourcePath, root, runtime: binding })).runDirectory;
}

/** A run over an exact web-page snapshot (a Forage snapshot ref, not a local file), with its one item accepted. */
export async function snapshotRun(label: string, fetchedAt: string): Promise<{ readonly run: string; readonly snapshotRef: string }> {
  const root = await tempRoot(`memory-source-${label}`);
  const body = "<html><body><main><h1>Record</h1><p>Status: Active</p></main></body></html>";
  const snapshot: Snapshot = {
    sourceId: "generic-record-source", url: "https://example.invalid/generic-record", status: 200,
    fetchedAt, body, bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": "text/html; charset=utf-8" },
  };
  const snapshotRoot = join(root, "snapshots");
  await createFilesystemSnapshotStore({ root: snapshotRoot }).put(snapshot);
  const snapshotRef = buildSnapshotSourceRef(snapshot);
  const run = (await runFieldwork({ taskPath: "examples/generic/task.json", snapshotRef, snapshotRoot, root: join(root, "runs") })).runDirectory;
  await decide(run, Object.fromEntries((await queueOf(run)).map((item) => [item.name, "accept-proposed"])));
  return { run, snapshotRef };
}
