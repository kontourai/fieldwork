import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReviewedExtractionSourceState } from "@kontourai/surface";
import { buildReviewSessionEvent, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { createFieldworkApplication, openRun, recheckFieldwork } from "../src/index.js";
import { parseReviewedWebSourceCurrentness } from "../src/reviewed-web-source-contract.js";
import { testOnlyHeadWitnessIo } from "../node_modules/@kontourai/forage/dist/src/snapshot-store.js";
import { apiFetch } from "./helpers.js";
import { files, ownerFixture } from "./helpers/recheck-owner-fixture.js";

const opaque = `fieldwork-reviewed-source:v1:${"0".repeat(64)}`;

type NativeCounters = {
  readonly forageHeadComparisons: number;
  readonly forageVerifiedHeadReads: number;
  readonly lookoutHeadComparisons: number;
  readonly snapshotBodyReads: number;
  readonly preparedBodyReads: number;
  readonly proposalBodyReads: number;
  readonly writes: number;
};

/**
 * Observe the published native filesystem owners in place. These wrappers call
 * through to the real Node operations, so the facade still creates and uses
 * its production Forage/Lookout readers. `beforeFinalMetadataFence` is the
 * only internal Forage test seam: one invocation is one compareHeadWitness;
 * verified-record reads are the native readVerifiedHead-only path.
 */
async function countNativeCurrentness<T>(roots: { root: string; snapshotRoot: string; observationRoot: string }, action: () => Promise<T>): Promise<{ result: T; counters: NativeCounters }> {
  const require = createRequire(import.meta.url);
  const native = require("node:fs/promises") as Record<string, (...args: any[]) => any>;
  const names = ["open", "readFile", "writeFile", "appendFile", "mkdir", "rename", "link", "unlink", "rm", "copyFile", "realpath"] as const;
  const original = Object.fromEntries(names.map((name) => [name, native[name]])) as Record<typeof names[number], (...args: any[]) => any>;
  let forageHeadComparisons = 0;
  let forageVerifiedHeadReads = 0;
  let lookoutHeadComparisons = 0;
  let snapshotBodyReads = 0;
  let preparedBodyReads = 0;
  let proposalBodyReads = 0;
  let writes = 0;
  const pathOf = (value: unknown) => typeof value === "string" ? value : "";
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const observeRead = (path: string) => {
    if (path.endsWith("/prepared.txt")) ++preparedBodyReads;
    if (under(path, roots.snapshotRoot) && path.endsWith(".json")) ++snapshotBodyReads;
    if (under(path, roots.observationRoot) && /\/[a-f0-9]{64}\.json$/.test(path)) ++proposalBodyReads;
  };
  const observeWrite = (args: unknown[]) => {
    if (args.some((value) => under(pathOf(value), roots.root))) ++writes;
  };
  try {
    native.open = (...args: any[]) => { observeRead(pathOf(args[0])); if (typeof args[1] === "string" ? /[wa+]/.test(args[1]) : typeof args[1] === "number" && (args[1] & 3) !== 0) observeWrite(args); return original.open(...args); };
    native.readFile = (...args: any[]) => { observeRead(pathOf(args[0])); return original.readFile(...args); };
    for (const name of ["writeFile", "appendFile", "mkdir", "rename", "link", "unlink", "rm", "copyFile"] as const) native[name] = (...args: any[]) => { observeWrite(args); return original[name](...args); };
    native.realpath = (...args: any[]) => { if (pathOf(args[0]) === roots.observationRoot) ++lookoutHeadComparisons; return original.realpath(...args); };
    syncBuiltinESMExports();
    testOnlyHeadWitnessIo.beforeFinalMetadataFence = () => { ++forageHeadComparisons; };
    testOnlyHeadWitnessIo.onVerifiedRecordRead = () => { ++forageVerifiedHeadReads; };
    const result = await action();
    return { result, counters: { forageHeadComparisons, forageVerifiedHeadReads, lookoutHeadComparisons, snapshotBodyReads, preparedBodyReads, proposalBodyReads, writes } };
  } finally {
    for (const name of names) native[name] = original[name];
    syncBuiltinESMExports();
    testOnlyHeadWitnessIo.beforeFinalMetadataFence = undefined;
    testOnlyHeadWitnessIo.onVerifiedRecordRead = undefined;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function currentnessDto(sourceObservation: unknown) {
  return {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "available",
    exactRef: opaque, evidenceId: "evidence", reviewRevision: 0, checkedAt: "2026-08-26T12:00:00.000Z",
    observationRef: "observation", scope: "local-owner-heads-as-of", captureIntegrity: "not-rechecked",
    sourceObservation,
  };
}

async function appendValidSurveyReviewEvent(runDirectory: string): Promise<void> {
  const service = await openRun(runDirectory, { port: 0 });
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as { run: { revision: number }; review: { snapshot: unknown; events: any[] } };
    const snapshot = view.review.snapshot as ReviewQueueSessionState;
    const item = snapshot.items[0]!;
    const candidate = item.spec.candidates.find((entry) => entry.role === "proposed")!;
    const event = buildReviewSessionEvent({ ...snapshot, actorId: "concurrent-reviewer", reviewedAt: "2026-08-26T12:00:01.000Z" }, {
      sessionName: "review-workbench-session", sequence: view.review.events.length + 1,
      eventType: "decision-changed", occurredAt: "2026-08-26T12:00:01.000Z",
      reviewItemName: item.metadata.name, reviewDecisionName: `${item.metadata.name}-reject-proposed`,
      candidateId: candidate.id, status: "rejected", data: { workbenchDecision: "reject-proposed" },
    });
    const mutation = await apiFetch(service, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [...view.review.events, event], expectedEventCount: view.review.events.length, expectedRevision: view.run.revision }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(mutation.ok, true, "the concurrent review change must be a valid Survey append");
  } finally { await service.close(); }
}

test("currentness is unavailable without the separately configured owner capability", async () => {
  const app = createFieldworkApplication();
  assert.deepEqual(await app.readReviewedWebSourceCurrentness(opaque), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "unsupported",
  });
  const poisoned = { toString: () => { throw new Error("exact-ref coercion must not run"); } };
  assert.deepEqual(await app.readReviewedWebSourceCurrentness(poisoned as unknown as string), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "unsupported",
  });
});

test("the public currentness codec holds every advertised JSON boundary exactly", () => {
  const parse = (sourceObservation: unknown) => parseReviewedWebSourceCurrentness(currentnessDto(sourceObservation));
  assert.equal((parse("x".repeat(8_192)) as any).status, "available");
  assert.throws(() => parse("x".repeat(8_193)), /bounded JSON/);

  const atDepth = (depth: number): unknown => Array.from({ length: depth }, () => undefined).reduce<unknown>((value) => [value], null);
  assert.equal((parse(atDepth(8)) as any).status, "available");
  assert.throws(() => parse(atDepth(9)), /bounded JSON/);

  assert.equal((parse(Array.from({ length: 255 }, () => null)) as any).status, "available"); // array + 255 values = 256 nodes
  assert.throws(() => parse(Array.from({ length: 256 }, () => null)), /bounded JSON/);

  const fixed = Array.from({ length: 7 }, () => "x".repeat(8_192));
  const baseBytes = new TextEncoder().encode(JSON.stringify(currentnessDto([...fixed, ""]))).byteLength;
  const finalLength = 64 * 1024 - baseBytes;
  assert.ok(finalLength >= 0 && finalLength <= 8_192, "the exact 64KiB fixture must stay inside the per-string cap");
  const exact = [...fixed, "x".repeat(finalLength)];
  assert.equal(new TextEncoder().encode(JSON.stringify(currentnessDto(exact))).byteLength, 64 * 1024);
  assert.equal((parse(exact) as any).status, "available");
  assert.throws(() => parse([...fixed, "x".repeat(finalLength + 1)]), /64KiB/);
});

test("owner-head currentness projects old reviewed evidence through Surface without reading source bodies", async (t) => {
  const f = await ownerFixture(t);
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  let initialCurrent = true;
  let finalCurrent = true;
  let authorizations = 0;
  const app = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
      authorizeCurrentness: () => { ++authorizations; return { isCurrent: () => initialCurrent && finalCurrent }; },
    },
  } });
  const refs = await app.listReviewedWebSourceRefs();
  assert.equal(refs.status, "available");
  assert.ok(refs.status === "available");
  const result = await app.readReviewedWebSourceCurrentness(refs.refs[0]!);
  assert.equal(result.status, "available");
  assert.ok(result.status === "available");
  assert.deepEqual(parseReviewedWebSourceCurrentness(result), result);
  assert.equal("current" in result, false, "Fieldwork must not duplicate Surface's current/drift status");
  const descriptor = await app.describeReviewedWebSource(refs.refs[0]!);
  assert.equal(descriptor.status, "available");
  assert.ok(descriptor.status === "available");
  const exported = await app.reviewedOutput(f.prior.runDirectory) as { evidence: any[] };
  const evidence = exported.evidence.find((entry) => entry.id === result.evidenceId);
  assert.ok(evidence);
  assert.equal(buildReviewedExtractionSourceState(evidence, result.sourceObservation as any, result.checkedAt).status, "current");
  assert.equal(authorizations, 2, "metadata and final publication receive distinct borrowed leases");

  f.setMode("changed");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const drifted = await app.readReviewedWebSourceCurrentness(refs.refs[0]!);
  assert.equal(drifted.status, "available");
  assert.ok(drifted.status === "available");
  assert.equal(buildReviewedExtractionSourceState(evidence, drifted.sourceObservation as any, drifted.checkedAt).status, "drifted");

  finalCurrent = false;
  const revoked = await app.readReviewedWebSourceCurrentness(refs.refs[0]!);
  assert.deepEqual(revoked, { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "restricted" });
  initialCurrent = false;
});

test("substituted source, opaque ref, lease token, store, and moved URL remain closed", async (t) => {
  const f = await ownerFixture(t, "http");
  const other = await ownerFixture(t, "http");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  await recheckFieldwork({ ...other.options, acquisition: { check: other.check } });
  const owner = (sourceChecks: { receiptRoot: string; observationRoot: string; authorizeCurrentness: (request: { operation: "currentness"; exactRef: string }) => any }) => createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true, sourceChecks,
  } });
  const app = owner({
    receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
    authorizeCurrentness: () => ({ isCurrent: () => true }),
  });
  const refs = await app.listReviewedWebSourceRefs();
  assert.ok(refs.status === "available");
  const expectedRef = refs.refs[0]!;
  assert.notEqual(expectedRef, opaque);
  const refBoundApp = owner({
    receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
    authorizeCurrentness: ({ exactRef }) => ({ isCurrent: () => exactRef === expectedRef }),
  });
  assert.deepEqual(await refBoundApp.readReviewedWebSourceCurrentness(opaque), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "restricted",
  }, "a caller cannot widen the owner-issued opaque ref");

  const tokenApp = owner({
    receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
    authorizeCurrentness: () => ({ isCurrent: () => Promise.resolve(true) as unknown as boolean }),
  });
  assert.deepEqual(await tokenApp.readReviewedWebSourceCurrentness(expectedRef), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "restricted",
  }, "an async or substituted lease assertion is never treated as authorization");

  const substitutedStore = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: other.snapshotRoot, authorize: () => true,
    sourceChecks: { receiptRoot: other.receiptRoot, observationRoot: other.observationRoot, authorizeCurrentness: () => ({ isCurrent: () => true }) },
  } });
  assert.deepEqual(await substitutedStore.readReviewedWebSourceCurrentness(expectedRef), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "incompatible-source",
  }, "a same-id source from another owner URL is unknown, not a widened currentness answer");
});

test("published filesystem owners preserve an accepted A review while HTTP B/304-B/C/D advances as-of currentness", async (t) => {
  // This is deliberately one continuous owner journey.  It uses the published
  // Forage 0.7.0 and Lookout 0.5.2 filesystem owners behind the real guarded
  // HTTP fixture, not a fabricated CheckResult or an in-memory head.
  const f = await ownerFixture(t, "http");
  const acceptedP = await f.establishProposal();
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.dependencies["@kontourai/forage"], "0.7.0");
  assert.equal(manifest.dependencies["@kontourai/lookout"], "0.5.2");
  assert.equal(manifest.dependencies["@kontourai/surface"], "3.1.0");

  let authorizations = 0;
  const app = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory,
    snapshotRoot: f.snapshotRoot,
    authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot,
      observationRoot: f.observationRoot,
      authorizeCurrentness: ({ operation, exactRef }) => {
        assert.equal(operation, "currentness");
        assert.match(exactRef, /^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/);
        ++authorizations;
        return { isCurrent: () => true };
      },
    },
  } });
  const refs = await app.listReviewedWebSourceRefs();
  assert.equal(refs.status, "available");
  assert.ok(refs.status === "available");
  const exactRef = refs.refs[0]!;
  const before = await app.describeReviewedWebSource(exactRef);
  assert.equal(before.status, "available");
  assert.ok(before.status === "available");
  const oldEnvelope = await readFile(join(f.prior.runDirectory, "extraction-envelope.json"), "utf8");
  const exported = await app.reviewedOutput(f.prior.runDirectory) as { evidence: any[] };
  const oldEvidence = exported.evidence.find((entry) => entry.id === before.evidence.id);
  assert.ok(oldEvidence, "the historical Surface evidence is the comparison expectation");

  const visits: Array<{ mode: string; checkKind: string; surface: string; checkedAt: string; capturedAt: string }> = [];
  let bCapturedAt = "";
  for (const [mode, expectedKind, expectedSurface] of [
    ["same", "unchanged-hash", "current"],
    ["304", "unchanged-304", "current"],
    ["same", "unchanged-hash", "current"],
    ["changed", "changed", "drifted"],
  ] as const) {
    f.setMode(mode);
    const recheck = await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
    assert.equal(recheck.check?.kind, expectedKind);
    assert.equal(recheck.priorObservation?.observationId, acceptedP.observationId, "same captures retain accepted P");
    assert.equal(recheck.providerSkipped, mode !== "changed", "only D may run extraction");
    assert.equal(f.runtime.requests.length, mode === "changed" ? 2 : 1, "A is the only unchanged-provider call");
    if (mode === "changed") {
      assert.ok(recheck.currentObservation);
      assert.notEqual(recheck.currentObservation.observationId, acceptedP.observationId, "D commits new Q");
      assert.ok(recheck.run, "changed D creates a new Survey run");
      const newRun = await readFile(join(recheck.run.runDirectory, "run.json"), "utf8");
      assert.match(newRun, /"revision": 0/);
      assert.match(newRun, /"events": \[\]/);
    } else {
      assert.equal(recheck.currentObservation, null);
      assert.equal(recheck.run, null);
    }

    const requestsBeforeFacade = f.requests.length;
    const providerRequestsBeforeFacade = f.runtime.requests.length;
    const filesBeforeFacade = await files(f.root);
    const observed = await countNativeCurrentness(f, () => app.readReviewedWebSourceCurrentness(exactRef));
    const result = observed.result;
    assert.equal(f.requests.length, requestsBeforeFacade, "the facade must never acquire from the HTTP owner");
    assert.equal(f.runtime.requests.length, providerRequestsBeforeFacade, "the facade must never invoke extraction/provider work");
    assert.deepEqual(await files(f.root), filesBeforeFacade, "the facade must not write, recover, or repair any owner store");
    assert.deepEqual(observed.counters, {
      forageHeadComparisons: 2,
      forageVerifiedHeadReads: 0,
      lookoutHeadComparisons: 2,
      snapshotBodyReads: 0,
      preparedBodyReads: 0,
      proposalBodyReads: 0,
      writes: 0,
    }, "the facade only compares owner heads; it never replays bodies, invokes readVerifiedHead, or mutates owner storage");
    assert.equal(result.status, "available");
    assert.ok(result.status === "available");
    assert.equal(result.exactRef, exactRef);
    assert.equal(result.evidenceId, before.evidence.id, "the old accepted E remains selected");
    assert.equal(result.reviewRevision, before.review.revision, "a check never renews the old review");
    assert.equal(result.checkedAt, recheck.check?.checkedAt, "checkedAt is owner-issued, never local now()");
    assert.equal(result.captureIntegrity, "not-rechecked");
    assert.equal("current" in result, false, "Surface, not Fieldwork, derives standing");
    assert.equal(JSON.stringify(result).includes("fieldValueChanged"), false);
    const observation = result.sourceObservation as { observed: { capturedAt: string } };
    if (mode === "same" && !bCapturedAt) bCapturedAt = observation.observed.capturedAt;
    if (mode === "304") assert.equal(observation.observed.capturedAt, bCapturedAt, "304 retains B's capture time");
    assert.equal(buildReviewedExtractionSourceState(oldEvidence, result.sourceObservation as any, result.checkedAt).status, expectedSurface);
    visits.push({ mode, checkKind: expectedKind, surface: expectedSurface, checkedAt: result.checkedAt, capturedAt: observation.observed.capturedAt });

    assert.equal(await readFile(join(f.prior.runDirectory, "run.json"), "utf8"), f.priorBytes, "old run/events/revision stay byte-identical");
    assert.equal(await readFile(join(f.prior.runDirectory, "extraction-envelope.json"), "utf8"), oldEnvelope, "old S/E stay byte-identical");
  }
  assert.deepEqual(f.requests.map((request) => request.status), [200, 200, 304, 200, 200]);
  assert.equal(f.requests[2]?.validator, '"v1"');
  assert.equal(authorizations, 8, "each as-of read borrows initial and final leases");
  assert.deepEqual(visits.map(({ checkedAt }) => checkedAt), [...visits.map(({ checkedAt }) => checkedAt)].sort(), "B, 304-B, C, and D retain their actual advancing owner check times");
  assert.equal(new Set(visits.map(({ checkedAt }) => checkedAt)).size, 4, "each owner result has its own as-of check time");
  assert.equal(visits[1]?.capturedAt, visits[0]?.capturedAt, "304-B retains B's capture time");
  assert.ok(visits[2]!.capturedAt > visits[1]!.capturedAt, "C reports its actual later owner capture");
  assert.ok(visits[3]!.capturedAt > visits[2]!.capturedAt, "D reports its actual later owner capture");
  assert.deepEqual(visits.map(({ mode, checkKind, surface }) => [mode, checkKind, surface]), [
    ["same", "unchanged-hash", "current"], ["304", "unchanged-304", "current"],
    ["same", "unchanged-hash", "current"], ["changed", "changed", "drifted"],
  ]);
});

test("currentness fences a pointer ABA and a legitimate concurrent Survey append", async (t) => {
  const f = await ownerFixture(t, "http");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const sourceDirectory = createHash("sha256").update(f.source.id).digest("hex");
  const pointer = join(f.receiptRoot, sourceDirectory, "pointer.json");
  const pointerBytes = await readFile(pointer);
  let authorizations = 0;
  const pointerApp = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
      authorizeCurrentness: () => {
        if (++authorizations === 2) return writeFile(pointer, pointerBytes).then(() => ({ isCurrent: () => true }));
        return { isCurrent: () => true };
      },
    },
  } });
  const refs = await pointerApp.listReviewedWebSourceRefs();
  assert.equal(refs.status, "available");
  assert.ok(refs.status === "available");
  assert.deepEqual(await pointerApp.readReviewedWebSourceCurrentness(refs.refs[0]!), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "receipt-superseded",
  });

  // The app captured configuration at construction, but the final fence still
  // refuses an old descriptor when a real public Survey append changes the
  // accepted review record while the final borrowed authorization is in flight.
  let reviewAuthorizations = 0;
  const reviewApp = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
      authorizeCurrentness: () => {
        if (++reviewAuthorizations === 2) return appendValidSurveyReviewEvent(f.prior.runDirectory).then(() => ({ isCurrent: () => true }));
        return { isCurrent: () => true };
      },
    },
  } });
  assert.deepEqual(await reviewApp.readReviewedWebSourceCurrentness(refs.refs[0]!), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "missing",
  });
});

test("currentness revokes an initial borrowed lease during native owner comparison and authorization awaits", async (t) => {
  const f = await ownerFixture(t, "http");
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const setup = (authorizeCurrentness: (request: { operation: "currentness"; exactRef: string }) => any) => createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true,
    sourceChecks: { receiptRoot: f.receiptRoot, observationRoot: f.observationRoot, authorizeCurrentness },
  } });
  const listed = await setup(() => ({ isCurrent: () => true })).listReviewedWebSourceRefs();
  assert.ok(listed.status === "available");
  const exactRef = listed.refs[0]!;

  let initialAlive = true;
  let authorizations = 0;
  const comparisonEntered = deferred<void>();
  const comparisonRelease = deferred<void>();
  const oldFence = testOnlyHeadWitnessIo.beforeFinalMetadataFence;
  testOnlyHeadWitnessIo.beforeFinalMetadataFence = async () => {
    if (authorizations === 1) {
      comparisonEntered.resolve();
      await comparisonRelease.promise;
    }
  };
  try {
    const app = setup(() => {
      const initial = ++authorizations === 1;
      return { isCurrent: () => initial ? initialAlive : true };
    });
    const pending = app.readReviewedWebSourceCurrentness(exactRef);
    await comparisonEntered.promise;
    initialAlive = false;
    comparisonRelease.resolve();
    assert.deepEqual(await pending, { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "restricted" });
  } finally { testOnlyHeadWitnessIo.beforeFinalMetadataFence = oldFence; }

  initialAlive = true;
  let calls = 0;
  const authorizationEntered = deferred<void>();
  const authorizationRelease = deferred<{ isCurrent(): boolean }>();
  const authorizationApp = setup(() => {
    if (++calls === 1) return { isCurrent: () => initialAlive };
    authorizationEntered.resolve();
    return authorizationRelease.promise;
  });
  const pendingAuthorization = authorizationApp.readReviewedWebSourceCurrentness(exactRef);
  await authorizationEntered.promise;
  initialAlive = false;
  authorizationRelease.resolve({ isCurrent: () => true });
  assert.deepEqual(await pendingAuthorization, { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "restricted" });
});

test("v1 receipts and historical captures without an envelope digest remain closed currentness results", async (t) => {
  const f = await ownerFixture(t, "http");
  const proposal = await f.establishProposal();
  const capture = await f.capture(f.initialRef);
  const pending = await f.receipts.begin(f.source.id, {
    pointerToken: null,
    proposalHeadId: proposal.observationId,
    admittedAcquisition: capture,
  }, f.readHead);
  const finalized = await f.receipts.finalize(pending, {
    checkedAt: "2026-08-26T12:00:00.000Z",
    outcome: "unchanged-hash",
    priorProposalHeadId: proposal.observationId,
    resultProposalHeadId: proposal.observationId,
    priorCapture: capture,
    currentCapture: capture,
  }, f.readHead);
  assert.equal(finalized.kind, "available");
  const app = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
      authorizeCurrentness: () => ({ isCurrent: () => true }),
    },
  } });
  const refs = await app.listReviewedWebSourceRefs();
  assert.equal(refs.status, "available");
  assert.ok(refs.status === "available");
  assert.deepEqual(await app.readReviewedWebSourceCurrentness(refs.refs[0]!), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "legacy-receipt",
  });

  const legacy = await ownerFixture(t, "http", true);
  const legacyApp = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: legacy.prior.runDirectory, snapshotRoot: legacy.snapshotRoot, authorize: () => true,
    sourceChecks: {
      receiptRoot: legacy.receiptRoot, observationRoot: legacy.observationRoot,
      authorizeCurrentness: () => ({ isCurrent: () => true }),
    },
  } });
  const legacyRefs = await legacyApp.listReviewedWebSourceRefs();
  assert.equal(legacyRefs.status, "available");
  assert.ok(legacyRefs.status === "available");
  assert.deepEqual(await legacyApp.readReviewedWebSourceCurrentness(legacyRefs.refs[0]!), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "missing-digest",
  });
});

test("currentness keeps its construction-time owner roots across authorization awaits", async (t) => {
  const f = await ownerFixture(t);
  await recheckFieldwork({ ...f.options, acquisition: { check: f.check } });
  const redirected = await mkdtemp(join(tmpdir(), "fieldwork-currentness-redirected-"));
  t.after(() => rm(redirected, { recursive: true, force: true }));
  let authorizations = 0;
  const owner = {
    runDirectory: f.prior.runDirectory,
    snapshotRoot: f.snapshotRoot,
    authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot,
      observationRoot: f.observationRoot,
      authorizeCurrentness: () => {
        const phase = ++authorizations === 1 ? "before" : "after";
        owner.runDirectory = join(redirected, `${phase}-runs`);
        owner.snapshotRoot = join(redirected, `${phase}-snapshots`);
        owner.sourceChecks.receiptRoot = join(redirected, `${phase}-receipts`);
        owner.sourceChecks.observationRoot = join(redirected, `${phase}-observations`);
        return { isCurrent: () => true };
      },
    },
  };
  const app = createFieldworkApplication({ reviewedWebSourceOwner: owner });
  const refs = await app.listReviewedWebSourceRefs();
  assert.equal(refs.status, "available");
  assert.ok(refs.status === "available");

  const result = await app.readReviewedWebSourceCurrentness(refs.refs[0]!);
  assert.equal(result.status, "available");
  assert.equal(authorizations, 2, "both authorization awaits mutate owner configuration");
  assert.deepEqual(await readdir(redirected), [], "no currentness I/O may follow mutated owner roots");
});
