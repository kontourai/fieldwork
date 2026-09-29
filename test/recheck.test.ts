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
  createObservationStore,
  type CheckResult,
  type LookoutSource,
  type ProposalSetObservation,
} from "@kontourai/lookout";
import type { ReviewItem } from "@kontourai/survey";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { bindExtraction, canonicalSemanticReviewItems, FIELDWORK_SOURCE_KIND, importNameFor, reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { hashReviewQueueSnapshot as reviewSnapshotHash } from "@kontourai/survey/review-workbench";
import { openRun } from "../src/server.js";
import { apiFetch } from "./helpers.js";
import { recheckAfterPartialPrior } from "./helpers/incomplete-runs.js";
import { recheckFieldwork } from "../src/recheck.js";
import { readRun } from "../src/run-store.js";
import { parseFieldworkTask, traverseTask } from "../src/contracts.js";
import type { FieldworkRuntimeBinding } from "../src/runtime-contracts.js";
import { ModelInvocationError, type ModelRuntime } from "@kontourai/relay";

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
  const result = await recheckFieldwork({
    ...setup.options,
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
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
    const result = await recheckFieldwork({
      ...setup.options,
      acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
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

test("competing acquisition heads have at most one continuity winner", async () => {
  const setup = await baseline("Status: Active");
  const left = snapshot("capture-left", "Status: Pending", "2026-07-23T14:00:00.000Z");
  const right = snapshot("capture-right", "Status: Closed", "2026-07-23T14:00:01.000Z");
  const attempts = await Promise.allSettled([left, right].map((current) => recheckFieldwork({
    ...setup.options,
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
  })));
  assert.ok(attempts.filter((entry) => entry.status === "fulfilled").length <= 1);
  for (const rejected of attempts) {
    if (rejected.status === "rejected") {
      assert.equal((rejected.reason as { code?: string }).code, "RECHECK_CONFLICT");
    }
  }
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
  /* Fieldwork completes Lookout's items with the application-owned provenance a
     trust projection needs (fieldwork#59) before they become the reviewed
     snapshot, so the persisted round is the adapter applied to Lookout's output
     and nothing else — no reordering, no invented item, no changed value. */
  assert.ok(first.ok);
  assert.equal(
    JSON.stringify(canonicalSemanticReviewItems(first.value.items as unknown as ReviewItem[], {
      sourceKind: FIELDWORK_SOURCE_KIND,
      transitionId: result.review.transitionId!,
      prior: { observationId: result.priorObservation.observationId, extractor: prior.proposals[0]!.extractor },
      current: { observationId: result.currentObservation!.observationId, extractor: current.proposals[0]!.extractor },
    })),
    JSON.stringify(result.review.items),
  );
});

/* fieldwork#59: a recheck round could be reviewed but never exported, because
   reviewedExport rebuilt its items from a fresh envelope import (every proposal
   in the new source) while the results came from the round (the fields that
   moved). The export is a receipt of the run's own review authority — the round
   — so these drive a real round through the loopback API and read the artifact,
   not the exit status. */
test("a decided recheck round exports as a receipt of that round", async () => {
  const result = await semanticPair();
  const runDirectory = result.run!.runDirectory;
  const stored = await readRun(runDirectory);
  assert.equal(stored.envelope.result.proposals.length, 1);
  assert.equal(stored.run.review.snapshot.items.length, result.review.itemCount);
  // A recheck round's items are Lookout's transitions, not the import's, so
  // it carries no import to check them against and is not flagged unverified.
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    assert.equal(view.review.extractionImport, undefined);
    assert.deepEqual((view.review.apply as { warnings?: unknown[] }).warnings ?? [], []);
  } finally { await service.close(); }

  await decideRound(runDirectory, () => "accept-proposed");
  const exported = await exportedBundle(runDirectory);
  assert.equal(exported.source, stored.run.runResource);
  assert.equal(exported.claims.length, stored.run.review.snapshot.items.length);
  for (const claim of exported.claims) {
    assert.equal(claim.fieldOrBehavior, "record.status");
    assert.equal(claim.value, "Pending");
    const round = roundOf(exported, claim.id);
    assert.equal(round.evidenceObservation, "current");
    assert.equal(round.priorObservationId, result.priorObservation.observationId);
    assert.equal(round.currentObservationId, result.currentObservation!.observationId);
    assert.equal(round.transitionId, result.review.transitionId);
    assert.equal(evidenceOf(exported, claim.id).excerptOrSummary, "Status: Pending");
  }
});

test("a carried-forward decision is distinguishable from one affirmed against the new source", async () => {
  const result = await semanticPair();
  const runDirectory = result.run!.runDirectory;
  await decideRound(runDirectory, () => "keep-current");
  const exported = await exportedBundle(runDirectory);
  for (const claim of exported.claims) {
    assert.equal(claim.value, "Active");
    const round = roundOf(exported, claim.id);
    assert.equal(round.evidenceObservation, "prior");
    const evidence = evidenceOf(exported, claim.id);
    assert.equal(evidence.excerptOrSummary, "Status: Active");
    // The evidence cites the observation the value came from, not the run's own
    // snapshot: a receipt that could not tell those apart would read as though
    // the old value had been re-observed in the new source.
    assert.equal(evidence.sourceRef, priorCandidateSourceRef(result));
  }
});

test("a recheck round resolved onto an absent proposal is refused, and keeping the current value exports", async () => {
  const refused = await roundFor("capture-gone-a", "No status is present");
  await decideRound(refused.run!.runDirectory, () => "accept-proposed");
  await assert.rejects(
    () => reviewedExport(refused.run!.runDirectory),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "EXPORT_UNGROUNDED_SELECTION");
      assert.match(error.message, /record\.status/);
      assert.match(error.message, /records no source span/);
      assert.match(error.message, /keep current/);
      return true;
    },
  );

  // The refusal's advice has to be true, not merely reassuring.
  const kept = await roundFor("capture-gone-b", "No status is present");
  await decideRound(kept.run!.runDirectory, () => "keep-current");
  const exported = await exportedBundle(kept.run!.runDirectory);
  assert.equal(exported.claims.length, 1);
  assert.equal(exported.claims[0]!.value, "Active");
  assert.equal(roundOf(exported, exported.claims[0]!.id).evidenceObservation, "prior");
});

test("a round's new-source side is attested by this run's own extraction", async () => {
  const round = await roundFor("capture-attest", "Status: Pending");
  await decideRound(round.run!.runDirectory, () => "accept-proposed");
  assert.equal((await exportedBundle(round.run!.runDirectory)).claims[0]?.value, "Pending");

  // Edit the value the round proposes AND refresh the queue binding, so the
  // only thing left to disagree is an artifact the editor did not write.
  const runPath = join(round.run!.runDirectory, "run.json");
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  for (const item of stored.review.snapshot.items) {
    for (const candidate of item.spec.candidates) {
      if (candidate.role === "proposed") candidate.value = "Forged after review";
    }
  }
  stored.review.snapshotHash = reviewSnapshotHash(stored.review.snapshot);
  await writeFile(runPath, JSON.stringify(stored, null, 2));

  await assert.rejects(
    () => reviewedExport(round.run!.runDirectory),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "EXPORT_UNATTESTED_QUEUE");
      assert.match(error.message, /this run's extraction does not/);
      return true;
    },
  );
});

/* Which observation a candidate came from decides which attestation applies, so
   it must not be readable off one mutable field. Relabelling `evidenceObservation`
   from "current" to "prior" downgraded a candidate this run *had* extracted into
   one nothing checks — the unattested side of #65 — without any of its other
   provenance agreeing. */
test("a recheck candidate cannot be relabelled onto the side nothing attests", async () => {
  const substitute = (review: RecheckReview, alsoMoveObservationId: boolean): void => {
    for (const item of review.snapshot.items) {
      const transition = item.metadata.producer["lookout.kontourai.io/semantic-transition"]!;
      for (const candidate of item.spec.candidates) {
        const round = candidate.producer["fieldwork.kontourai.io/recheck-round"]!;
        if (round.evidenceObservation !== "current") continue;
        candidate.value = "Substituted after review";
        round.evidenceObservation = "prior";
        if (!alsoMoveObservationId) continue;
        // Move every id the label could be checked against, too.
        round.currentObservationId = transition.priorObservationId as string;
        candidate.producer["lookout.kontourai.io/semantic-transition"]!.observationId = transition.priorObservationId as string;
      }
    }
  };

  for (const alsoMoveObservationId of [false, true]) {
    const round = await roundFor(`capture-relabel-${alsoMoveObservationId}`, "Status: Pending");
    const runDirectory = round.run!.runDirectory;
    await decideRound(runDirectory, () => "accept-proposed");
    assert.equal((await exportedBundle(runDirectory)).claims[0]?.value, "Pending");

    const runPath = join(runDirectory, "run.json");
    const stored = JSON.parse(await readFile(runPath, "utf8"));
    substitute(stored.review, alsoMoveObservationId);
    stored.review.snapshotHash = reviewSnapshotHash(stored.review.snapshot);
    await writeFile(runPath, JSON.stringify(stored, null, 2));

    await assert.rejects(
      () => reviewedExport(runDirectory),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "EXPORT_UNATTESTED_QUEUE");
        assert.match(error.message, /disagrees with itself about which observation it came from/);
        return true;
      },
      `relabel with alsoMoveObservationId=${alsoMoveObservationId}`,
    );
  }
});

/* The consistent version of the same manoeuvre. Relabelling one candidate makes
   it contradict itself; swapping the two sides *wholesale* — roles, observation
   ids, labels and values together — leaves every identity inside the item
   agreeing, and would land an `accept-proposed` decision on the prior side,
   which is the half no artifact in this run attests (#65).
   
   Survey already closes this: a decision event names both its decision and its
   candidate id, and replay validation requires the candidate to be the one that
   decision's role selects. Fieldwork adding its own version would be duplicate
   enforcement, so this pins the property rather than a second guard — it fails
   if that upstream check ever relaxes. */
test("a decision cannot be walked onto the unattested side by swapping the roles under it", async () => {
  const round = await roundFor("capture-roleswap", "Status: Pending");
  const runDirectory = round.run!.runDirectory;
  await decideRound(runDirectory, () => "accept-proposed");
  assert.equal((await exportedBundle(runDirectory)).claims[0]?.value, "Pending");

  const runPath = join(runDirectory, "run.json");
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  for (const item of (stored.review as RecheckReview).snapshot.items) {
    const [first, second] = item.spec.candidates as [Candidate, Candidate];
    const swap = <K extends keyof Candidate>(key: K): void => {
      const held = first[key]; first[key] = second[key]; second[key] = held;
    };
    swap("role");
    swap("value");
    swap("locator");
    swap("source");
    swap("extraction");
    swap("producer");
    // The decision still names `.proposed`; that candidate is now the prior side
    // in every field, and carries a value this run never extracted.
    second.value = "Substituted after review";
  }
  stored.review.snapshotHash = reviewSnapshotHash(stored.review.snapshot);
  await writeFile(runPath, JSON.stringify(stored, null, 2));

  await assert.rejects(
    () => reviewedExport(runDirectory),
    (error: Error) => {
      assert.match(error.message, /Review session events are invalid/);
      assert.match(error.message, /decision accept-proposed expects candidate/);
      return true;
    },
  );
});

interface Candidate {
  role?: unknown;
  value?: unknown;
  locator?: unknown;
  source?: unknown;
  extraction?: unknown;
  producer?: unknown;
}

interface RecheckReview {
  snapshot: {
    items: {
      metadata: { producer: Record<string, Record<string, unknown>> };
      spec: { candidates: (Candidate & { value: unknown; producer: Record<string, Record<string, unknown>> })[] };
    }[];
  };
}

test("an added proposal is told to accept it, not to keep a value that was never there", async () => {
  // The mirror of the removal case: here the *prior* side is the absence, so
  // advising "keep current" would prescribe the decision that is failing.
  const added = await roundFor("capture-added-a", "Status: Active", "Nothing recorded yet");
  assert.deepEqual(
    (await readRun(added.run!.runDirectory)).run.review.snapshot.items.map((item) =>
      (item.metadata.producer?.["lookout.kontourai.io/semantic-transition"] as { semanticKind: string }).semanticKind),
    ["proposal-added"],
  );
  await decideRound(added.run!.runDirectory, () => "keep-current");
  await assert.rejects(
    () => reviewedExport(added.run!.runDirectory),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "EXPORT_UNGROUNDED_SELECTION");
      assert.match(error.message, /Decide the item "accept proposed"/);
      assert.doesNotMatch(error.message, /keep current/);
      return true;
    },
  );

  const accepted = await roundFor("capture-added-b", "Status: Active", "Nothing recorded yet");
  await decideRound(accepted.run!.runDirectory, () => "accept-proposed");
  const exported = await exportedBundle(accepted.run!.runDirectory);
  assert.deepEqual(exported.claims.map((claim) => claim.value), ["Active"]);
});

test("a recheck field with one item decided and its sibling undecided exports no value for it", async () => {
  // Survey groups a first round's values into one item per claim, so two
  // items on one field now come from a recheck round (lookout#34).
  const split = await roundFor("capture-both-unsettled", "Status: Paused");
  const items = (await readRun(split.run!.runDirectory)).run.review.snapshot.items;
  assert.equal(items.length, 2);
  await decideRound(split.run!.runDirectory, (_name, index) => (index === 0 ? "accept-proposed" : undefined) as string);
  await assert.rejects(() => reviewedExport(split.run!.runDirectory), (error: Error & { code?: string; excluded?: { code: string }[] }) => {
    assert.deepEqual(error.excluded?.map((entry) => entry.code).sort(), ["EXPORT_FIELD_UNSETTLED", "EXPORT_UNDECIDED"]);
    return true;
  });
});

test("a round that decides one field two ways is refused rather than exported as two claims", async () => {
  // A changed value also changes its excerpt, so Lookout raises both a
  // value-changed and a provenance-changed item for the one field.
  const split = await roundFor("capture-both-a", "Status: Paused");
  const stored = await readRun(split.run!.runDirectory);
  assert.equal(stored.run.review.snapshot.items.length, 2);
  assert.equal(new Set(stored.run.review.snapshot.items.map((item) => item.spec.target)).size, 1);

  await decideRound(split.run!.runDirectory, (_name, index) => index === 0 ? "accept-proposed" : "keep-current");
  await assert.rejects(
    () => reviewedExport(split.run!.runDirectory),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "EXPORT_CONFLICTING_DECISIONS");
      assert.match(error.message, /accepts two different values for record\.status/);
      return true;
    },
  );

  // Rejecting one side of the pair asserts only the accepted value (fieldwork#137).
  const rejectedOne = await roundFor("capture-both-c", "Status: Paused");
  await decideRound(rejectedOne.run!.runDirectory, (_name, index) => index === 0 ? "accept-proposed" : "reject-proposed");
  const oneAccepted = (await reviewedExport(rejectedOne.run!.runDirectory)).bundle as unknown as {
    claims: { value: unknown; status: string }[];
  };
  assert.deepEqual(oneAccepted.claims.map((claim) => [claim.value, claim.status]), [["Paused", "verified"], ["Paused", "rejected"]]);

  const agreed = await roundFor("capture-both-b", "Status: Paused");
  await decideRound(agreed.run!.runDirectory, () => "accept-proposed");
  const exported = await exportedBundle(agreed.run!.runDirectory);
  assert.deepEqual(exported.claims.map((claim) => claim.value), ["Paused", "Paused"]);
});

async function exportedBundle(runDirectory: string): Promise<ExportedBundle> {
  return (await reviewedExport(runDirectory)).bundle as unknown as ExportedBundle;
}

interface ExportedBundle {
  readonly source: string;
  readonly claims: readonly { readonly id: string; readonly fieldOrBehavior: string; readonly value: unknown }[];
  readonly evidence: readonly {
    readonly claimId: string;
    readonly sourceRef: string;
    readonly excerptOrSummary?: string;
    readonly metadata?: { readonly producer?: Record<string, Record<string, string>> };
  }[];
}

test("a runtime-bound recheck refuses an unsupported field type up front, naming the field", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-recheck-array-"));
  const task = JSON.parse(await readFile(join(fixture, "task.json"), "utf8"));
  task.spec.traverse.targetSchema[0].type = "array";
  const taskPath = join(root, "task.json");
  await writeFile(taskPath, JSON.stringify(task));
  const setup = await baseline('Status: ["Active"]', taskPath);
  let checks = 0;
  await assert.rejects(
    () => recheckFieldwork({
      ...setup.options,
      source: { ...source, targetSchema: traverseTask(parseFieldworkTask(task)).targetSchema },
      runtime: failingRuntimeBinding(),
      acquisition: {
        check: async () => {
          checks += 1;
          const current = snapshot("capture-array", 'Status: ["Paused"]', "2026-07-23T17:30:00.000Z");
          await setup.store.put(current);
          return check("changed", setup.priorRef, buildSnapshotSourceRef(current));
        },
      },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "TASK_UNSUPPORTED_FIELD_TYPE");
      assert.match(error.message, /record\.status has type array/);
      return true;
    },
  );
  assert.equal(checks, 0);
});

test("a recheck round whose extraction did not cover the whole source is refused at export (fieldwork#136)", async () => {
  // The changed value is read from the first chunk, but a later chunk fails at
  // the provider, so part of the current source was never read. Traverse 3
  // reports that as a `provider-failure` partial outcome. Accepting the change
  // must not export as a complete receipt.
  const filler = `\n${"filler line of text.\n".repeat(1_300)}`;
  const setup = await baseline(`Status: Active${filler}`);
  const current = snapshot("capture-unread", `Status: Pending${filler}`, "2026-07-23T17:00:00.000Z");
  const result = await recheckFieldwork({
    ...setup.options,
    runtime: statusOnlyRuntimeBinding(),
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
  });
  assert.equal(result.classification, "semantic-drift");
  const stored = await readRun(result.run!.runDirectory);
  assert.deepEqual(stored.envelope.result.outcome, { status: "partial", reason: "provider-failure" });
  assert.ok((stored.envelope.result.providerFailures?.length ?? 0) >= 1);
  await decideRound(result.run!.runDirectory, () => "accept-proposed");
  await assert.rejects(() => reviewedExport(result.run!.runDirectory), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_COVERAGE_INCOMPLETE");
    assert.match(error.message, /partial: provider-failure/);
    return true;
  });
});

test("a run whose proposals report no confidence is never given one, and it can be exported and rechecked", async () => {
  // Traverse 3 omits confidence when the provider does not report one. Lookout
  // 0.8 records such a proposal, and Survey 7 exports it through Surface 4.1+,
  // so neither path needs a confidence invented for it.
  const unreported = statusOnlyRuntimeBinding(null);
  const setup = await baseline("Status: Active", join(fixture, "task.json"), unreported);
  const prior = await readRun(setup.prior.runDirectory);
  assert.equal(prior.envelope.result.proposals.length, 1);
  assert.equal("confidence" in prior.envelope.result.proposals[0]!, false);
  await decideRound(setup.prior.runDirectory, () => "accept-proposed");
  const exported = await reviewedExport(setup.prior.runDirectory);
  const dimensions = (exported.reviewedGrounding as { dimensions: Record<string, unknown>[] }).dimensions;
  assert.equal(dimensions.length, 1);
  assert.equal("candidateConfidence" in dimensions[0]!, false, "no confidence is invented for the export");

  const current = snapshot("capture-unreported", "Status: Pending", "2026-07-23T17:40:00.000Z");
  const result = await recheckFieldwork({
    ...setup.options,
    runtime: unreported,
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
  });
  assert.equal(result.classification, "semantic-drift");
  assert.equal("confidence" in result.currentObservation!.proposals[0]!, false);
});

/*
 * Lookout 0.8 never reports a removal from an observation whose extraction did
 * not read all of its text, but only when the observation says so. The status
 * line of the current capture sits in a chunk whose provider call fails, so the
 * run proposes nothing there: it is partial, not a source that lost its status.
 */
test("a partial recheck run records its incompleteness and raises no removal", async () => {
  const filler = `\n${"filler line of text.\n".repeat(1_300)}`;
  const runtime = unreadableChunkRuntimeBinding();
  const setup = await baseline(`Status: Active${filler}`, join(fixture, "task.json"), runtime);
  assert.deepEqual((await readRun(setup.prior.runDirectory)).envelope.result.outcome, { status: "success" });
  const current = snapshot("capture-partial", `UNREADABLE Status: Active${filler}`, "2026-07-23T17:50:00.000Z");
  const result = await recheckFieldwork({
    ...setup.options,
    runtime,
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
  });
  const stored = await readRun(result.run!.runDirectory);
  assert.deepEqual(stored.envelope.result.outcome, { status: "partial", reason: "provider-failure" });
  assert.equal(stored.envelope.result.proposals.length, 0);

  const kinds = result.review.items.map((item) => item.metadata?.producer?.["lookout.kontourai.io/semantic-transition"]?.semanticKind);
  assert.equal(kinds.includes("proposal-removed"), false, `a partial run raised ${JSON.stringify(kinds)}`);
  assert.equal(result.review.itemCount, 0);
  const committed = await createObservationStore({ root: setup.options.observationRoot }).loadLatest(source.id);
  assert.ok(committed.ok && committed.value);
  assert.equal(committed.value.incomplete?.reason, "provider-failure");
  assert.ok((committed.value.incomplete?.coverage?.length ?? 0) > 0, "the run's coverage is recorded with it");
});

/*
 * Lookout 0.8.1 turns what a partial prior lacked into review work. Lookout 0.8.0
 * listed it only as a newly observed fact, so a value the prior never read
 * reached no reviewer: the round had nothing to decide.
 */
test("a value a partial prior never read is queued for review as newly observed, not dropped", async () => {
  const result = await recheckAfterPartialPrior("node");
  assert.equal(result.classification, "semantic-drift");
  const items = result.review.items as unknown as ReviewItem[];
  assert.deepEqual(items.map((item) => (item.metadata.producer?.["lookout.kontourai.io/semantic-transition"] as { semanticKind?: string } | undefined)?.semanticKind), ["proposal-newly-observed"]);
  assert.deepEqual(items[0]!.spec.candidates.find((candidate) => candidate.role === "proposed")?.value, "Active");
  await decideRound(result.run!.runDirectory, () => "accept-proposed");
  const exported = (await reviewedExport(result.run!.runDirectory)).bundle as unknown as ExportedBundle;
  assert.deepEqual(exported.claims.map((claim) => claim.value), ["Active"]);
});

/*
 * Lookout 0.7 stored observations without the `incomplete` marker. A prior it
 * stored from a partial run reads as complete, so values that run never read
 * would show as added rather than newly observed. It is not the prior run's
 * observation and is not reused as one; the same prior stored with the marker is.
 */
test("a prior observation stored without the incomplete marker its run records is not reused", async () => {
  const filler = `\n${"filler line of text.\n".repeat(1_300)}`;
  const runtime = unreadableChunkRuntimeBinding();
  const attempt = async (withMarker: boolean, recover = false) => {
    const setup = await baseline(`Status: Active${filler}UNREADABLE`, join(fixture, "task.json"), runtime);
    const prior = await readRun(setup.prior.runDirectory);
    assert.equal(prior.envelope.result.outcome.status, "partial");
    const { outcome, coverage } = prior.envelope.result;
    const observation: ProposalSetObservation = {
      sourceId: source.id,
      snapshotRef: prior.envelope.source.snapshotRef!,
      observedAt: prior.envelope.result.extractedAt,
      proposals: prior.envelope.result.proposals as ProposalSetObservation["proposals"],
      ...(withMarker && outcome.status === "partial" ? { incomplete: { reason: outcome.reason, ...(coverage ? { coverage } : {}) } } : {}),
    };
    const committed = await createObservationStore({ root: setup.options.observationRoot }).commit({
      observation, recordedAt: observation.observedAt,
      check: { checkedAt: observation.observedAt, resultKind: "changed", currentSnapshotRef: observation.snapshotRef },
    }, null);
    assert.ok(committed.ok, JSON.stringify(committed));
    const current = snapshot("capture-after-partial", `Status: Paused${filler}`, "2026-07-23T18:00:00.000Z");
    const options = { ...setup.options, runtime, acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } } };
    if (recover) {
      await assert.rejects(() => recheckFieldwork(options), { code: "RECHECK_CONFLICT" });
      // The documented recovery: a new, empty observation root for this source.
      return recheckFieldwork({ ...options, observationRoot: join(setup.root, "observations-rebuilt") });
    }
    return recheckFieldwork({
      ...setup.options,
      runtime,
      acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
    });
  };
  assert.ok((await attempt(true)).run, "the prior stored with its marker is the prior run's observation");
  await assert.rejects(() => attempt(false), (error: Error & { code?: string; reason?: string }) => {
    assert.equal(error.code, "RECHECK_CONFLICT");
    assert.equal(error.reason, "prior-observation-unmarked-incomplete");
    assert.match(error.message, /older Lookout.*--observation-root/s);
    return true;
  });
  const recovered = await attempt(false, true);
  assert.ok(recovered.run, "a new observation root re-establishes the prior from the selected run");
});

/*
 * A recheck round's new-source candidates are matched against the envelope's
 * proposals directly, so an excerpt rewritten in both, with the run re-bound,
 * would be cited. Export compares every span with the prepared text first.
 */
test("a recheck round citing an excerpt the prepared text does not contain is refused at export", async () => {
  // Two chunks state the new value, so the extraction stays grounded when one
  // of its two proposals no longer verifies.
  const result = await roundFor("capture-rewritten-excerpt", `Status: Pending\n${"filler line of text.\n".repeat(700)}Status: Pending\n`);
  const runDirectory = result.run!.runDirectory;
  const runPath = join(runDirectory, "run.json");
  const envelopePath = join(runDirectory, "extraction-envelope.json");
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  const envelope = JSON.parse(await readFile(envelopePath, "utf8"));
  const pending = envelope.result.proposals.find((proposal: { candidateValue: unknown }) => proposal.candidateValue === "Pending");
  assert.equal(pending.provenance.excerpt, "Status: Pending");
  pending.provenance.excerpt = "Status: Pendinx";
  pending.candidateValue = "Pendinx";
  let cited = 0;
  for (const item of stored.review.snapshot.items as ReviewItem[]) {
    for (const candidate of item.spec.candidates) {
      if (candidate.role !== "proposed" || candidate.locator?.locator !== pending.provenance.locator) continue;
      cited++;
      candidate.value = "Pendinx";
      candidate.locator = { ...candidate.locator!, excerpt: "Status: Pendinx" };
    }
  }
  assert.ok(cited > 0, "the round cites the rewritten proposal");
  stored.review.snapshotHash = reviewSnapshotHash(stored.review.snapshot);
  stored.extraction = bindExtraction(stored.task, importNameFor(stored), envelope, (await readRun(runDirectory)).preparedText).extraction;
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  await writeFile(runPath, JSON.stringify(stored, null, 2));
  await decideRound(runDirectory, () => "accept-proposed");
  await assert.rejects(() => reviewedExport(runDirectory), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_EXCERPT_MISMATCH");
    assert.match(error.message, /is not what the prepared source text contains there/);
    return true;
  });
});

/** Proposes the status its chunk states, fails any chunk marked UNREADABLE, and proposes nothing elsewhere. */
function unreadableChunkRuntimeBinding(): FieldworkRuntimeBinding {
  return runtimeBinding(async (request) => {
    const text = JSON.stringify(request.messages);
    if (text.includes("UNREADABLE")) throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "unavailable", false);
    const match = /Status: (\w+)/.exec(text);
    return {
      provider: "fixture-runtime", model: "fixture-model", outputText: "",
      toolCalls: [{
        id: "tool-status", name: "submit_extraction_proposals",
        input: { proposals: match ? [{ fieldPath: "record.status", value: match[1], confidence: 0.98, excerpt: match[0], locator: null, occurrenceHint: null }] : [] },
      }],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latencyMs: 1, stopReason: "tool_use",
    };
  });
}

function failingRuntimeBinding(): FieldworkRuntimeBinding {
  return runtimeBinding(async () => { throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "unavailable", false); });
}

/** Proposes the status its chunk states, and fails any chunk that states none. */
function statusOnlyRuntimeBinding(confidence: number | null = 0.98): FieldworkRuntimeBinding {
  return runtimeBinding(async (request) => {
    const match = /Status: (\w+)/.exec(JSON.stringify(request.messages));
    if (!match) throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "unavailable", false);
    return {
      provider: "fixture-runtime", model: "fixture-model", outputText: "",
      toolCalls: [{
        id: "tool-status", name: "submit_extraction_proposals",
        input: { proposals: [{ fieldPath: "record.status", value: match[1], confidence, excerpt: match[0], locator: null, occurrenceHint: null }] },
      }],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latencyMs: 1, stopReason: "tool_use",
    };
  });
}

function runtimeBinding(invoke: ModelRuntime["invoke"]): FieldworkRuntimeBinding {
  const runtime: ModelRuntime = {
    id: "fake:recheck-runtime",
    capabilities: () => ({
      structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native",
      streaming: false, abort: true, usage: true,
    }),
    invoke,
  };
  return {
    role: "fieldwork-extraction",
    candidates: [{ id: "scripted", runtime }],
    budget: { maxAttempts: 8, maxTotalTokens: 8_000, maxElapsedMs: 60_000 },
    maxTokensPerAttempt: 1_000,
  };
}

function evidenceOf(bundle: ExportedBundle, claimId: string): ExportedBundle["evidence"][number] {
  const entry = bundle.evidence.find((item) => item.claimId === claimId);
  assert.ok(entry, `no evidence for ${claimId}`);
  return entry;
}

function roundOf(bundle: ExportedBundle, claimId: string): Record<string, string> {
  const round = evidenceOf(bundle, claimId).metadata?.producer?.["fieldwork.kontourai.io/recheck-round"];
  assert.ok(round, `no recheck-round provenance for ${claimId}`);
  return round;
}

function priorCandidateSourceRef(result: Awaited<ReturnType<typeof semanticPair>>): string {
  const item = result.review.items[0] as unknown as ReviewItem;
  return item.spec.candidates.find((candidate) => candidate.role === "current")!.source.sourceRef;
}

/** A fresh baseline plus one recheck round against `body`. */
async function roundFor(captureId: string, body: string, priorBody = "Status: Active") {
  const setup = await baseline(priorBody);
  const current = snapshot(captureId, body, "2026-07-23T16:00:00.000Z");
  return recheckFieldwork({
    ...setup.options,
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
  });
}

/** Records one decision per queued item through the same loopback API the browser uses. */
async function decideRound(
  runDirectory: string,
  choose: (itemName: string, index: number) => string,
  expectedRevision = 0,
): Promise<void> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(
        snapshot.items.map((item, index) => [item.metadata.name, choose(item.metadata.name, index)]),
      ),
    } as Parameters<typeof buildReviewSessionEvents>[0]);
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await service.close();
  }
}

async function semanticPair() {
  const setup = await baseline("Status: Active");
  const current = snapshot("capture-replay", "Status: Pending", "2026-07-23T15:00:00.000Z");
  return recheckFieldwork({
    ...setup.options,
    now: () => "2026-07-23T15:01:00.000Z",
    acquisition: { check: async () => { await setup.store.put(current); return check("changed", setup.priorRef, buildSnapshotSourceRef(current)); } },
  });
}

async function baseline(body: string, taskPath = join(fixture, "task.json"), runtime?: FieldworkRuntimeBinding) {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-recheck-"));
  const snapshotRoot = join(root, "snapshots");
  const runRoot = join(root, "runs");
  const observationRoot = join(root, "observations");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const priorSnapshot = snapshot("capture-prior", body, "2026-07-23T10:00:00.000Z");
  await store.put(priorSnapshot);
  const priorRef = buildSnapshotSourceRef(priorSnapshot);
  const prior = await runFieldwork({
    taskPath,
    snapshotRef: priorRef,
    snapshotRoot,
    root: runRoot,
    ...(runtime === undefined ? {} : { runtime }),
  });
  return {
    root,
    store,
    prior,
    priorRef,
    options: {
      source,
      priorRunDirectory: prior.runDirectory,
      taskPath,
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
    // Recheck admission binds captures to the registered source, rather than
    // treating the fixture label as a source authority.
    sourceId: source.id,
    url: source.url,
    status: 200,
    fetchedAt,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": contentType },
  };
}
