import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReviewedExtractionSourceState } from "@kontourai/surface";
import { createFieldworkApplication, recheckFieldwork } from "../src/index.js";
import { parseReviewedWebSourceCurrentness } from "../src/reviewed-web-source-contract.js";
import { ownerFixture } from "./helpers/recheck-owner-fixture.js";

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
