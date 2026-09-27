import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildReviewSessionEvents,
  hashReviewQueueSnapshot,
  initialReviewQueueSessionState,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import type { ReviewItem } from "@kontourai/survey";
import type { FieldworkReviewerIdentity, FieldworkRunViewV1, ReviewMutationResponseV1 } from "../src/api-contracts.js";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { REVIEW_ATTRIBUTION_PRODUCER, UNATTRIBUTED_ACTOR_ID } from "../src/review-attribution.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";

/*
 * fieldwork#148: every decision used to carry Survey's constant snapshot actor
 * ("review-workbench-operator") and date (2026-06-04), whoever made it and
 * whenever. The server now stamps the host-configured reviewer and its own
 * clock on each appended event, and the export carries both.
 */

interface ExportedBundle {
  claims: { id: string; updatedAt: string; fieldOrBehavior: string }[];
  events: { claimId: string; actor?: string; verifiedAt?: string }[];
  reviewRound: {
    decisions: { reviewItemName: string; claimId: string; actor: { id: string; kind: string }; decidedAt: string; mode?: string }[];
  };
}

const CLIENT_TIME = "2026-07-23T00:00:00.000Z";

test("a decision posted through the API exports under the configured reviewer at server time, not the client's actor", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("attr-alice") });
  const saved = await decide(run.runDirectory, { id: "alice", kind: "human" }, 1, "mallory");
  const createdAt = JSON.parse(await readFile(join(run.runDirectory, "run.json"), "utf8")).createdAt as string;

  // The event history names the stamped actor; the client's claim is kept aside.
  const decision = saved.find((event) => event.spec.eventType === "decision-changed")!;
  assert.equal(decision.spec.actor.id, "alice");
  assert.notEqual(decision.spec.occurredAt, CLIENT_TIME);
  assert.equal(decision.metadata.producer[REVIEW_ATTRIBUTION_PRODUCER]?.clientClaimedActorId, "mallory");

  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedBundle;
  assert.equal(exported.claims.length, 1);
  const [claim] = exported.claims;
  const [verified] = exported.events.filter((event) => event.claimId === claim!.id);
  assert.equal(verified!.actor, "alice");
  assert.ok(Date.parse(verified!.verifiedAt!) > Date.parse(createdAt), `${verified!.verifiedAt} must be after ${createdAt}`);
  assert.equal(claim!.updatedAt, verified!.verifiedAt);
  assert.deepEqual(exported.reviewRound.decisions.map(({ actor, mode, claimId }) => ({ actor, mode, claimId })), [
    { actor: { id: "alice", kind: "human" }, mode: "individual", claimId: claim!.id },
  ]);
  assert.doesNotMatch(JSON.stringify(exported), /mallory|review-workbench-operator|2026-06-04/);
});

test("one request that decides three items records mode batch on each", async () => {
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json", sourcePath: "examples/vendor-obligations/source.txt", root: await tempRoot("attr-batch"),
  });
  const saved = await decide(run.runDirectory, { id: "alice", kind: "human" }, 3);
  const decisions = saved.filter((event) => event.spec.eventType.startsWith("decision-"));
  assert.equal(new Set(decisions.map((event) => event.spec.reviewItemName)).size, 3);
  for (const event of saved) assert.equal(event.metadata.producer[REVIEW_ATTRIBUTION_PRODUCER]?.mode, "batch");
});

test("an agent reviewer records every decision as agent-made", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("attr-agent") });
  await decide(run.runDirectory, { id: "triage-agent", kind: "agent" }, 1);
  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedBundle;
  assert.deepEqual(exported.reviewRound.decisions.map(({ actor, mode }) => ({ actor, mode })), [
    { actor: { id: "triage-agent", kind: "agent" }, mode: "agent" },
  ]);
});

test("without a configured reviewer the actor kind is unattributed, never the synthetic operator", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("attr-none") });
  await decide(run.runDirectory, undefined, 1);
  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedBundle;
  assert.deepEqual(exported.reviewRound.decisions.map(({ actor, mode }) => ({ actor, mode })), [
    { actor: { id: UNATTRIBUTED_ACTOR_ID, kind: "unattributed" }, mode: "individual" },
  ]);
  assert.deepEqual(exported.events.map((event) => event.actor), [UNATTRIBUTED_ACTOR_ID]);
  assert.doesNotMatch(JSON.stringify(exported), /review-workbench-operator|2026-06-04/);
});

test("a reviewer id that would read as unattributed, or is not a bounded identifier, is refused at launch", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("attr-invalid") });
  for (const reviewer of [{ id: UNATTRIBUTED_ACTOR_ID, kind: "human" }, { id: "has space", kind: "human" }, { id: "alice", kind: "robot" }]) {
    await assert.rejects(() => openRun(run.runDirectory, { reviewer: reviewer as FieldworkReviewerIdentity }), { code: "INVALID_ARGUMENT" });
  }
});

test("a run decided before server stamping still loads and exports, its decisions marked legacy and not rewritten", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("attr-legacy") });
  const runPath = join(run.runDirectory, "run.json");
  // Exactly what the earlier writer stored: Survey's initial state verbatim,
  // and the client's events saved as posted.
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  const snapshot = initialReviewQueueSessionState(stored.review.snapshot.items as ReviewItem[]);
  assert.equal(snapshot.actorId, "review-workbench-operator");
  stored.review = {
    snapshot,
    events: buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"])),
    }),
    revision: 1,
    snapshotHash: hashReviewQueueSnapshot(snapshot),
  };
  await writeFile(runPath, JSON.stringify(stored, null, 2));
  const before = await readFile(runPath, "utf8");

  const exported = await reviewedExport(run.runDirectory) as unknown as ExportedBundle;
  assert.deepEqual(exported.reviewRound.decisions.map(({ actor, mode }) => ({ actor, mode })), [
    { actor: { id: "review-workbench-operator", kind: "legacy-synthetic-actor" }, mode: undefined },
  ]);
  assert.equal(await readFile(runPath, "utf8"), before);
});

interface StoredEvent {
  metadata: { producer: Record<string, { mode?: string; clientClaimedActorId?: string } | undefined> };
  spec: { eventType: string; reviewItemName?: string; actor: { id: string }; occurredAt: string };
}

/** Accept the first `count` items in one request, as `clientActor` at a fixed client time. */
async function decide(
  runDirectory: string,
  reviewer: FieldworkReviewerIdentity | undefined,
  count: number,
  clientActor = "client-reviewer",
): Promise<StoredEvent[]> {
  const service = await openRun(runDirectory, reviewer === undefined ? {} : { reviewer });
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    assert.ok(snapshot.items.length >= count);
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.slice(0, count).map((item) => [item.metadata.name, "accept-proposed"])),
      actorId: clientActor,
      reviewedAt: CLIENT_TIME,
    });
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as ReviewMutationResponseV1;
    assert.equal(saved.ok, true, JSON.stringify(saved));
    return (saved.ok ? saved.events : []) as unknown as StoredEvent[];
  } finally { await service.close(); }
}
