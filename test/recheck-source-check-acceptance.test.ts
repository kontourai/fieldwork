import assert from "node:assert/strict";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { fetchSource, buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { type CheckResult } from "@kontourai/lookout";
import { recheckFieldwork, runFieldwork, type FieldworkRecheckResult } from "../src/index.js";
import { readRun } from "../src/run-store.js";
import { FieldworkSourceCheckReceiptStore, type Baseline, type Capture, type Receipt } from "../src/source-check-receipts.js";
import { currentRef, fetchedAt, files, ownerFixture, taskPath } from "./helpers/recheck-owner-fixture.js";

// Test-first contract approved for THIS result kind only. Keeping this local
// permits runtime RED tests before production exports the v2 discriminated DTO.
type RecheckV2 = Omit<FieldworkRecheckResult, "apiVersion" | "check" | "priorObservation"> & {
  apiVersion: "fieldwork.kontourai.io/v2";
  acquisition: { kind: "not-run"; reason: "task-drift" } | { kind: "completed" } | { kind: "failed" };
  check: CheckResult | null;
  priorObservation: FieldworkRecheckResult["priorObservation"] | null;
};
const v2 = (result: FieldworkRecheckResult) => result as unknown as RecheckV2;

async function available(f: Awaited<ReturnType<typeof ownerFixture>>): Promise<Receipt> {
  const result = await f.receipts.readCurrent(f.source.id, f.readHead);
  assert.equal(result.kind, "available", "a completed recheck must publish its authenticated receipt");
  assert.ok(result.kind === "available");
  return result.receipt;
}

function completed(result: FieldworkRecheckResult, check: CheckResult) {
  const actual = v2(result);
  assert.equal(actual.apiVersion, "fieldwork.kontourai.io/v2");
  assert.deepEqual(actual.acquisition, { kind: "completed" });
  assert.deepEqual(actual.check, check, "retain the actual acquisition-issued result, including checkedAt");
}

function recoveryFailure(error: unknown, code = "RECHECK_OBSERVATION_FAILED") {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code?: string }).code, code);
  assert.doesNotMatch(error.message, /private-canary|EACCES|fieldwork-recheck-owner|\/Users\//);
  return true;
}

test("real guarded HTTP fixture proves 200 A -> same-byte B -> conditional304 B -> same-byte C -> changed D", async (t) => {
  const f = await ownerFixture(t, "http");
  const refs = [f.initialRef];
  for (const [mode, kind] of [["same", "unchanged-hash"], ["304", "unchanged-304"], ["same", "unchanged-hash"], ["changed", "changed"]] as const) {
    f.setMode(mode);
    const check = await f.check();
    assert.equal(check.kind, kind);
    if (check.kind !== "unchanged-304") assert.equal(check.priorSnapshotRef, refs.at(-1));
    refs.push(currentRef(check));
  }
  assert.deepEqual(f.requests.map((entry) => entry.status), [200, 200, 304, 200, 200]);
  assert.equal(f.requests[2]?.validator, '"v1"');
  assert.notEqual(refs[0], refs[1]);
  assert.equal(refs[1], refs[2]);
  assert.notEqual(refs[2], refs[3]);
  const captures = await Promise.all(refs.map(f.capture));
  assert.equal(captures[0]?.bodyHash, captures[3]?.bodyHash);
  assert.notEqual(captures[3]?.bodyHash, captures[4]?.bodyHash);
});

for (const transport of ["http", "response"] as const) test(`public recheck keeps proposal P while acquisition advances A/B/B/C, then persists D/Q review (${transport})`, async (t) => {
  const f = await ownerFixture(t, transport);
  let previousCapture = await f.capture(f.initialRef);
  let proposalHead: string | undefined;
  let generation = 0;
  for (const [mode, kind] of [["same", "unchanged-hash"], ["304", "unchanged-304"], ["same", "unchanged-hash"], ["changed", "changed"]] as const) {
    f.setMode(mode);
    let check!: CheckResult;
    const result = await recheckFieldwork({ ...f.options, acquisition: { async check() { return check = await f.check(); } } });
    assert.equal(check.kind, kind);
    completed(result, check);
    const receipt = await available(f);
    assert.equal(receipt.generation, ++generation);
    assert.equal(receipt.checkedAt, check.checkedAt);
    assert.deepEqual(receipt.priorCapture, previousCapture);
    assert.deepEqual(receipt.currentCapture, await f.capture(currentRef(check)));
    assert.notEqual(receipt.checkedAt, receipt.currentCapture.fetchedAt);
    assert.doesNotMatch(JSON.stringify(receipt), /Status: Active|Status: Pending|"body":|"proposals":/);
    proposalHead ??= result.priorObservation.observationId;
    assert.equal(result.priorObservation.observationId, proposalHead);
    assert.equal(result.priorObservation.snapshotRef, f.initialRef);
    if (mode !== "changed") {
      assert.equal(result.classification, "unchanged-source");
      assert.equal(result.providerSkipped, true);
      assert.equal(f.runtime.requests.length, 1, "unchanged checks must not invoke the runtime");
      assert.equal(result.currentObservation, null);
      assert.equal(result.run, null);
      assert.equal(await f.readHead(), proposalHead);
      assert.equal(receipt.resultProposalHeadId, proposalHead);
    } else {
      assert.equal(result.classification, "semantic-drift");
      assert.equal(result.providerSkipped, false);
      assert.equal(f.runtime.requests.length, 2);
      assert.ok(result.currentObservation);
      assert.notEqual(result.currentObservation.observationId, proposalHead);
      assert.equal(receipt.resultProposalHeadId, result.currentObservation.observationId);
      assert.ok(result.run);
      const current = await readRun(result.run.runDirectory);
      assert.deepEqual(current.run.review.snapshot.items, result.review.items);
      assert.equal(current.run.review.revision, 0);
      assert.equal(current.run.review.events.length, 0);
      assert.ok(result.review.itemCount > 0);
    }
    previousCapture = receipt.currentCapture;
    await f.frozenPrior();
  }
});

test("a real owner-backed v2 receipt binds both heads and its private read witness", async (t) => {
  const f = await ownerFixture(t, "http");
  const result = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const read = await f.receipts.readCurrentWithWitness(f.source.id);
  assert.equal(read.kind, "available");
  assert.ok(read.kind === "available");
  assert.equal(read.receipt.version, 2);
  assert.equal(read.receipt.acquisitionHead.sourceId, f.source.id);
  assert.equal(read.receipt.acquisitionHead.headSnapshotRef.bodyHash, (await f.capture(currentRef(result.check!))).bodyHash);
  assert.equal(read.receipt.proposalHead.sourceId, f.source.id);
  assert.equal(read.receipt.proposalHead.observationId, result.priorObservation!.observationId);
  assert.equal(read.receipt.proposalHeadSnapshotRef, result.priorObservation!.snapshotRef);
  assert.deepEqual(await f.receipts.compareCurrentWitness(read.witness), { kind: "matches" });
  await f.frozenPrior();
});

for (const legacy of [false, true]) test(`pending baseline retains owner capture facts, not hash(ref) or extraction time (legacy=${legacy})`, async (t) => {
  const f = await ownerFixture(t, "response", legacy);
  const expected = await f.capture(f.initialRef);
  let observed: Capture | undefined;
  const sentinel = new Error("test-stops-after-baseline-observation");
  t.mock.method(FieldworkSourceCheckReceiptStore.prototype, "begin", async (_id: string, baseline: Baseline) => {
    observed = structuredClone(baseline.admittedAcquisition);
    throw sentinel; // No pretend storage success or fabricated pending token.
  });
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { check: f.check } }));
  assert.deepEqual(observed, expected);
  assert.notEqual(expected.fetchedAt, f.stored.envelope.result.extractedAt);
  assert.equal(Object.hasOwn(expected, "snapshotDigest"), !legacy);
});

test("receipt uses actual checkedAt and authentic prior/current facts on first same-hash recheck", async (t) => {
  const f = await ownerFixture(t);
  let actual!: CheckResult;
  let published: Omit<Receipt, "version" | "sourceId" | "generation"> | undefined;
  const finalize = FieldworkSourceCheckReceiptStore.prototype.finalize;
  t.mock.method(FieldworkSourceCheckReceiptStore.prototype, "finalize", async function (this: FieldworkSourceCheckReceiptStore, ...args: Parameters<typeof finalize>) {
    published = structuredClone(args[1]);
    return finalize.apply(this, args);
  });
  await recheckFieldwork({ ...f.options, acquisition: { async check() { return actual = await f.check(); } } });
  assert.ok(published);
  assert.equal(published.checkedAt, actual.checkedAt);
  assert.deepEqual(published.priorCapture, await f.capture(f.initialRef));
  assert.deepEqual(published.currentCapture, await f.capture(currentRef(actual)));
  const receipt = await available(f);
  assert.equal(receipt.checkedAt, actual.checkedAt);
  assert.deepEqual(receipt.priorCapture, await f.capture(f.initialRef));
  assert.deepEqual(receipt.currentCapture, await f.capture(currentRef(actual)));
});

test("the second 304 continues acquisition B without demanding a new proposal head after the first same-hash capture", async (t) => {
  const f = await ownerFixture(t);
  const same = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(same.classification, "unchanged-source");
  assert.equal(same.check.kind, "unchanged-hash");
  f.setMode("304");
  const revalidated = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(revalidated.classification, "unchanged-source");
  assert.equal(revalidated.check.kind, "unchanged-304");
  assert.equal(revalidated.priorObservation.observationId, same.priorObservation.observationId);
  assert.equal(f.runtime.requests.length, 1);
  await f.frozenPrior();
});

for (const existing of [false, true]) test(`task drift is preflight-only with zero writes and only a real prior observation (existing=${existing})`, async (t) => {
  const f = await ownerFixture(t);
  const prior = existing ? await f.establishProposal() : null;
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  task.spec.traverse.version = "2";
  const drifted = join(f.root, "task-drift.json");
  await writeFile(drifted, JSON.stringify(task));
  const before = await files(f.root);
  let acquisitions = 0;
  const result = v2(await recheckFieldwork({ ...f.options, taskPath: drifted, acquisition: {
    async check() { ++acquisitions; return f.check(); },
  } }));
  assert.equal(acquisitions, 0, "task drift must be decided before acquisition");
  assert.deepEqual(await files(f.root), before, "preflight must not create proposal heads, pending pointers, receipts or runs");
  assert.equal(result.apiVersion, "fieldwork.kontourai.io/v2");
  assert.deepEqual(result.acquisition, { kind: "not-run", reason: "task-drift" });
  assert.equal(result.check, null);
  assert.equal(result.classification, "task-drift");
  assert.equal(result.priorObservation?.observationId ?? null, prior?.observationId ?? null);
  assert.equal(result.currentObservation, null);
  assert.equal(result.run, null);
  assert.equal(f.runtime.requests.length, 1);
  await f.frozenPrior();
});

test("a throwing acquisition reports failed/null, with no invented check, diagnostics, provider work or currentness", async (t) => {
  const f = await ownerFixture(t);
  const result = v2(await recheckFieldwork({ ...f.options, acquisition: { async check() { throw new Error("/private-canary/transport"); } } }));
  assert.equal(result.apiVersion, "fieldwork.kontourai.io/v2");
  assert.deepEqual(result.acquisition, { kind: "failed" });
  assert.equal(result.check, null);
  assert.equal(result.classification, "source-unavailable");
  assert.equal(result.providerSkipped, true);
  assert.equal(f.runtime.requests.length, 1);
  assert.notEqual((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "available");
  assert.doesNotMatch(JSON.stringify(result), /private-canary/);
  await f.frozenPrior();
});

test("an actual owner error remains a failed acquisition, not a fabricated successful capture", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("error");
  let actual!: CheckResult;
  const result = v2(await recheckFieldwork({ ...f.options, acquisition: { async check() { return actual = await f.check(); } } }));
  assert.equal(actual.kind, "error");
  assert.equal(result.apiVersion, "fieldwork.kontourai.io/v2");
  assert.deepEqual(result.acquisition, { kind: "failed" });
  assert.deepEqual(result.check, actual);
  assert.equal(result.classification, "source-unavailable");
  assert.equal(result.currentObservation, null);
  assert.equal(f.runtime.requests.length, 1);
  assert.notEqual((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "available");
  await f.frozenPrior();
});

test("an external acquisition advance while the check result is deferred cannot publish currentness", async (t) => {
  const f = await ownerFixture(t);
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() {
    const requested = await f.check();
    // A distinct public acquisition writer advances B to C before the older
    // request is delivered. P is unchanged, so checking only P misses this.
    const external = await f.check();
    assert.notEqual(currentRef(requested), currentRef(external));
    return requested;
  } } }), (error) => recoveryFailure(error, "RECHECK_CONFLICT"));
  assert.notEqual((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "available");
  await f.frozenPrior();
});

test("an external proposal advance during acquisition cannot be relabelled unchanged-success", async (t) => {
  const f = await ownerFixture(t);
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() {
    const actual = await f.check();
    assert.equal(actual.kind, "unchanged-hash");
    const old = await f.observations.loadLatest(f.source.id);
    assert.ok(old.ok && old.value);
    const committed = await f.observations.commit({ observation: {
      sourceId: f.source.id, snapshotRef: currentRef(actual), observedAt: actual.checkedAt,
      proposals: old.value.proposals,
    }, recordedAt: actual.checkedAt, check: { checkedAt: actual.checkedAt, resultKind: actual.kind, currentSnapshotRef: currentRef(actual) } }, old.value.observationId);
    assert.ok(committed.ok);
    return actual;
  } } }), (error) => recoveryFailure(error, "RECHECK_CONFLICT"));
  assert.notEqual((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "available");
  await f.frozenPrior();
});

test("a newer pending generation fences an older public completion even when proposal P is unchanged", async (t) => {
  const f = await ownerFixture(t);
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { async check() {
    const actual = await f.check();
    const head = await f.readHead();
    assert.ok(head);
    await f.receipts.begin(f.source.id, { pointerToken: await f.receipts.currentPointerToken(f.source.id),
      proposalHeadId: head, admittedAcquisition: await f.capture(f.initialRef) }, f.readHead);
    return actual;
  } } }), (error) => recoveryFailure(error, "RECHECK_CONFLICT"));
  assert.equal((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "pending");
  await f.frozenPrior();
});

test("a typed finalize refusal cannot escape as semantic-success or currentness", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("changed");
  let finalized = 0;
  t.mock.method(FieldworkSourceCheckReceiptStore.prototype, "finalize", async () => { ++finalized; return { kind: "corrupt" }; });
  await assert.rejects(recheckFieldwork({ ...f.options, acquisition: { check: f.check } }), recoveryFailure);
  assert.ok(finalized > 0);
  assert.notEqual((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "available");
  await f.frozenPrior();
});

test("changed receipt publication observes an already-persisted usable semantic Survey round", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("changed");
  const finalize = FieldworkSourceCheckReceiptStore.prototype.finalize;
  let sawSemanticRound = false;
  t.mock.method(FieldworkSourceCheckReceiptStore.prototype, "finalize", async function (this: FieldworkSourceCheckReceiptStore, ...args: Parameters<typeof finalize>) {
    if (args[1].outcome === "changed") {
      const runs = (await readdir(f.runRoot)).filter((name) => name.startsWith("run-") && join(f.runRoot, name) !== f.prior.runDirectory);
      assert.equal(runs.length, 1);
      const current = await readRun(join(f.runRoot, runs[0]!));
      sawSemanticRound = current.run.review.snapshot.items.length > 0 && current.run.review.snapshot.items.every((item) =>
        Boolean(item.metadata.producer?.["lookout.kontourai.io/semantic-transition"]));
    }
    return finalize.apply(this, args);
  });
  const result = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  assert.equal(result.classification, "semantic-drift");
  assert.equal(sawSemanticRound, true, "do not publish a current changed receipt before saveReview succeeds");
  await f.frozenPrior();
});

test("a real Survey-round persistence failure withholds currentness even after a proposal-head partial commit", async (t) => {
  const f = await ownerFixture(t);
  // Prepare the identical future run in an independent Forage store. It is
  // reusable, but its directory is read-only for the semantic-round write.
  // The real source store still has A; the actual recheck will acquire D.
  const preparedRoot = join(f.root, "prepared-snapshots");
  const preparedStore = createFilesystemSnapshotStore({ root: preparedRoot });
  const acquired = await fetchSource({ id: f.source.id, url: f.source.url, respectRobots: false, retries: 0, minDelayMs: 0, egress: { guarded: true } }, {
    clock: () => fetchedAt(2), fetch: async () => new Response("Status: Pending", {
      headers: { "content-type": "text/plain; charset=utf-8", etag: '"v2"' },
    }),
  });
  assert.ok(acquired.snapshot);
  await preparedStore.put(acquired.snapshot);
  const ref = buildSnapshotSourceRef(acquired.snapshot);
  const future = await runFieldwork({ taskPath, snapshotRef: ref, snapshotRoot: preparedRoot, root: f.runRoot, runtime: f.binding });
  await chmod(future.runDirectory, 0o555);
  t.after(() => chmod(future.runDirectory, 0o755).catch(() => {}));
  f.setMode("changed");
  let actual!: CheckResult;
  let caught: unknown;
  try { await recheckFieldwork({ ...f.options, acquisition: { async check() { return actual = await f.check(); } } }); }
  catch (error) { caught = error; }
  await chmod(future.runDirectory, 0o755);
  assert.equal(currentRef(actual), ref, "fault must target the real current run, not an unused directory");
  assert.ok(caught, "a failed round must not return semantic-success");
  assert.notEqual((await f.receipts.readCurrent(f.source.id, f.readHead)).kind, "available",
    "partial Lookout/run artifacts may remain for recovery, but are not a currentness receipt");
  recoveryFailure(caught);
  await f.frozenPrior();
});

for (const phase of ["initial-read", "acquisition-await"] as const) test(`public recheck captures invocation identities and acquisition capability before ${phase}`, async (t) => {
  const f = await ownerFixture(t);
  let originalCalls = 0, replacementCalls = 0;
  let entered!: () => void, release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  let actual!: CheckResult;
  const acquisition = { async check() {
    ++originalCalls;
    actual = await f.check();
    entered();
    if (phase === "acquisition-await") await deferred;
    return actual;
  } };
  const options = { ...f.options, source: structuredClone(f.source), acquisition };
  const pending = recheckFieldwork(options);
  if (phase === "acquisition-await") await begun;
  options.source.id = "substituted-source";
  options.source.url = "https://example.invalid/substituted";
  options.taskPath = join(f.root, "private-canary-task");
  options.priorRunDirectory = join(f.root, "substituted-prior");
  options.root = join(f.root, "substituted-runs");
  options.snapshotRoot = join(f.root, "substituted-snapshots");
  options.observationRoot = join(f.root, "substituted-observations");
  options.receiptRoot = join(f.root, "substituted-receipts");
  acquisition.check = async () => { ++replacementCalls; throw new Error("private-canary-capability"); };
  release();
  const result = await pending;
  assert.equal(result.classification, "unchanged-source");
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.equal(result.check.sourceId, f.source.id);
  const receipt = await available(f);
  assert.equal(receipt.sourceId, f.source.id);
  assert.equal(receipt.currentCapture.snapshotRef, currentRef(actual));
  assert.equal((await readdir(f.root)).some((name) => name.startsWith("substituted-")), false);
  await f.frozenPrior();
});
