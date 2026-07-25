import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFilesystemSnapshotStore,
  type Snapshot,
} from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  buildReviewSessionEvents,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { recheckFieldwork, type FieldworkLookoutSource } from "../src/recheck.js";
import { openRun } from "../src/server.js";
import { apiFetch } from "./helpers.js";

const fixtureRoot = "examples/vendor-obligations";

interface ExampleOracle {
  schemaVersion: number;
  fixture: string;
  sourceLength: number;
  replay: {
    provider: string;
    model: string;
    providerCalls: number;
    totalTokensUsed: number;
    rawKeys: string[];
    outcome: { status: string };
    warnings: unknown[];
  };
  ordering: { nonOverlapping: boolean };
  occurrenceDefaults: {
    resolverVersion: string;
    count: number;
    index: number;
    selection: string;
    hintUsed: boolean;
    ambiguous: boolean;
  };
  proposals: Array<{
    fieldPath: string;
    value: unknown;
    valueType: string;
    enumValues?: string[];
    excerpt: string;
    locator: string;
  }>;
  reviewedClaims: Array<{
    fieldPath: string;
    value: unknown;
    locator: string;
  }>;
  recheck: {
    classification: string;
    revisedSourceLength: number;
    changedValues: Record<string, unknown>;
    changes: Array<{
      fieldPath: string;
      semanticKind: string;
      prior: { value: unknown; excerpt: string; locator: string };
      current: { value: unknown; excerpt: string; locator: string };
    }>;
    priorRunRemainsImmutable: boolean;
  };
}

test("vendor renewal example proves typed grounding, Survey review, export, and changed-source recheck", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-vendor-renewal-"));
  const snapshotRoot = join(root, "snapshots");
  const runRoot = join(root, "runs");
  const observationRoot = join(root, "observations");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const [task, sourceText, revisedText, oracle] = await Promise.all([
    readFile(join(fixtureRoot, "task.json"), "utf8").then((value) => JSON.parse(value)),
    readFile(join(fixtureRoot, "source.txt"), "utf8"),
    readFile(join(fixtureRoot, "source-revised.txt"), "utf8"),
    readFile(join(fixtureRoot, "oracle.json"), "utf8").then((value) => JSON.parse(value) as ExampleOracle),
  ]);
  const source: FieldworkLookoutSource = {
    id: "northstar-renewal-brief",
    url: "https://example.invalid/vendor-renewal",
    kind: "web-page",
    cadenceHint: "manual",
    renderPolicy: "never",
    targetSchema: task.spec.traverse.targetSchema,
  };
  const priorSnapshot = snapshot(source.id, source.url, sourceText, "2026-07-25T08:00:00.000Z");
  const currentSnapshot = snapshot(source.id, source.url, revisedText, "2026-07-25T09:00:00.000Z");
  await Promise.all([store.put(priorSnapshot), store.put(currentSnapshot)]);
  const priorRef = buildSnapshotSourceRef(priorSnapshot);
  const currentRef = buildSnapshotSourceRef(currentSnapshot);

  const run = await runFieldwork({
    taskPath: join(fixtureRoot, "task.json"),
    snapshotRef: priorRef,
    snapshotRoot,
    root: runRoot,
  });
  assert.equal(run.proposalCount, oracle.proposals.length);
  assert.equal(sourceText.length, oracle.sourceLength);
  const envelope = JSON.parse(await readFile(join(run.runDirectory, "extraction-envelope.json"), "utf8"));
  assert.deepEqual({
    provider: envelope.result.provider,
    model: envelope.result.model,
    providerCalls: envelope.result.providerCalls,
    totalTokensUsed: envelope.result.totalTokensUsed,
    rawKeys: Object.keys(envelope.result.raw).sort(),
    outcome: envelope.result.outcome,
    warnings: envelope.result.warnings ?? [],
  }, oracle.replay);
  const spans = envelope.result.proposals.map((proposal: { provenance: { locator: string } }) =>
    locatorSpan(proposal.provenance.locator));
  assert.deepEqual({
    nonOverlapping: spans.every((span: { start: number; end: number }, index: number) =>
      index === 0 || spans[index - 1]!.end <= span.start),
  }, oracle.ordering);
  assert.deepEqual(
    envelope.result.proposals.map((proposal: {
      fieldPath: string;
      candidateValue: unknown;
      valueType: string;
      enumValues?: string[];
      provenance: {
        excerpt: string;
        locator: string;
        occurrence: {
          resolverVersion: string;
          count: number;
          selected: { index: number; start: number; end: number };
          selection: string;
          hintUsed: boolean;
          ambiguous: boolean;
        };
      };
    }) => ({
      fieldPath: proposal.fieldPath,
      value: proposal.candidateValue,
      valueType: proposal.valueType,
      ...(proposal.enumValues ? { enumValues: proposal.enumValues } : {}),
      excerpt: proposal.provenance.excerpt,
      locator: proposal.provenance.locator,
      occurrence: proposal.provenance.occurrence,
    })),
    oracle.proposals.map((proposal) => ({
      ...proposal,
      occurrence: {
        resolverVersion: oracle.occurrenceDefaults.resolverVersion,
        count: oracle.occurrenceDefaults.count,
        selected: {
          index: oracle.occurrenceDefaults.index,
          ...locatorSpan(proposal.locator),
        },
        selection: oracle.occurrenceDefaults.selection,
        hintUsed: oracle.occurrenceDefaults.hintUsed,
        ambiguous: oracle.occurrenceDefaults.ambiguous,
      },
    })),
  );

  await acceptEveryProposal(run.runDirectory);
  const bundle = await reviewedExport(run.runDirectory);
  const evidenceByClaim = new Map(bundle.evidence.map((entry) => [entry.claimId, entry]));
  assert.deepEqual(
    bundle.claims.map((claim) => ({
      fieldPath: claim.fieldOrBehavior,
      value: claim.value,
      locator: evidenceByClaim.get(claim.id)?.sourceLocator,
    })),
    oracle.reviewedClaims,
  );

  const priorRunBeforeRecheck = await readFile(join(run.runDirectory, "run.json"), "utf8");
  const recheck = await recheckFieldwork({
    source,
    priorRunDirectory: run.runDirectory,
    taskPath: join(fixtureRoot, "task.json"),
    root: runRoot,
    observationRoot,
    snapshotRoot,
    now: () => "2026-07-25T09:01:00.000Z",
    acquisition: {
      check: async () => ({
        sourceId: source.id,
        sourceUrl: source.url,
        checkedAt: "2026-07-25T09:00:30.000Z",
        warnings: [],
        kind: "changed",
        priorSnapshotRef: priorRef,
        currentSnapshotRef: currentRef,
        changeBasis: "hash",
      }),
    },
  });
  assert.equal(recheck.classification, oracle.recheck.classification);
  assert.equal(revisedText.length, oracle.recheck.revisedSourceLength);
  assert.ok(recheck.run);
  assert.ok(recheck.review.itemCount >= Object.keys(oracle.recheck.changedValues).length);
  const currentValues = Object.fromEntries(
    (recheck.currentObservation?.proposals ?? []).map((proposal) => [
      proposal.fieldPath,
      proposal.candidateValue,
    ]),
  );
  for (const [fieldPath, value] of Object.entries(oracle.recheck.changedValues)) {
    assert.deepEqual(currentValues[fieldPath], value, fieldPath);
  }
  const priorByField = new Map(recheck.priorObservation.proposals.map((proposal) => [
    proposal.fieldPath,
    proposal,
  ]));
  const currentByField = new Map((recheck.currentObservation?.proposals ?? []).map((proposal) => [
    proposal.fieldPath,
    proposal,
  ]));
  assert.deepEqual(
    recheck.review.items.map((item) => {
      const target = item.spec?.target as string;
      const transition = item.metadata?.producer?.["lookout.kontourai.io/semantic-transition"] as {
        semanticKind: string;
        priorObservationId: string;
        currentObservationId: string;
      };
      const candidates = item.spec?.candidates as Array<{
        role: string;
        value: unknown;
        locator?: { excerpt: string; locator: string };
        producer: { "lookout.kontourai.io/semantic-transition": { observationId: string } };
      }>;
      const prior = priorByField.get(target)!;
      const current = currentByField.get(target)!;
      assert.equal(transition.priorObservationId, recheck.priorObservation.observationId);
      assert.equal(transition.currentObservationId, recheck.currentObservation?.observationId);
      assert.equal(candidates[0]?.producer["lookout.kontourai.io/semantic-transition"].observationId, recheck.priorObservation.observationId);
      assert.equal(candidates[1]?.producer["lookout.kontourai.io/semantic-transition"].observationId, recheck.currentObservation?.observationId);
      return {
        fieldPath: target,
        semanticKind: transition.semanticKind,
        prior: {
          value: prior.candidateValue,
          excerpt: prior.provenance.excerpt,
          locator: prior.provenance.locator,
        },
        current: {
          value: current.candidateValue,
          excerpt: current.provenance.excerpt,
          locator: current.provenance.locator,
        },
      };
    }),
    oracle.recheck.changes,
  );
  if (oracle.recheck.priorRunRemainsImmutable) {
    assert.equal(await readFile(join(run.runDirectory, "run.json"), "utf8"), priorRunBeforeRecheck);
  }
});

async function acceptEveryProposal(runDirectory: string): Promise<void> {
  const server = await openRun(runDirectory);
  try {
    const initial = await apiFetch(server, "/api/v1/run")
      .then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(
        snapshot.items.map((item) => [item.metadata.name, "accept-proposed"]),
      ),
    });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events,
        expectedEventCount: 0,
        expectedRevision: 0,
      }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await server.close();
  }
}

function locatorSpan(locator: string): { start: number; end: number } {
  const match = /^chars:(\d+)-(\d+)$/.exec(locator);
  assert.ok(match, `${locator} must be an exact chars locator`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function snapshot(sourceId: string, url: string, body: string, fetchedAt: string): Snapshot {
  return {
    sourceId,
    url,
    status: 200,
    fetchedAt,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": "text/plain; charset=utf-8" },
  };
}
