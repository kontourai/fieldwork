import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReviewedExtractionSourceState } from "@kontourai/surface";
import { createFieldworkApplication, recheckFieldwork } from "../src/index.js";
import { parseReviewedWebSourceCurrentness } from "../src/reviewed-web-source-contract.js";
import { files, ownerFixture } from "./helpers/recheck-owner-fixture.js";

const opaque = `fieldwork-reviewed-source:v1:${"0".repeat(64)}`;

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
    const filesBeforeFacade = await files(f.root);
    const result = await app.readReviewedWebSourceCurrentness(exactRef);
    assert.equal(f.requests.length, requestsBeforeFacade, "the facade must never acquire from the HTTP owner");
    assert.deepEqual(await files(f.root), filesBeforeFacade, "the facade must not write, recover, or repair any owner store");
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
  assert.deepEqual(visits.map(({ mode, checkKind, surface }) => [mode, checkKind, surface]), [
    ["same", "unchanged-hash", "current"], ["304", "unchanged-304", "current"],
    ["same", "unchanged-hash", "current"], ["changed", "changed", "drifted"],
  ]);
});

test("currentness fences a pointer ABA and an appended historical review after asynchronous authorization", async (t) => {
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
  // refuses an old descriptor when its accepted review record changes while a
  // borrowed authorization is in flight.
  let reviewAuthorizations = 0;
  const reviewApp = createFieldworkApplication({ reviewedWebSourceOwner: {
    runDirectory: f.prior.runDirectory, snapshotRoot: f.snapshotRoot, authorize: () => true,
    sourceChecks: {
      receiptRoot: f.receiptRoot, observationRoot: f.observationRoot,
      authorizeCurrentness: () => {
        if (++reviewAuthorizations === 2) return readFile(join(f.prior.runDirectory, "run.json"), "utf8").then(async (text) => {
          const changed = JSON.parse(text);
          changed.review.revision += 1;
          await writeFile(join(f.prior.runDirectory, "run.json"), `${JSON.stringify(changed, null, 2)}\n`);
          return { isCurrent: () => true };
        });
        return { isCurrent: () => true };
      },
    },
  } });
  assert.deepEqual(await reviewApp.readReviewedWebSourceCurrentness(refs.refs[0]!), {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "missing",
  });
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
