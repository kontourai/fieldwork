import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../../src/api-contracts.js";
import { bindExtraction, importNameFor, newReviewRound, runFieldwork } from "../../src/fieldwork.js";
import { readRun, type StoredRun } from "../../src/run-store.js";
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
