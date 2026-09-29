import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { join } from "node:path";
import test from "node:test";
import { importExtractionEnvelope, type ReviewItem } from "@kontourai/survey";
import { buildReviewSessionEvents, hashReviewQueueSnapshot, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import {
  bindExtraction, FIELDWORK_SOURCE_KIND, importNameFor, newReviewRound, projectAttestedReviewedProjection, reviewedExport, runFieldwork,
} from "../src/fieldwork.js";
import { inspectionExport } from "../src/inspection.js";
import { readRun, readRunMetadata, type StoredRun } from "../src/run-store.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";
import { ReviewedWebSourceReader } from "../src/reviewed-web-source.js";
import { parseReviewedWebSourceDescriptor } from "../src/reviewed-web-source-contract.js";

const exec = promisify(execFile);
import { conflictRun } from "./helpers/conflict-run.js";
import { partialRunWithProposals } from "./helpers/incomplete-runs.js";

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
  return forgeUnverifiedExcerpt(await conflictRun(label), "Active", "Status: Actiff", "Actiff");
}

/** Replace one proposal's excerpt with same-length text the source does not contain there, and re-bind the run. */
async function forgeUnverifiedExcerpt(run: string, value: string, excerpt: string, candidateValue: string): Promise<string> {
  const { runPath, envelopePath, run: stored, envelope } = await files(run);
  const proposal = envelope.result.proposals.find((entry) => entry.candidateValue === value)!;
  assert.equal(proposal.provenance.excerpt.length, excerpt.length);
  proposal.provenance.excerpt = excerpt;
  proposal.candidateValue = candidateValue;
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
  const statusClaim = claims.find((claim) => claim.fieldOrBehavior === "record.status")! as { id: string; value: unknown; status?: string };
  assert.equal(statusClaim.value, "Paused");
  // Contested, not plainly verified: in the bundle and in the export's scope.
  assert.equal(statusClaim.status, "disputed");
  assert.equal((claims.find((claim) => claim.fieldOrBehavior === "record.alpha") as { status?: string }).status, "verified");
  assert.deepEqual((exported.reviewRound as { groundingRefused?: unknown }).groundingRefused,
    [{ claimId: statusClaim.id, fieldPath: "record.status", gaps: ["excluded-rival-unresolved"] }]);
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

test("a field whose every proposal fails its excerpt check refuses the export, naming the field", async () => {
  // record.alpha has one proposal; with it excluded there is no item left for it.
  const run = await forgeUnverifiedExcerpt(await conflictRun("lost-field"), "alpha-value", "alpha: alphaXvalue", "alphaXvalue");
  const snapshot = (await view(run)).review.snapshot as unknown as ReviewQueueSessionState;
  assert.deepEqual(snapshot.items.map((item) => item.spec.target), ["record.status"], "the field has no review item");
  assert.equal((await post(run, snapshot, acceptAll(snapshot, "Paused"))).ok, true);
  await assert.rejects(() => reviewedExport(run), (error: Error & { code?: string; fieldPaths?: string[] }) => {
    assert.equal(error.code, "EXPORT_EXCERPT_MISMATCH");
    assert.deepEqual(error.fieldPaths, ["record.alpha"]);
    assert.match(error.message, /record\.alpha/);
    return true;
  });
});

test("the CLI reports a claim whose grounding was refused and exits non-zero", async () => {
  const run = await runWithExcludedRival("cli-contested");
  const snapshot = (await view(run)).review.snapshot as unknown as ReviewQueueSessionState;
  assert.equal((await post(run, snapshot, acceptAll(snapshot))).ok, true);
  const outputPath = join(run, "..", "export.json");
  await assert.rejects(
    () => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "export", run, "--output", outputPath, "--json"]),
    (error: { code?: number; stdout: string }) => {
      assert.equal(error.code, 3);
      const summary = JSON.parse(error.stdout);
      assert.equal(summary.complete, true, "nothing was excluded");
      assert.deepEqual(summary.groundingRefused.map((entry: { fieldPath: string }) => entry.fieldPath), ["record.status"]);
      return true;
    },
  );
});

test("an edit to the envelope's outcome or coverage, not only its proposals, is refused", async () => {
  // A partial run's envelope edited to read as complete: its outcome made a
  // success, or its unread chunk marked read. Both stay valid envelopes, so
  // only the binding can tell.
  for (const [label, edit] of [
    ["outcome", (result: Record<string, unknown>) => {
      result.outcome = { status: "success" };
      delete result.partial; delete result.coverage; delete result.providerFailures;
    }],
    ["coverage", (result: Record<string, unknown>) => {
      result.coverage = (result.coverage as { reason?: string; status: string }[]).map(({ reason: _reason, ...entry }) => ({ ...entry, status: "complete" }));
    }],
  ] as const) {
    const run = await partialRunWithProposals(`envelope-${label}`);
    const { runPath, envelopePath, run: stored, envelope } = await files(run);
    const preparedText = (await readRun(run)).preparedText;
    edit(envelope.result as unknown as Record<string, unknown>);
    // The queue and its digest are rebuilt from the edited envelope, as in the
    // proposal-deletion attack, so the queue attestation agrees with the edit.
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
    await writeFile(runPath, JSON.stringify({ ...stored, review: newReviewRound(reimport(stored, envelope, preparedText).reviewItems, stored.createdAt) }, null, 2));
    await assert.rejects(() => view(run), refused("RUN_ENVELOPE_MISMATCH"));
    await assert.rejects(() => reviewedExport(run), refused("RUN_ENVELOPE_MISMATCH"));
  }
});

test("the reviewed-source facade describes a claim whose grounding was refused as such", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-contested-snapshots-"));
  const root = await tempRoot("contested-facade");
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  const [statusProjection] = task.spec.projections;
  task.spec.traverse.targetSchema.push({ path: "record.alpha", type: "string", inferenceType: "explicit" });
  task.spec.projections.push({ ...statusProjection, fieldPath: "record.alpha", pattern: "alpha: ([^\\n]+)" });
  const taskPath = join(root, "task.json");
  await writeFile(taskPath, JSON.stringify(task));
  const body = `alpha: alpha-value\nStatus: Active\n${"filler line of text.\n".repeat(700)}Status: Paused\n`;
  const captured = { sourceId: "contested-source", url: "https://example.test/contested", status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "text/plain" } };
  await createFilesystemSnapshotStore({ root: snapshotRoot }).put(captured);
  const created = await runFieldwork({ taskPath, snapshotRef: buildSnapshotSourceRef(captured), snapshotRoot, root });
  const run = await forgeUnverifiedExcerpt(created.runDirectory, "Active", "Status: Actiff", "Actiff");
  const snapshot = (await view(run)).review.snapshot as unknown as ReviewQueueSessionState;
  assert.equal((await post(run, snapshot, acceptAll(snapshot))).ok, true);

  const reader = new ReviewedWebSourceReader({ runDirectory: run, snapshotRoot, authorize: () => true });
  const listed = await reader.listReviewedWebSourceRefs();
  assert.equal(listed.status, "available");
  const states: Record<string, string> = {};
  for (const exactRef of listed.status === "available" ? listed.refs : []) {
    const described = await reader.describeReviewedWebSource(exactRef);
    assert.equal(described.status, "available");
    if (described.status !== "available") continue;
    assert.deepEqual(parseReviewedWebSourceDescriptor(described), described);
    states[described.evidence.reviewItem.name] = described.review.state;
  }
  const status = snapshot.items.find((item) => item.spec.target === "record.status")!.metadata.name;
  const alpha = snapshot.items.find((item) => item.spec.target === "record.alpha")!.metadata.name;
  assert.deepEqual(states, { [status]: "grounding-refused", [alpha]: "reviewed" });
});
