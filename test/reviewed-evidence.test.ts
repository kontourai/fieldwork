/**
 * kontourai/fieldwork#88: fieldwork is the first consumer of surface 2.13's
 * reviewed-extraction-evidence projection and reviewed-grounding-policy
 * evaluation. These tests pin the enriched `reviewedExport` shape directly,
 * separate from the existing conformance oracles (which pin unrelated,
 * pre-existing fields and are covered elsewhere).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
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
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
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
  const bundle = await reviewedExport(run.runDirectory) as unknown as ExportedBundle;

  assert.equal(bundle.reviewedGrounding.outcome, "allowed");
  assert.deepEqual((bundle.reviewedGrounding as { gaps: unknown[] }).gaps, []);

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

  // Backward compat (c): the core TrustBundle shape (everything but fieldwork's
  // own `reviewedGrounding` extension) must still validate as a standalone
  // TrustBundle on its own, unmodified from what a pre-#88 consumer expected.
  const { reviewedGrounding: _reviewedGrounding, ...coreBundle } = bundle as unknown as Record<string, unknown>;
  assert.doesNotThrow(() => validateTrustBundle(coreBundle));
});

test("a rejected decision's export carries a typed grounding refusal, not a fabricated pass", async () => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("reviewed-evidence-refused"),
  });
  await decideMixed(run.runDirectory, true);
  const bundle = await reviewedExport(run.runDirectory) as unknown as ExportedBundle;

  assert.equal(bundle.reviewedGrounding.outcome, "refused");
  const gaps = (bundle.reviewedGrounding as { gaps: Array<{ kind: string; claimId: string }> }).gaps;
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
    sourceId, url: source.url, status: 200, fetchedAt, body,
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
  await store.put(currentSnapshot);
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
    acquisition: { check: async () => check },
  });
  assert.ok(recheck.run, "recheck must produce a decidable round");
  await acceptAll(recheck.run!.runDirectory);
  const bundle = await reviewedExport(recheck.run!.runDirectory) as unknown as ExportedBundle;

  assert.equal(bundle.reviewedGrounding.outcome, "not-evaluated");
  assert.equal((bundle.reviewedGrounding as { reason: string }).reason, "unsupported-review-shape");
  assert.equal(reviewedEvidenceOf(bundle).length, 0, "no reviewed-extraction evidence is fabricated for an unsupported shape");
  // Survey's own (pre-#88) evidence for the recheck round is untouched.
  assert.ok(bundle.evidence.length > 0);
});
