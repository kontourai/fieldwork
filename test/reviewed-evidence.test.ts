/**
 * kontourai/fieldwork#88: fieldwork is the first consumer of surface 2.13's
 * reviewed-extraction-evidence projection and reviewed-grounding-policy
 * evaluation. These tests pin the enriched `reviewedExport` shape directly,
 * separate from the existing conformance oracles (which pin unrelated,
 * pre-existing fields and are covered elsewhere).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateTrustBundle } from "@kontourai/surface";
import { restoreReviewedExtractionEvidence } from "@kontourai/surface";
import {
  createFilesystemSnapshotStore,
  type Snapshot,
} from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { LookoutSource, CheckResult } from "@kontourai/lookout";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { projectAttestedReviewedProjection, reviewedExport, runFieldwork, SEMANTIC_TRANSITION_PRODUCER } from "../src/fieldwork.js";
import { buildReviewedEvidenceEnrichment } from "../src/reviewed-evidence.js";
import { readRunMetadata } from "../src/run-store.js";
import { recheckFieldwork } from "../src/recheck.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";

interface ExportedEvidence {
  readonly id: string;
  readonly claimId: string;
  readonly supportStrength?: string;
  readonly passing?: boolean;
  readonly blocking?: boolean;
  readonly metadata?: { readonly reviewedExtraction?: Record<string, unknown> };
}
interface ExportedBundle {
  readonly source: string;
  readonly claims: readonly { readonly id: string; readonly fieldOrBehavior: string }[];
  readonly evidence: readonly ExportedEvidence[];
}
interface ExportedReview {
  readonly bundle: ExportedBundle;
  readonly reviewedGrounding: Record<string, unknown> & { readonly outcome: string };
}

function reviewedEvidenceOf(bundle: ExportedBundle): readonly ExportedEvidence[] {
  return bundle.evidence.filter((entry) => entry.metadata?.reviewedExtraction !== undefined);
}

async function acceptAll(runDirectory: string): Promise<void> {
  const server = await openRun(runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const decisionsByItemName = Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"]));
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await server.close();
  }
}

async function decideMixed(runDirectory: string, rejectFirst: boolean): Promise<void> {
  const server = await openRun(runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const decisionsByItemName = Object.fromEntries(
      snapshot.items.map((item, index) => [item.metadata.name, rejectFirst && index === 0 ? "reject-proposed" : "accept-proposed"]),
    );
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await server.close();
  }
}

test("a policy-satisfying first-round export projects reviewed evidence and an allowed grounding evaluation", async () => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("reviewed-evidence-allowed"),
  });
  await acceptAll(run.runDirectory);
  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedReview;
  const { bundle } = exported;

  assert.equal(exported.reviewedGrounding.outcome, "allowed");
  assert.deepEqual((exported.reviewedGrounding as { gaps: unknown[] }).gaps, []);

  const reviewed = reviewedEvidenceOf(bundle);
  assert.equal(reviewed.length, bundle.claims.length, "one reviewed-extraction-evidence entry per exported claim");
  for (const claim of bundle.claims) {
    const entry = reviewed.find((candidate) => candidate.claimId === claim.id);
    assert.ok(entry, `${claim.fieldOrBehavior} must carry projected reviewed-extraction evidence`);
    assert.equal(entry!.supportStrength, "entails");
    assert.equal(entry!.passing, true);
    assert.equal(entry!.blocking, false);
  }

  // Existing consumers reading "the" evidence for a claim by last-write-wins
  // must still see Survey's own (pre-#88) evidence: the projection is additive.
  const lastWinsEvidence = new Map(bundle.evidence.map((entry) => [entry.claimId, entry]));
  for (const claim of bundle.claims) {
    const winner = lastWinsEvidence.get(claim.id);
    assert.ok(winner, `${claim.fieldOrBehavior} must retain its original evidence under last-write-wins reads`);
    assert.equal(winner!.metadata?.reviewedExtraction, undefined, "last-write-wins reads must still resolve to Survey's original evidence, not the new projection");
  }

  // Round-trip (d): surface must be able to restore what it just projected.
  for (const entry of reviewed) {
    const restored = restoreReviewedExtractionEvidence(entry as unknown as Parameters<typeof restoreReviewedExtractionEvidence>[0]);
    assert.equal(restored.claimId, entry.claimId);
    assert.equal(restored.structuralTrust, "validated");
  }

  // kontourai/fieldwork#155: the exported bundle is a trust bundle on its own,
  // with the grounding evaluation beside it. Surface 4 throws on an unknown
  // top-level key; Surface 3 drops it from what it returns, so comparing key
  // sets rejects an unknown key under either release.
  assert.equal("reviewedGrounding" in bundle, false);
  assert.equal("reviewRound" in bundle, false);
  const validated = validateTrustBundle(bundle);
  assert.deepEqual(Object.keys(bundle).sort(), Object.keys(validated).sort());
});

test("a value stated twice before another field grounds each claim against its own proposal", async () => {
  // Survey groups proposals by claim slot, so the repeated status is one item
  // standing for proposals 0 and 1, and the next field's item is second in the
  // queue but stands for proposal 2. Reading the proposal index off the queue
  // position would ground that field against the status proposal.
  const root = await tempRoot("reviewed-evidence-slot-index");
  const taskPath = join(root, "task.json");
  const sourcePath = join(root, "source.txt");
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  const [statusProjection] = task.spec.projections;
  task.spec.traverse.targetSchema.push({ path: "record.owner", type: "string", inferenceType: "explicit" });
  task.spec.projections.push({ ...statusProjection, fieldPath: "record.owner", pattern: "Owner: ([^\\n]+)" });
  await writeFile(taskPath, JSON.stringify(task));
  await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(700)}Status: Active\nOwner: Ops\n`);
  const run = await runFieldwork({ taskPath, sourcePath, root });
  const stored = await readRunMetadata(run.runDirectory);
  assert.deepEqual(stored.envelope.result.proposals.map((proposal) => proposal.fieldPath),
    ["record.status", "record.status", "record.owner"]);
  assert.equal(stored.run.review.snapshot.items.length, 2);

  await acceptAll(run.runDirectory);
  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedReview;
  assert.equal(exported.reviewedGrounding.outcome, "allowed");
  const owner = exported.bundle.claims.find((claim) => claim.fieldOrBehavior === "record.owner")!;
  const evidence = reviewedEvidenceOf(exported.bundle).find((entry) => entry.claimId === owner.id);
  assert.ok(evidence);
  const restored = restoreReviewedExtractionEvidence(evidence as unknown as Parameters<typeof restoreReviewedExtractionEvidence>[0]);
  assert.equal(restored.proposalIndex, 2);
});

test("a rejected decision's export carries a typed grounding refusal, not a fabricated pass", async () => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("reviewed-evidence-refused"),
  });
  await decideMixed(run.runDirectory, true);
  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedReview;
  const { bundle } = exported;

  assert.equal(exported.reviewedGrounding.outcome, "refused");
  const gaps = (exported.reviewedGrounding as { gaps: Array<{ kind: string; claimId: string }> }).gaps;
  assert.ok(gaps.length > 0, "a refused evaluation must disclose at least one typed gap");
  assert.ok(gaps.some((gap) => gap.kind === "review-not-accepted"));
  assert.ok(gaps.some((gap) => gap.kind === "evidence-not-entailing"));

  const rejectedClaim = bundle.claims[0]!;
  const rejectedEvidence = reviewedEvidenceOf(bundle).find((entry) => entry.claimId === rejectedClaim.id)!;
  assert.equal(rejectedEvidence.passing, false);
  assert.equal(rejectedEvidence.blocking, true);
  assert.notEqual(rejectedEvidence.supportStrength, "entails");

  // Every other (accepted) claim keeps a clean, entailing projection: the
  // refusal is scoped to the actual gap, never smeared across the whole export.
  for (const claim of bundle.claims.slice(1)) {
    const entry = reviewedEvidenceOf(bundle).find((candidate) => candidate.claimId === claim.id)!;
    assert.equal(entry.passing, true);
    assert.equal(entry.blocking, false);
  }
});

test("a recheck round's grounding is reported not-evaluated, never fabricated as a pass", async () => {
  const source: LookoutSource = {
    id: "reviewed-evidence-recheck-source",
    url: "https://example.invalid/reviewed-evidence-recheck",
    kind: "web-page",
    cadenceHint: "manual",
    renderPolicy: "never",
    targetSchema: [{ path: "record.status", type: "string", inferenceType: "explicit" }],
  };
  const root = await mkdtemp(join(tmpdir(), "fieldwork-reviewed-evidence-recheck-"));
  const snapshotRoot = join(root, "snapshots");
  const runRoot = join(root, "runs");
  const observationRoot = join(root, "observations");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const snap = (sourceId: string, body: string, fetchedAt: string): Snapshot => ({
    sourceId: source.id, url: source.url, status: 200, fetchedAt, body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  const priorSnapshot = snap("capture-prior", "Status: Active", "2026-07-23T10:00:00.000Z");
  await store.put(priorSnapshot);
  const priorRef = buildSnapshotSourceRef(priorSnapshot);
  const prior = await runFieldwork({
    taskPath: join(resolve("examples/generic"), "task.json"),
    snapshotRef: priorRef, snapshotRoot, root: runRoot,
  });
  const currentSnapshot = snap("capture-current", "Status: Pending", "2026-07-23T15:00:00.000Z");
  const currentRef = buildSnapshotSourceRef(currentSnapshot);
  const check: CheckResult = {
    sourceId: source.id, sourceUrl: source.url, checkedAt: "2026-07-23T11:00:00.000Z", warnings: [],
    kind: "changed", priorSnapshotRef: priorRef, currentSnapshotRef: currentRef, changeBasis: "hash",
  };
  const recheck = await recheckFieldwork({
    source, priorRunDirectory: prior.runDirectory,
    taskPath: join(resolve("examples/generic"), "task.json"),
    root: runRoot, observationRoot, snapshotRoot,
    now: () => "2026-07-23T15:01:00.000Z",
    acquisition: { check: async () => { await store.put(currentSnapshot); return check; } },
  });
  assert.ok(recheck.run, "recheck must produce a decidable round");
  await acceptAll(recheck.run!.runDirectory);
  const exported = await reviewedExport(recheck.run!.runDirectory) as unknown as ExportedReview;
  const { bundle } = exported;

  assert.equal(exported.reviewedGrounding.outcome, "not-evaluated");
  assert.equal((exported.reviewedGrounding as { reason: string }).reason, "unsupported-review-shape");
  assert.equal(reviewedEvidenceOf(bundle).length, 0, "no reviewed-extraction evidence is fabricated for an unsupported shape");
  // Survey's own (pre-#88) evidence for the recheck round is untouched.
  assert.ok(bundle.evidence.length > 0);
});

/**
 * Rebuild the enrichment for a decided first round with the claims an export
 * would state, optionally changed, so the grounding policy's required claims
 * can be checked against evidence the claims did not come from.
 */
async function enrichmentWithClaims(
  runDirectory: string,
  claims: (stated: readonly { id: string; value: unknown }[]) => readonly { id: string; value: unknown }[],
) {
  const projection = projectAttestedReviewedProjection(await readRunMetadata(runDirectory));
  const stated = projection.canonical.surveyInput.claims.map((claim) => ({ id: claim.id, value: claim.value }));
  const claimIdByCandidateId = new Map(
    projection.canonical.surveyInput.claims.flatMap((claim) => claim.candidateId === undefined ? [] : [[claim.candidateId, claim.id] as const]),
  );
  return buildReviewedEvidenceEnrichment({
    imported: projection.imported,
    items: projection.items,
    results: projection.results,
    isRecheckItem: (item) => Boolean(item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER]),
    claimIdForCandidate: (candidateId) => claimIdByCandidateId.get(candidateId),
    claims: claims(stated),
  });
}

test("grounding requires every stated claim, so a claim with no reviewed evidence is a typed refusal", async () => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("reviewed-evidence-required-claims"),
  });
  await acceptAll(run.runDirectory);
  const stated = await enrichmentWithClaims(run.runDirectory, (claims) => claims);
  assert.equal(stated.grounding.outcome, "allowed");

  // A claim the export states but no reviewed evidence covers. Deriving the
  // required claims from the evidence would never require it.
  const orphan = await enrichmentWithClaims(run.runDirectory, (claims) => [...claims, { id: "claim.orphan", value: "x" }]);
  assert.equal(orphan.grounding.outcome, "refused");
  const gaps = (orphan.grounding as { gaps: { kind: string; claimId?: string }[] }).gaps;
  assert.deepEqual(gaps.filter((gap) => gap.claimId === "claim.orphan").map((gap) => gap.kind), ["missing-reviewed-evidence"]);
});

test("an export that states no claims is refused before grounding is evaluated, whatever Surface would decide", async () => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("reviewed-evidence-no-claims"),
  });
  await acceptAll(run.runDirectory);
  // Surface 3 allowed an empty requirement set and Surface 4 refuses it with
  // `no-required-claims`; neither may become this export's receipt.
  await assert.rejects(
    () => enrichmentWithClaims(run.runDirectory, () => []),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "EXPORT_NOT_PROJECTABLE");
      assert.match(error.message, /states no claims/);
      return true;
    },
  );
});
