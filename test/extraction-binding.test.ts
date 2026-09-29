import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { importExtractionEnvelope, type ReviewItem } from "@kontourai/survey";
import { buildReviewSessionEvents, hashReviewQueueSnapshot, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import {
  bindExtraction, FIELDWORK_SOURCE_KIND, importNameFor, newReviewRound, projectAttestedReviewedProjection, reviewedExport,
} from "../src/fieldwork.js";
import { inspectionExport } from "../src/inspection.js";
import { readRun, readRunMetadata, type StoredRun } from "../src/run-store.js";
import { openRun } from "../src/server.js";
import { apiFetch } from "./helpers.js";
import { conflictRun } from "./helpers/conflict-run.js";

/*
 * A run's stored extraction envelope is bound to the run when it is created
 * (fieldwork#164), and Survey verifies every excerpt against the prepared text
 * at import (fieldwork#165).
 */

interface Proposal { fieldPath: string; candidateValue: unknown; provenance: { excerpt: string; locator: string } }

const refused = (code: string) => (error: Error & { code?: string }) => {
  assert.equal(error.code, code, error.message);
  return true;
};

async function view(runDirectory: string): Promise<FieldworkRunViewV1> {
  const service = await openRun(runDirectory);
  try { return await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1; }
  finally { await service.close(); }
}

async function post(runDirectory: string, snapshot: ReviewQueueSessionState, decisions: Pick<ReviewQueueSessionState, "decisionsByItemName" | "selectedCandidateIdsByItemName">): Promise<{ ok: boolean; error?: { code: string } }> {
  const service = await openRun(runDirectory);
  try {
    const events = buildReviewSessionEvents({ ...snapshot, ...decisions });
    return await apiFetch(service, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean; error?: { code: string } };
  } finally { await service.close(); }
}

/** Every item decided the way that exports: the conflict's chosen value, and every other item accepted. */
function acceptAll(snapshot: ReviewQueueSessionState, chosen?: string): Pick<ReviewQueueSessionState, "decisionsByItemName" | "selectedCandidateIdsByItemName"> {
  const decisionsByItemName: Record<string, string> = {};
  const selectedCandidateIdsByItemName: Record<string, string> = {};
  for (const item of snapshot.items) {
    if (item.spec.candidates.length > 1) {
      decisionsByItemName[item.metadata.name] = "select-proposed";
      selectedCandidateIdsByItemName[item.metadata.name] = item.spec.candidates.find((candidate) => candidate.value === chosen)!.id;
    } else decisionsByItemName[item.metadata.name] = "accept-proposed";
  }
  return { decisionsByItemName, selectedCandidateIdsByItemName } as never;
}

async function files(runDirectory: string) {
  const runPath = join(runDirectory, "run.json");
  const envelopePath = join(runDirectory, "extraction-envelope.json");
  return {
    runPath, envelopePath,
    run: JSON.parse(await readFile(runPath, "utf8")) as StoredRun,
    envelope: JSON.parse(await readFile(envelopePath, "utf8")) as { result: { proposals: Proposal[] } },
  };
}

/** Survey's import of `envelope` for this run, as an editor would rebuild it; verified when `preparedText` is given. */
function reimport(run: StoredRun, envelope: unknown, preparedText?: string) {
  return importExtractionEnvelope(envelope as never, {
    importName: importNameFor(run), producerNamespace: "fieldwork", sourceKind: FIELDWORK_SOURCE_KIND,
    claimTarget: (proposal) => {
      const projection = run.task.spec.projections.find((entry) => entry.fieldPath === proposal.fieldPath)!;
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    },
    ...(preparedText === undefined ? {} : {
      artifact: { status: "available" as const, text: preparedText, actualDigest: run.preparedArtifact.digest },
    }),
  });
}

test("deleting one value of a conflict from the envelope, with the queue and its digest rebuilt, is refused everywhere", async () => {
  const run = await conflictRun("unbound-edit");
  const honest = await view(run);
  const snapshot = honest.review.snapshot as unknown as ReviewQueueSessionState;
  assert.deepEqual(snapshot.items.find((item) => item.spec.candidates.length > 1)?.spec.candidates.map((candidate) => candidate.value), ["Active", "Paused"]);

  // The edit: "Active" leaves the envelope, and the queue is rebuilt from the
  // edited envelope exactly as the writer builds it, digest included. The
  // conflict is gone, and "Paused" reads as uncontested.
  const { runPath, envelopePath, run: stored, envelope } = await files(run);
  const preparedText = (await readRun(run)).preparedText;
  envelope.result.proposals = envelope.result.proposals.filter((proposal) => proposal.candidateValue !== "Active");
  const rebuilt = reimport(stored, envelope, preparedText);
  assert.ok(rebuilt.reviewItems.every((item) => item.spec.candidates.length === 1), "the edited envelope has no conflict left");
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  await writeFile(runPath, JSON.stringify({ ...stored, review: newReviewRound(rebuilt.reviewItems, stored.createdAt) }, null, 2));
  const editedSnapshot = { ...snapshot, items: rebuilt.reviewItems } as unknown as ReviewQueueSessionState;

  // Opening, and exporting, and the metadata-only read the reviewed-source facade makes.
  await assert.rejects(() => view(run), refused("RUN_ENVELOPE_MISMATCH"));
  await assert.rejects(() => reviewedExport(run), refused("RUN_ENVELOPE_MISMATCH"));
  await assert.rejects(() => readRunMetadata(run), refused("RUN_ENVELOPE_MISMATCH"));

  // Removing the binding as well does not unlock it. Kept with the verified
  // queue, the run no longer attests; rebuilt the way the previous release
  // built queues, it opens as a run from before the binding, which is closed.
  const { extraction: _extraction, ...unbound } = { ...stored, review: newReviewRound(rebuilt.reviewItems, stored.createdAt) };
  await writeFile(runPath, JSON.stringify(unbound, null, 2));
  await assert.rejects(() => view(run), refused("REVIEW_QUEUE_UNATTESTED"));
  await writeFile(runPath, JSON.stringify({ ...unbound, review: newReviewRound(reimport(stored, envelope).reviewItems, stored.createdAt) }, null, 2));
  assert.equal((await view(run)).reviewBlocked?.reason, "unbound-envelope");
  assert.equal((await post(run, editedSnapshot, acceptAll(editedSnapshot))).error?.code, "RUN_ENVELOPE_UNBOUND");
  await assert.rejects(() => reviewedExport(run), refused("EXPORT_UNBOUND_ENVELOPE"));
});

test("a decision appended after the envelope was edited under an open run is refused and not recorded", async () => {
  const run = await conflictRun("append-after-edit");
  const service = await openRun(run);
  try {
    const opened = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = opened.review.snapshot as unknown as ReviewQueueSessionState;
    // The edit lands between the page loading and the reviewer deciding.
    const { runPath, envelopePath, run: stored, envelope } = await files(run);
    const preparedText = (await readRun(run)).preparedText;
    envelope.result.proposals = envelope.result.proposals.filter((proposal) => proposal.candidateValue !== "Active");
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
    await writeFile(runPath, JSON.stringify({ ...stored, review: newReviewRound(reimport(stored, envelope, preparedText).reviewItems, stored.createdAt) }, null, 2));

    const response = await apiFetch(service, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: buildReviewSessionEvents({ ...snapshot, ...acceptAll(snapshot, "Paused") }), expectedEventCount: 0, expectedRevision: 0 }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "RUN_ENVELOPE_MISMATCH");
    assert.deepEqual(JSON.parse(await readFile(runPath, "utf8")).review.events, [], "nothing was appended");
  } finally {
    await service.close().catch((error: Error & { code?: string }) => assert.equal(error.code, "RUN_ENVELOPE_MISMATCH"));
  }
});

test("a run created before the binding opens with a notice, refuses decisions and export, and says why", async () => {
  // A run as the previous release wrote it: no binding, and a queue from an
  // import that did not verify excerpts.
  const run = await conflictRun("legacy");
  const { runPath, run: stored, envelope } = await files(run);
  const legacyImport = reimport(stored, envelope);
  const { extraction: _extraction, ...legacy } = { ...stored, review: newReviewRound(legacyImport.reviewItems, stored.createdAt) };
  await writeFile(runPath, JSON.stringify(legacy, null, 2));

  // Migration: verifying excerpts changes the queue a run's import rebuilds
  // (Survey marks each item verified), so a legacy queue can never attest
  // against a verified import. It is kept on the import it was built from and
  // closed, rather than silently re-bound to whatever envelope it now holds.
  const verified = reimport(stored, envelope, (await readRun(run)).preparedText);
  assert.notEqual(hashReviewQueueSnapshot({ ...legacy.review.snapshot, items: verified.reviewItems as ReviewItem[] }), legacy.review.snapshotHash);

  const served = await view(run);
  assert.equal(served.reviewBlocked?.reason, "unbound-envelope");
  assert.match(served.reviewBlocked!.message, /edit to that extraction cannot be detected.*re-run the source/s);
  const snapshot = served.review.snapshot as unknown as ReviewQueueSessionState;
  assert.equal((await post(run, snapshot, acceptAll(snapshot, "Paused"))).error?.code, "RUN_ENVELOPE_UNBOUND");
  assert.deepEqual(JSON.parse(await readFile(runPath, "utf8")).review.events, [], "nothing was appended");
  await assert.rejects(() => reviewedExport(run), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_UNBOUND_ENVELOPE");
    assert.match(error.message, /cannot be exported/);
    return true;
  });
  const inspected = JSON.parse(await inspectionExport(run)) as { spec: { reviewBlocked?: { reason: string } } };
  assert.equal(inspected.spec.reviewBlocked?.reason, "unbound-envelope");
});

/**
 * A run whose extraction carried an excerpt the prepared text does not
 * contain at the cited span. Traverse does not emit one, so the fixture edits
 * a real run's envelope and re-binds it through the same writer
 * (`bindExtraction`) the run was created with.
 */
async function runWithExcludedRival(label: string): Promise<string> {
  const run = await conflictRun(label);
  const { runPath, envelopePath, run: stored, envelope } = await files(run);
  const active = envelope.result.proposals.find((proposal) => proposal.candidateValue === "Active")!;
  assert.equal(active.provenance.excerpt, "Status: Active");
  active.provenance.excerpt = "Status: Actiff";
  active.candidateValue = "Actiff";
  const { imported, extraction } = bindExtraction(stored.task, importNameFor(stored), envelope as never, (await readRun(run)).preparedText);
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  await writeFile(runPath, JSON.stringify({ ...stored, extraction, review: newReviewRound(imported.reviewItems, stored.createdAt) }, null, 2));
  return run;
}

test("a proposal whose excerpt does not verify is excluded, shown as an excluded rival, and refuses its claim's grounding", async () => {
  const run = await runWithExcludedRival("excluded-rival");
  const served = await view(run);
  const snapshot = served.review.snapshot as unknown as ReviewQueueSessionState;
  const status = snapshot.items.find((item) => item.spec.target === "record.status")!;
  assert.deepEqual(status.spec.candidates.map((candidate) => candidate.value), ["Paused"], "the unverified value is not a candidate");
  const producer = status.metadata.producer!["survey.kontourai.io/extraction-envelope"] as { excerptVerification?: string; excludedProposals?: { value: unknown; reason: string }[] };
  assert.equal(producer.excerptVerification, "verified");
  assert.deepEqual(producer.excludedProposals?.map((entry) => [entry.value, entry.reason]), [["Actiff", "excerpt-mismatch"]]);
  const record = served.review.extractionImport as { status: { provenance?: string; diagnostics: { kind: string }[] } };
  assert.equal(record.status.provenance, "verified");
  assert.deepEqual(record.status.diagnostics.map((diagnostic) => diagnostic.kind), ["excerpt-mismatch"]);

  const saved = await post(run, snapshot, acceptAll(snapshot));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const exported = await reviewedExport(run);
  const claims = (exported.bundle as unknown as { claims: { id: string; fieldOrBehavior: string; value: unknown }[] }).claims;
  const statusClaim = claims.find((claim) => claim.fieldOrBehavior === "record.status")!;
  assert.equal(statusClaim.value, "Paused");
  const grounding = exported.reviewedGrounding as {
    outcome: string;
    gaps: { kind: string; claimId: string; rivalProposalIndices?: number[] }[];
    dimensions: { claimId: string; excerptVerification?: string; excludedRivals?: { proposalIndices: number[] } }[];
  };
  const activeIndex = (await files(run)).envelope.result.proposals.findIndex((proposal) => proposal.candidateValue === "Actiff");
  assert.equal(grounding.outcome, "refused");
  assert.deepEqual(grounding.gaps, [{ kind: "excluded-rival-unresolved", claimId: statusClaim.id, evidenceId: grounding.gaps[0]!["evidenceId" as never], rivalProposalIndices: [activeIndex] }]);
  assert.deepEqual(grounding.dimensions.find((entry) => entry.claimId === statusClaim.id)?.excludedRivals?.proposalIndices, [activeIndex]);
  assert.ok(grounding.dimensions.every((entry) => entry.excerptVerification === "verified"));
});

test("a metadata-only read rebuilds the verified import from the status bound at creation", async () => {
  const run = await runWithExcludedRival("metadata-only");
  const snapshot = (await view(run)).review.snapshot as unknown as ReviewQueueSessionState;
  assert.equal((await post(run, snapshot, acceptAll(snapshot))).ok, true);
  const full = projectAttestedReviewedProjection(await readRun(run));
  const metadata = projectAttestedReviewedProjection(await readRunMetadata(run));
  assert.equal(metadata.imported.record.status.provenance, "verified");
  assert.deepEqual(metadata.imported.record, full.imported.record);
  assert.deepEqual(metadata.enrichment.grounding.outcome, "refused");

  // A bound status edited to hide the mismatch no longer rebuilds the queue the
  // reviewer decided on the metadata path, and disagrees with Survey's own
  // verification on every path that has the prepared text.
  const { runPath, run: stored } = await files(run);
  stored.extraction!.importStatus.diagnostics = [];
  await writeFile(runPath, JSON.stringify(stored, null, 2));
  await assert.rejects(async () => projectAttestedReviewedProjection(await readRunMetadata(run)), refused("EXPORT_UNATTESTED_QUEUE"));
  await assert.rejects(() => reviewedExport(run), refused("RUN_EXTRACTION_MISMATCH"));
});
