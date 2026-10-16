import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { openRun, recheckFieldwork, reviewedExport, type FieldworkRunViewV1 } from "../src/index.js";
import { FieldworkSourceCheckReceiptStore } from "../src/source-check-receipts.js";
import { apiFetch } from "./helpers.js";
import { currentRef, files, ownerFixture } from "./helpers/recheck-owner-fixture.js";

for (const restored of ["same", "changed"] as const) test(`503 settles a non-current failure; ordinary restored ${restored} recheck recovers`, async (t) => {
  const f = await ownerFixture(t, "http");
  const priorFiles = await files(f.prior.runDirectory);
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const history = await files(f.receiptRoot);
  f.setMode("error");
  const outage = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(outage.classification, "source-unavailable");
  assert.equal(outage.check?.kind, "error");
  assert.equal(f.requests.at(-1)?.status, 503);
  assert.notEqual((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "available");
  const failedHistory = await files(f.receiptRoot);
  f.setMode(restored);
  const result = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(f.requests.at(-1)?.status, 200);
  assert.equal(result.classification, restored === "same" ? "unchanged-source" : "semantic-drift");
  assert.equal(result.providerSkipped, restored === "same");
  assert.equal(f.runtime.requests.length, restored === "same" ? 1 : 2);
  const current = await f.receipts.readCurrentWithWitness(f.source.id);
  assert.ok(current.kind === "available");
  assert.equal(current.receipt.generation, 3);
  if (restored === "changed") {
    assert.ok(result.run);
    const service = await openRun(result.run.runDirectory, { port: 0, reviewer: { id: "recovery-test", kind: "agent" } });
    try {
      const view = await apiFetch(service, "/api/v1/run").then((r) => r.json()) as FieldworkRunViewV1;
      assert.equal(view.run.revision, 0);
      assert.equal(view.review.events.length, 0, "the previous review must never renew");
      await assert.rejects(reviewedExport(result.run.runDirectory), (e: { code?: string }) => e.code === "EXPORT_UNDECIDED");
      const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
      const events = buildReviewSessionEvents({ ...snapshot,
        decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"])),
      } as Parameters<typeof buildReviewSessionEvents>[0]);
      const saved = await apiFetch(service, "/api/v1/review", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
      }).then((r) => r.json());
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const output = await reviewedExport(result.run.runDirectory);
      assert.deepEqual(output.bundle.claims.map((claim) => claim.value), ["Pending"]);
      assert.ok(output.bundle.evidence.some((evidence) => evidence.sourceRef === currentRef(result.check!)));
    } finally { await service.close(); }
  }
  assert.deepEqual(await files(f.prior.runDirectory), priorFiles);
  const after = await files(f.receiptRoot);
  for (const [file, bytes] of Object.entries({ ...history, ...failedHistory })) {
    if (file.endsWith("/pointer.json")) continue;
    assert.equal(after[file], bytes, `immutable receipt ${file}`);
  }
});

test("a thrown acquisition failure before capture is settled and retryable without a prior successful check", async (t) => {
  const f = await ownerFixture(t);
  const before = await files(f.prior.runDirectory);
  const failed = await recheckFieldwork({ ...f.options, acquisition: { async check() { throw new Error("transport unavailable"); } } });
  assert.equal(failed.classification, "source-unavailable");
  assert.equal(failed.check, null);
  assert.equal((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "unavailable");
  const restored = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(restored.classification, "unchanged-source");
  assert.deepEqual(await files(f.prior.runDirectory), before);
});

test("a failed receipt cannot restart after the authenticated acquisition owner advances", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("error");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  f.setMode("changed");
  await f.check(); // A legitimate independent owner operation, not a state edit.
  const before = await files(f.receiptRoot);
  let checks = 0;
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() { ++checks; return f.check(); } } }),
    (e: { code?: string }) => e.code === "RECHECK_CONFLICT");
  assert.equal(checks, 0);
  assert.deepEqual(await files(f.receiptRoot), before);
});

test("a concurrent pending writer is never cleared by an ordinary recheck", async (t) => {
  const f = await ownerFixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  f.setMode("error");
  const writer = recheckFieldwork({ ...f.options, acquisition: { async check() { entered(); await resume; return f.check(); } } });
  await started;
  const before = await files(f.receiptRoot);
  let checks = 0;
  try {
    await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() { ++checks; return f.check(); } } }),
      (e: { code?: string }) => e.code === "RECHECK_CONFLICT");
    assert.equal(checks, 0);
    assert.deepEqual(await files(f.receiptRoot), before);
  } finally { release(); }
  assert.equal((await writer).classification, "source-unavailable");
  f.setMode("same");
  assert.equal((await recheckFieldwork({ ...f.options, acquisition: { check: f.check } })).classification, "unchanged-source");
});

test("a superseding pending token fences failure settlement without erasing the newer writer", async (t) => {
  const f = await ownerFixture(t);
  let newer: Awaited<ReturnType<typeof f.receipts.begin>> | undefined;
  f.setMode("error");
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() {
    const head = await f.readHead();
    assert.ok(head);
    newer = await f.receipts.begin(f.source.id, { pointerToken: await f.receipts.currentPointerToken(f.source.id),
      proposalHeadId: head, admittedAcquisition: await f.capture(f.initialRef) }, f.readHead);
    return f.check();
  } } }), (e: { code?: string }) => e.code === "RECHECK_CONFLICT");
  assert.ok(newer);
  assert.equal(await f.receipts.currentPointerToken(f.source.id), newer.pointerToken);
  assert.equal((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "pending");
  assert.equal((await f.receipts.readAcquisitionFailureForRetry(f.source.id)).kind, "unavailable");
});


test("terminal acquisition failure is recorded separately from currentness", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("error");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "unavailable");
  const failure = await f.receipts.readAcquisitionFailureForRetry(f.source.id);
  assert.ok(failure.kind === "retryable");
  assert.equal(failure.receipt.outcome, "error");
  assert.equal(failure.receipt.generation, 1);
  assert.equal(failure.receipt.priorProposalHeadId, failure.receipt.resultProposalHeadId);
  assert.deepEqual(failure.receipt.priorCapture, failure.receipt.currentCapture);
});

test("a failed receipt cannot restart after the authenticated proposal owner advances", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("error");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const latest = await f.observations.loadLatest(f.source.id);
  assert.ok(latest.ok && latest.value);
  const advanced = await f.observations.commit({ observation: {
    sourceId: f.source.id, snapshotRef: latest.value.snapshotRef,
    observedAt: "2026-08-26T15:00:00.000Z", proposals: latest.value.proposals,
  }, recordedAt: "2026-08-26T15:00:00.000Z", check: latest.value.check }, latest.value.observationId);
  assert.ok(advanced.ok);
  const before = await files(f.receiptRoot);
  let checks = 0;
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() { ++checks; return f.check(); } } }),
    (e: { code?: string }) => e.code === "RECHECK_CONFLICT");
  assert.equal(checks, 0);
  assert.deepEqual(await files(f.receiptRoot), before);
});

test("a pending writer arriving after failed-baseline read cannot be adopted by retry", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("error");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const original = FieldworkSourceCheckReceiptStore.prototype.readAcquisitionFailureForRetry;
  let supersedingToken: string | undefined;
  t.mock.method(FieldworkSourceCheckReceiptStore.prototype, "readAcquisitionFailureForRetry", async function (this: FieldworkSourceCheckReceiptStore, id: string) {
    const failed = await original.call(this, id);
    assert.ok(failed.kind === "retryable");
    const pending = await this.begin(id, failed.baseline, f.readHead);
    supersedingToken = pending.pointerToken;
    return failed;
  });
  let checks = 0;
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() { ++checks; return f.check(); } } }),
    (e: { code?: string }) => e.code === "RECHECK_CONFLICT");
  assert.equal(checks, 0);
  assert.ok(supersedingToken);
  assert.equal(await f.receipts.currentPointerToken(f.source.id), supersedingToken);
  assert.equal((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "pending");
});

for (const failureKind of ["returned-error", "throw"] as const) for (const restoredMode of ["same", "304", "changed"] as const) test(`legacy capture retains lower assurance through ${failureKind} and ordinary ${restoredMode} recovery`, async (t) => {
  const f = await ownerFixture(t, "response", true);
  const before = await files(f.prior.runDirectory);
  f.setMode("error");
  const failed = await recheckFieldwork({ ...f.options, acquisition: { check: failureKind === "throw"
    ? async () => { throw new Error("transport unavailable"); } : f.check } });
  assert.equal(failed.classification, "source-unavailable");
  assert.equal((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "unavailable");
  const failure = await f.receipts.readAcquisitionFailureForRetry(f.source.id);
  assert.ok(failure.kind === "retryable");
  assert.equal(failure.receipt.priorCapture.integrity, "body-and-identity");
  assert.equal(failure.receipt.currentCapture.integrity, "body-and-identity");
  assert.equal(failure.receipt.currentCapture.snapshotDigest, undefined);
  assert.ok(failure.receipt.acquisitionHead.headSnapshotRef.snapshotDigest);
  const retained = await files(f.receiptRoot);
  f.setMode(restoredMode);
  const restored = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(restored.classification, restoredMode === "changed" ? "semantic-drift" : "unchanged-source");
  assert.equal(restored.providerSkipped, restoredMode !== "changed");
  const current = await f.receipts.readCurrentWithWitness(f.source.id);
  assert.ok(current.kind === "available");
  assert.equal(current.receipt.currentCapture.integrity, "snapshot-envelope");
  const after = await files(f.receiptRoot);
  for (const [file, bytes] of Object.entries(retained)) if (!file.endsWith("/pointer.json")) assert.equal(after[file], bytes);
  assert.deepEqual(await files(f.prior.runDirectory), before);
});

test("a same-observation owner pointer replacement invalidates the failed proposal witness", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("error");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const failure = await f.receipts.readAcquisitionFailureForRetry(f.source.id);
  assert.ok(failure.kind === "retryable");
  const latest = await f.observations.loadLatest(f.source.id);
  assert.ok(latest.ok && latest.value);
  const prior = latest.value;
  const replaced = await f.observations.commit({ observation: {
    sourceId: prior.sourceId, snapshotRef: prior.snapshotRef, observedAt: prior.observedAt,
    proposals: prior.proposals,
  }, recordedAt: prior.recordedAt, check: prior.check }, prior.observationId);
  assert.ok(replaced.ok);
  assert.equal(replaced.value.observationId, prior.observationId);
  assert.notEqual((await f.observations.compareHeadWitness(failure.receipt.proposalHead)).kind, "matches");
  let checks = 0;
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() { ++checks; return f.check(); } } }),
    (e: { code?: string }) => e.code === "RECHECK_CONFLICT");
  assert.equal(checks, 0);
});

test("legacy failure admission does not allow a successful receipt without its envelope digest", async (t) => {
  const f = await ownerFixture(t, "response", true);
  f.setMode("error");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const failed = await f.receipts.readAcquisitionFailureForRetry(f.source.id);
  assert.ok(failed.kind === "retryable");
  const pending = await f.receipts.begin(f.source.id, failed.baseline, f.readHead);
  const { version: _version, sourceId: _sourceId, generation: _generation, ...completion } = failed.receipt;
  const result = await f.receipts.finalize(pending, { ...completion, outcome: "unchanged-304" }, f.readHead);
  assert.equal(result.kind, "corrupt");
  assert.equal((await f.receipts.readCurrentWithWitness(f.source.id)).kind, "pending");
});
