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
  assert.deepEqual(
    envelope.result.proposals.map((proposal: {
      fieldPath: string;
      candidateValue: unknown;
      valueType: string;
      enumValues?: string[];
      provenance: { excerpt: string; locator: string };
    }) => ({
      fieldPath: proposal.fieldPath,
      value: proposal.candidateValue,
      valueType: proposal.valueType,
      ...(proposal.enumValues ? { enumValues: proposal.enumValues } : {}),
      excerpt: proposal.provenance.excerpt,
      locator: proposal.provenance.locator,
    })),
    oracle.proposals,
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
