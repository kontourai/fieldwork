import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFilesystemSnapshotStore,
  type Snapshot,
} from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  buildSemanticReviewWork,
  type CheckResult,
  type LookoutSource,
  type ProposalSetObservation,
} from "@kontourai/lookout";
import { runFieldwork } from "../src/fieldwork.js";
import { recheckFieldwork } from "../src/recheck.js";
import { readRun } from "../src/run-store.js";

const fixture = resolve("examples/generic");
const source: LookoutSource = {
  id: "generic-record-source",
  url: "https://example.invalid/generic-record",
  kind: "web-page",
  cadenceHint: "manual",
  renderPolicy: "never",
  targetSchema: [{ path: "record.status", type: "string", inferenceType: "explicit" }],
};

test("unchanged source skips extraction and preserves the prior review truth", async () => {
  const setup = await baseline("Status: Active");
  const before = await readFile(join(setup.prior.runDirectory, "run.json"), "utf8");
  let checks = 0;
  const result = await recheckFieldwork({
    ...setup.options,
    acquisition: {
      async check() {
        checks += 1;
        return check("unchanged-304", setup.priorRef, setup.priorRef);
      },
    },
  });

  assert.equal(checks, 1);
  assert.equal(result.classification, "unchanged-source");
  assert.equal(result.providerSkipped, true);
  assert.equal(result.run, null);
  assert.equal(result.currentObservation, null);
  assert.equal(await readFile(join(setup.prior.runDirectory, "run.json"), "utf8"), before);
});

test("cosmetic source change with byte-identical proposals creates no semantic review work", async () => {
  const setup = await baseline("Status: Active");
  const current = snapshot("capture-current", "Status: Active\nCosmetic footer", "2026-07-23T11:00:00.000Z");
  await setup.store.put(current);

  const result = await recheckFieldwork({
    ...setup.options,
    acquisition: { check: async () => check("changed", setup.priorRef, buildSnapshotSourceRef(current)) },
  });

  assert.equal(result.classification, "stable-proposals");
  assert.equal(result.providerSkipped, false);
  assert.equal(result.review.itemCount, 0);
  assert.ok(result.run);
  const stored = await readRun(result.run.runDirectory);
  assert.equal(stored.run.review.snapshot.items.length, 0);
  assert.equal(stored.run.review.events.length, 0);
});

test("changed, moved, and removed evidence route deterministic old/new observations into Survey review", async () => {
  for (const scenario of [
    { name: "changed", body: "Status: Pending", expected: "proposal-value-changed" },
    { name: "moved", body: "Heading\nStatus: Active", expected: "proposal-moved" },
    { name: "removed", body: "No status is present", expected: "proposal-removed" },
  ]) {
    const setup = await baseline("Status: Active");
    const current = snapshot(`capture-${scenario.name}`, scenario.body, "2026-07-23T12:00:00.000Z");
    await setup.store.put(current);
    const result = await recheckFieldwork({
      ...setup.options,
      acquisition: { check: async () => check("changed", setup.priorRef, buildSnapshotSourceRef(current)) },
    });

    assert.equal(result.classification, "semantic-drift", scenario.name);
    assert.ok(result.review.itemCount >= 1, scenario.name);
    assert.equal(result.review.items[0]?.metadata?.producer?.["lookout.kontourai.io/semantic-transition"]?.semanticKind, scenario.expected);
    assert.match(result.priorObservation.proposals[0]!.provenance.locator, /^chars:/);
    assert.ok(result.currentObservation);
    assert.doesNotMatch(JSON.stringify({
      prior: result.priorObservation,
      current: result.currentObservation,
      review: result.review,
    }), /\/Users\/|\.kontourai\/|api[_-]?key/i);
    const stored = await readRun(result.run!.runDirectory);
    assert.equal(stored.run.review.snapshot.items.length, result.review.itemCount);
    assert.equal(stored.run.review.events.length, 0);
  }
});

test("unavailable source and task drift do not call a provider or mutate the prior run", async () => {
  const unavailable = await baseline("Status: Active");
  const before = await readFile(join(unavailable.prior.runDirectory, "run.json"), "utf8");
  const unavailableResult = await recheckFieldwork({
    ...unavailable.options,
    acquisition: {
      check: async () => ({
        sourceId: source.id,
        sourceUrl: source.url,
        checkedAt: "2026-07-23T13:00:00.000Z",
        warnings: [],
        kind: "error",
        origin: "lookout",
        error: { kind: "unexpected", message: "redacted" },
      }),
    },
  });
  assert.equal(unavailableResult.classification, "source-unavailable");
  assert.equal(unavailableResult.providerSkipped, true);
  assert.equal(await readFile(join(unavailable.prior.runDirectory, "run.json"), "utf8"), before);

  const driftedTaskPath = join(unavailable.root, "task-drift.json");
  const driftedTask = JSON.parse(await readFile(join(fixture, "task.json"), "utf8"));
  driftedTask.spec.traverse.version = "2";
  await writeFile(driftedTaskPath, `${JSON.stringify(driftedTask)}\n`, "utf8");
  const taskResult = await recheckFieldwork({
    ...unavailable.options,
    taskPath: driftedTaskPath,
    acquisition: { check: async () => check("unchanged-304", unavailable.priorRef, unavailable.priorRef) },
  });
  assert.equal(taskResult.classification, "task-drift");
  assert.equal(taskResult.providerSkipped, true);
});

test("preparation drift is distinct from semantic source drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-recheck-preparation-"));
  const snapshotRoot = join(root, "snapshots");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const pdf = snapshot("capture-pdf", "%PDF fixture", "2026-07-23T13:30:00.000Z", "application/pdf");
  pdf.body = new TextEncoder().encode("%PDF fixture");
  await store.put(pdf);
  const snapshotRef = buildSnapshotSourceRef(pdf);
  const prior = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    snapshotRef,
    snapshotRoot,
    root: join(root, "prior-runs"),
    sourceAdapters: {
      pdf: { id: "fixture-pdf-prior", extract: { extract: () => ({ text: "Status: Active" }) } },
    },
  });
  const result = await recheckFieldwork({
    source,
    priorRunDirectory: prior.runDirectory,
    taskPath: join(fixture, "task.json"),
    root: join(root, "current-runs"),
    observationRoot: join(root, "observations"),
    snapshotRoot,
    sourceAdapters: {
      pdf: { id: "fixture-pdf-current", extract: { extract: () => ({ text: "Status: Pending" }) } },
    },
    acquisition: { check: async () => check("changed", snapshotRef, snapshotRef) },
  });
  assert.equal(result.classification, "preparation-drift");
  assert.equal(result.review.itemCount, 1);
  assert.ok(result.currentObservation);
});

test("a false changed result cannot erase the selected prior review round", async () => {
  const setup = await baseline("Status: Active");
  const before = await readFile(join(setup.prior.runDirectory, "run.json"), "utf8");
  await assert.rejects(
    () => recheckFieldwork({
      ...setup.options,
      acquisition: { check: async () => check("changed", setup.priorRef, setup.priorRef) },
    }),
    (error: unknown) => (error as { code?: string }).code === "RECHECK_CONFLICT",
  );
  assert.equal(await readFile(join(setup.prior.runDirectory, "run.json"), "utf8"), before);
});

test("concurrent changed observations allow only one continuity winner", async () => {
  const setup = await baseline("Status: Active");
  const left = snapshot("capture-left", "Status: Pending", "2026-07-23T14:00:00.000Z");
  const right = snapshot("capture-right", "Status: Closed", "2026-07-23T14:00:01.000Z");
  await Promise.all([setup.store.put(left), setup.store.put(right)]);

  const attempts = await Promise.allSettled([left, right].map((current) => recheckFieldwork({
    ...setup.options,
    acquisition: { check: async () => check("changed", setup.priorRef, buildSnapshotSourceRef(current)) },
  })));
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = attempts.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  assert.equal((rejected?.reason as { code?: string }).code, "RECHECK_CONFLICT");
});

test("replaying the same observation pair produces byte-identical semantic items", async () => {
  const result = await semanticPair();
  const prior = result.priorObservation as ProposalSetObservation;
  const current = result.currentObservation as ProposalSetObservation;
  const input = {
    prior,
    current,
    observationIdentity: {
      prior: result.priorObservation.observationId,
      current: result.currentObservation!.observationId,
    },
    selectEntities: (observation: ProposalSetObservation) => [observation],
    entityIdentity: (observation: ProposalSetObservation) => observation.sourceId,
    proposalsFor: (observation: ProposalSetObservation) => observation.proposals,
    fieldIdentity: (_observation: ProposalSetObservation, proposal: ProposalSetObservation["proposals"][number]) => proposal.fieldPath,
    claimTarget: (change: { fieldPath: string }) => ({
      subjectType: "record",
      subjectId: "generic-1",
      facet: "review",
      claimType: "field",
      impactLevel: "medium" as const,
      fieldOrBehavior: change.fieldPath,
    }),
  };
  const first = buildSemanticReviewWork(input);
  const second = buildSemanticReviewWork(input);
  assert.deepEqual(first, second);
  assert.equal(first.ok && JSON.stringify(first.value.items), JSON.stringify(result.review.items));
});

async function semanticPair() {
  const setup = await baseline("Status: Active");
  const current = snapshot("capture-replay", "Status: Pending", "2026-07-23T15:00:00.000Z");
  await setup.store.put(current);
  return recheckFieldwork({
    ...setup.options,
    now: () => "2026-07-23T15:01:00.000Z",
    acquisition: { check: async () => check("changed", setup.priorRef, buildSnapshotSourceRef(current)) },
  });
}

async function baseline(body: string) {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-recheck-"));
  const snapshotRoot = join(root, "snapshots");
  const runRoot = join(root, "runs");
  const observationRoot = join(root, "observations");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const priorSnapshot = snapshot("capture-prior", body, "2026-07-23T10:00:00.000Z");
  await store.put(priorSnapshot);
  const priorRef = buildSnapshotSourceRef(priorSnapshot);
  const prior = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    snapshotRef: priorRef,
    snapshotRoot,
    root: runRoot,
  });
  return {
    root,
    store,
    prior,
    priorRef,
    options: {
      source,
      priorRunDirectory: prior.runDirectory,
      taskPath: join(fixture, "task.json"),
      root: runRoot,
      observationRoot,
      snapshotRoot,
      now: () => "2026-07-23T10:01:00.000Z",
    },
  };
}

function check(
  kind: "changed" | "unchanged-304",
  priorSnapshotRef: string,
  currentSnapshotRef: string,
): CheckResult {
  const common = {
    sourceId: source.id,
    sourceUrl: source.url,
    checkedAt: "2026-07-23T11:00:00.000Z",
    warnings: [],
  };
  return kind === "changed"
    ? { ...common, kind, priorSnapshotRef, currentSnapshotRef, changeBasis: "hash" }
    : { ...common, kind, snapshotRef: currentSnapshotRef };
}

function snapshot(sourceId: string, body: string, fetchedAt: string, contentType = "text/plain; charset=utf-8"): Snapshot {
  return {
    sourceId,
    url: source.url,
    status: 200,
    fetchedAt,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": contentType },
  };
}
