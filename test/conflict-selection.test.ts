import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { restoreReviewedExtractionEvidence } from "@kontourai/surface";
import type { ReviewItem } from "@kontourai/survey";
import {
  buildReviewSessionEvents,
  hashReviewQueueSnapshot,
  initialReviewQueueSessionState,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { reviewedExport, runFieldwork, SEMANTIC_TRANSITION_PRODUCER } from "../src/fieldwork.js";
import { openRun } from "../src/server.js";
import { parsePersistedReview } from "../src/survey-persistence.js";
import { apiFetch } from "./helpers.js";
import { conflictRun } from "./helpers/conflict-run.js";

/*
 * Survey 7 lets a reviewer choose one value of a conflict set
 * (`select-proposed`). The chosen value exports as a verified claim on its own
 * evidence, and the export records the rivals it was chosen over.
 */

interface Evidence {
  readonly id: string;
  readonly claimId: string;
  readonly sourceLocator?: string;
  readonly excerptOrSummary?: string;
  readonly passing?: boolean;
  readonly metadata?: { readonly reviewedExtraction?: { readonly profile: string; readonly choice?: Choice } };
}
interface Choice { readonly citedCandidateId: string; readonly decisionCandidateId: string; readonly chosenOver: readonly string[] }
interface Claim { readonly id: string; readonly fieldOrBehavior: string; readonly value: unknown; readonly status: string }

test("a chosen conflict value exports on its own evidence and records the rivals it was chosen over", async () => {
  const run = await conflictRun("chosen");
  const snapshot = await snapshotOf(run);
  const conflict = snapshot.items.find((item) => item.spec.candidates.length > 1)!;
  const other = snapshot.items.find((item) => item !== conflict)!;
  // The later candidate is chosen, so reading the item's first candidate
  // instead would state the wrong value.
  const [rival, chosen] = conflict.spec.candidates;
  assert.equal(rival!.value, "Active");
  assert.equal(chosen!.value, "Paused");
  await decide(run, snapshot, {
    decisionsByItemName: { [conflict.metadata.name]: "select-proposed", [other.metadata.name]: "accept-proposed" },
    selectedCandidateIdsByItemName: { [conflict.metadata.name]: chosen!.id },
  });

  const exported = await reviewedExport(run);
  const bundle = exported.bundle as unknown as { claims: Claim[]; evidence: Evidence[] };
  const claim = bundle.claims.find((entry) => entry.fieldOrBehavior === "record.status")!;
  assert.equal(claim.status, "verified");
  assert.equal(claim.value, "Paused");

  const reviewed = bundle.evidence.filter((entry) => entry.metadata?.reviewedExtraction);
  const evidence = reviewed.find((entry) => entry.claimId === claim.id)!;
  assert.equal(evidence.metadata!.reviewedExtraction!.profile, "surface.reviewed-extraction-evidence/v3");
  assert.equal(evidence.excerptOrSummary, "Status: Paused", "the evidence cites the chosen value's span");
  assert.equal(evidence.passing, true);
  assert.deepEqual(evidence.metadata!.reviewedExtraction!.choice, {
    ...evidence.metadata!.reviewedExtraction!.choice,
    citedCandidateId: chosen!.id,
    decisionCandidateId: chosen!.id,
    chosenOver: [rival!.id],
  });
  // Each entry restores on its own, as the v1 entries beside it do.
  const restored = restoreReviewedExtractionEvidence(evidence as never);
  assert.deepEqual(restored.reviewDecision?.spec.unselectedCandidateIds, [rival!.id]);
  // A single-candidate item keeps the current profile.
  const single = reviewed.find((entry) => entry.claimId !== claim.id)!;
  assert.equal(single.metadata!.reviewedExtraction!.profile, "surface.reviewed-extraction-evidence/v1");

  const grounding = exported.reviewedGrounding as { outcome: string; dimensions: { claimId: string; choice?: Choice }[] };
  assert.equal(grounding.outcome, "allowed");
  assert.deepEqual(grounding.dimensions.find((entry) => entry.claimId === claim.id)?.choice?.chosenOver, [rival!.id]);
});

test("a session file carrying a select-proposed decision passes the persisted-review validator", () => {
  const items = [conflictItem()];
  const snapshot = {
    ...initialReviewQueueSessionState(items),
    decisionsByItemName: { conflict: "select-proposed" },
    selectedCandidateIdsByItemName: { conflict: "b" },
  } as ReviewQueueSessionState;
  const parsed = parsePersistedReview({ snapshot, events: [], snapshotHash: hashReviewQueueSnapshot(snapshot) });
  assert.equal(parsed.snapshot.decisionsByItemName.conflict, "select-proposed");
  assert.deepEqual(parsed.snapshot.selectedCandidateIdsByItemName, { conflict: "b" });
  const stray = { ...snapshot, selectedCandidateIdsByItemName: { elsewhere: "b" } };
  assert.throws(
    () => parsePersistedReview({ snapshot: stray, events: [], snapshotHash: hashReviewQueueSnapshot(stray) }),
    /references an unknown item/,
  );
});

test("a Fieldwork session is verified on reload, and a stored queue edited with its digest is refused", async () => {
  const run = await conflictRun("reload");
  const service = await openRun(run);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    assert.equal((view.review.extractionImport as { kind?: string } | undefined)?.kind, "ExtractionEnvelopeImport");
    assert.deepEqual((view.review.apply as { warnings?: unknown[] }).warnings ?? [], [], "the queue is attested, not unverified");
  } finally { await service.close(); }

  // Delete the rival value from the conflict and refresh the queue's digest,
  // so the stored binding agrees with the edit. Only the import can tell.
  const runPath = join(run, "run.json");
  const honest = await readFile(runPath, "utf8");
  const tamper = async (edit: (conflict: ReviewItem) => void): Promise<void> => {
    const stored = JSON.parse(honest);
    edit(stored.review.snapshot.items.find((item: ReviewItem) => item.spec.candidates.length > 1));
    stored.review.snapshotHash = hashReviewQueueSnapshot(stored.review.snapshot);
    await writeFile(runPath, JSON.stringify(stored, null, 2));
  };
  const refused = (error: Error & { code?: string }) => {
    assert.equal(error.code, "REVIEW_QUEUE_UNATTESTED");
    assert.match(error.message, /does not match the extraction it was imported from/);
    return true;
  };
  // A service that opens anyway is closed, so a regression fails instead of hanging.
  const reopen = async (): Promise<void> => { await (await openRun(run)).close(); };
  await tamper((conflict) => { conflict.spec.candidates = conflict.spec.candidates.slice(1); });
  await assert.rejects(reopen, refused);

  // Labelling the edited item as a recheck transition does not route it past
  // the check: a recheck item is held to the envelope instead.
  await tamper((conflict) => {
    conflict.spec.candidates = conflict.spec.candidates.slice(1);
    Object.assign(conflict.metadata, { producer: { ...conflict.metadata.producer, [SEMANTIC_TRANSITION_PRODUCER]: { semanticKind: "proposal-value-changed" } } });
  });
  await assert.rejects(reopen, refused);
});

test("a queue edited after the run is opened is refused when a decision is appended", async () => {
  const run = await conflictRun("submit");
  const service = await openRun(run);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    // The edit lands between the page loading and the reviewer deciding.
    const runPath = join(run, "run.json");
    const stored = JSON.parse(await readFile(runPath, "utf8"));
    const conflict = stored.review.snapshot.items.find((item: ReviewItem) => item.spec.candidates.length > 1);
    conflict.spec.candidates = conflict.spec.candidates.slice(1);
    stored.review.snapshotHash = hashReviewQueueSnapshot(stored.review.snapshot);
    await writeFile(runPath, JSON.stringify(stored, null, 2));

    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "reject-proposed"])),
    });
    const response = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "REVIEW_QUEUE_UNATTESTED");
    assert.deepEqual(JSON.parse(await readFile(runPath, "utf8")).review.events, [], "nothing was appended");
  } finally {
    // Closing reads the run's final state, which is the edited queue, so it refuses too.
    await service.close().catch((error: Error & { code?: string }) => assert.equal(error.code, "REVIEW_QUEUE_UNATTESTED"));
  }
});

async function snapshotOf(runDirectory: string): Promise<ReviewQueueSessionState> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    return view.review.snapshot as unknown as ReviewQueueSessionState;
  } finally { await service.close(); }
}

async function decide(
  runDirectory: string,
  snapshot: ReviewQueueSessionState,
  decisions: Pick<ReviewQueueSessionState, "decisionsByItemName" | "selectedCandidateIdsByItemName">,
): Promise<void> {
  const service = await openRun(runDirectory);
  try {
    const events = buildReviewSessionEvents({ ...snapshot, ...decisions });
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true, JSON.stringify(saved));
  } finally { await service.close(); }
}

function conflictItem(): ReviewItem {
  const candidate = (id: string, value: string) => ({
    id, role: "proposed" as const, value,
    source: { sourceRef: "fieldwork-source:v1:record:0" },
    extraction: { target: "record.status" },
    claimTarget: {
      subjectType: "record", subjectId: "r1", facet: "review", claimType: "field",
      fieldOrBehavior: "record.status", impactLevel: "medium" as const,
    },
  });
  return {
    apiVersion: "survey.kontourai.io/v1alpha1",
    kind: "ReviewItem",
    metadata: { name: "conflict" },
    spec: { target: "record.status", candidates: [candidate("a", "Active"), candidate("b", "Paused")] },
  };
}
