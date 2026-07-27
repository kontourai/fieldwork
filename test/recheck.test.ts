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
import type { ReviewItem } from "@kontourai/survey";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { canonicalSemanticReviewItems, FIELDWORK_SOURCE_KIND, reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { reviewSnapshotHash } from "../src/survey-persistence.js";
import { openRun } from "../src/server.js";
import { apiFetch } from "./helpers.js";
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

  await decideRound(runDirectory, () => "accept-proposed");
  const exported = await reviewedExport(runDirectory) as ExportedBundle;
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
  const exported = await reviewedExport(runDirectory) as ExportedBundle;
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
  const exported = await reviewedExport(kept.run!.runDirectory) as ExportedBundle;
  assert.equal(exported.claims.length, 1);
  assert.equal(exported.claims[0]!.value, "Active");
  assert.equal(roundOf(exported, exported.claims[0]!.id).evidenceObservation, "prior");
});

test("a round's new-source side is attested by this run's own extraction", async () => {
  const round = await roundFor("capture-attest", "Status: Pending");
  await decideRound(round.run!.runDirectory, () => "accept-proposed");
  assert.equal((await reviewedExport(round.run!.runDirectory) as ExportedBundle).claims[0]?.value, "Pending");

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
    assert.equal((await reviewedExport(runDirectory) as ExportedBundle).claims[0]?.value, "Pending");

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
  assert.equal((await reviewedExport(runDirectory) as ExportedBundle).claims[0]?.value, "Pending");

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
  const exported = await reviewedExport(accepted.run!.runDirectory) as ExportedBundle;
  assert.deepEqual(exported.claims.map((claim) => claim.value), ["Active"]);
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
      assert.match(error.message, /conflicting decisions for record\.status/);
      return true;
    },
  );

  const agreed = await roundFor("capture-both-b", "Status: Paused");
  await decideRound(agreed.run!.runDirectory, () => "accept-proposed");
  const exported = await reviewedExport(agreed.run!.runDirectory) as ExportedBundle;
  assert.deepEqual(exported.claims.map((claim) => claim.value), ["Paused", "Paused"]);
});

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
  await setup.store.put(current);
  return recheckFieldwork({
    ...setup.options,
    acquisition: { check: async () => check("changed", setup.priorRef, buildSnapshotSourceRef(current)) },
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
