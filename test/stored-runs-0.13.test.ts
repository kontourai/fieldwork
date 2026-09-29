import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ReviewSessionEvent } from "@kontourai/survey";
import {
  buildReviewSessionEvents,
  validateReviewSessionEventsForSnapshot,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1, ReviewMutationResponseV1 } from "../src/api-contracts.js";
import { reviewedExport } from "../src/fieldwork.js";
import { readRun } from "../src/run-store.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";

/*
 * Runs written and decided by the published Fieldwork 0.13.0 (Survey 7,
 * Surface 4.4.0, Lookout 0.8.0), regenerated only by `generate.mjs` beside
 * them. Survey 8 refuses an import record without `status.provenance` and
 * replays a decision only under the session conditions its snapshot records;
 * Surface 4.4.1 refuses hidden rivals on Survey 6+ imports with a broken item
 * binding. Stored state an older release wrote has to read, replay, export
 * the same bytes, and accept further decisions under the new ones.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "fieldwork-0.13.0");

interface RecordedExport {
  readonly runDirectory: string;
  readonly sha256?: string;
  readonly claims?: readonly (readonly unknown[])[];
  readonly reviewedGrounding?: string;
}

async function fixtureRuns(label: string): Promise<{ recorded: Record<string, RecordedExport>; directory: (name: string) => string }> {
  const recorded = JSON.parse(await readFile(join(FIXTURE, "exports.json"), "utf8")) as Record<string, RecordedExport>;
  const root = await tempRoot(`stored-0.13-${label}`);
  await cp(join(FIXTURE, "runs"), root, { recursive: true });
  return { recorded, directory: (name) => join(root, recorded[name]!.runDirectory) };
}

test("runs Fieldwork 0.13.0 stored keep their verified import status and replay under Survey 8", async () => {
  const { recorded, directory } = await fixtureRuns("replay");
  assert.deepEqual(Object.keys(recorded).sort(), ["conflict", "generic", "vendorFirst", "vendorPartial", "vendorRecheck"]);
  for (const name of Object.keys(recorded)) {
    const stored = await readRun(directory(name));
    assert.equal(stored.run.extraction?.importStatus.provenance, "verified", `${name} was stored with a verified import`);
    const snapshot = stored.run.review.snapshot as unknown as ReviewQueueSessionState;
    const events = stored.run.review.events as unknown as ReviewSessionEvent[];
    assert.ok(events.some((event) => event.spec.eventType === "decision-changed"), `${name} carries recorded decisions`);
    assert.deepEqual(validateReviewSessionEventsForSnapshot(snapshot, events), [], `${name} replays without issues`);
  }
});

test("runs Fieldwork 0.13.0 exported still export byte-identical", async () => {
  const { recorded, directory } = await fixtureRuns("export");
  for (const [name, expected] of Object.entries(recorded)) {
    if (expected.sha256 === undefined) continue;
    const exported = await reviewedExport(directory(name));
    // The readable parts first, so a difference says what moved.
    assert.deepEqual(exported.bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.value, claim.status]), expected.claims, name);
    assert.equal((exported.reviewedGrounding as { outcome: string }).outcome, expected.reviewedGrounding, name);
    assert.equal(createHash("sha256").update(JSON.stringify(exported)).digest("hex"), expected.sha256, `${name} export bytes`);
  }
});

test("a session Fieldwork 0.13.0 left half decided can be continued and exported", async () => {
  const { directory } = await fixtureRuns("continue");
  const runDirectory = directory("vendorPartial");
  const server = await openRun(runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const storedCount = view.review.events.length;
    assert.ok(storedCount > 0);
    // Survey 8 rebuilds the whole history: the two decisions Survey 7 recorded
    // must come out as the same prefix, then the other five are appended.
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed" as const])),
    });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: storedCount, expectedRevision: view.run.revision }),
    }).then((response) => response.json()) as ReviewMutationResponseV1;
    assert.equal(saved.ok, true, JSON.stringify(saved));
  } finally {
    await server.close();
  }
  const exported = await reviewedExport(runDirectory);
  assert.equal(exported.bundle.claims.length, 7);
  assert.ok(exported.bundle.claims.every((claim) => claim.status === "verified"));
});
