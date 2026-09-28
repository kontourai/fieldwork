import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";

/*
 * Two chunks of one source state record.status differently, so a first round
 * raises two review items for one claim target (fieldwork#137). Only decisions
 * that *accept* two different values contradict each other; a rejected or
 * could-not-confirm item carries its candidate's value but not as a verified
 * claim, so it must not make the round unexportable.
 */

interface ExportedClaim { readonly fieldOrBehavior: string; readonly value: unknown; readonly status: string }

test("accepting one of two values for a field and rejecting the other exports one verified claim", async () => {
  const run = await twoValueRun("accept-reject");
  await decide(run, { Active: "accept-proposed", Paused: "reject-proposed" });
  const claims = await statusClaims(run);
  assert.deepEqual(claims, [["Active", "verified"], ["Paused", "rejected"]]);
});

test("rejecting both values for a field exports with no verified claim for it", async () => {
  const run = await twoValueRun("reject-reject");
  await decide(run, { Active: "reject-proposed", Paused: "reject-proposed" });
  const claims = await statusClaims(run);
  assert.deepEqual(claims, [["Active", "rejected"], ["Paused", "rejected"]]);
});

test("could-not-confirm on both values for a field exports both as proposed", async () => {
  const run = await twoValueRun("could-not-confirm");
  await decide(run, { Active: "could-not-confirm", Paused: "could-not-confirm" });
  const claims = await statusClaims(run);
  assert.deepEqual(claims, [["Active", "proposed"], ["Paused", "proposed"]]);
});

test("accepting two different values for one field is still refused, with advice that can be followed", async () => {
  const run = await twoValueRun("accept-accept");
  await decide(run, { Active: "accept-proposed", Paused: "accept-proposed" });
  await assert.rejects(() => reviewedExport(run), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_CONFLICTING_DECISIONS");
    assert.match(error.message, /accepts two different values for record\.status/);
    assert.match(error.message, /accept at most one value for record\.status/);
    return true;
  });
});

async function statusClaims(runDirectory: string): Promise<[unknown, string][]> {
  const exported = (await reviewedExport(runDirectory)).bundle as unknown as { claims: ExportedClaim[] };
  return exported.claims
    .filter((claim) => claim.fieldOrBehavior === "record.status")
    .map((claim): [unknown, string] => [claim.value, claim.status])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

async function twoValueRun(label: string): Promise<string> {
  const root = await tempRoot(`two-values-${label}`);
  const sourcePath = join(root, "source.txt");
  // Enough filler that Traverse prepares two chunks, each with its own Status line.
  await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(700)}Status: Paused\n`);
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath, root });
  return run.runDirectory;
}

/** Decides each item by the value its proposed candidate carries, through the loopback API. */
async function decide(runDirectory: string, byValue: Record<string, string>): Promise<void> {
  const server = await openRun(runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    assert.deepEqual(
      snapshot.items.map((item) => item.spec.candidates[0]!.value).sort(),
      Object.keys(byValue).sort(),
      "the fixture must raise one item per stated value",
    );
    const decisions = Object.fromEntries(snapshot.items.map((item) =>
      [item.metadata.name, byValue[String(item.spec.candidates[0]!.value)]!]));
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: decisions,
      // Survey requires a reason for could-not-confirm.
      notesByItemName: Object.fromEntries(Object.entries(decisions)
        .filter(([, decision]) => decision === "could-not-confirm")
        .map(([name]) => [name, "The two chunks disagree and neither can be confirmed."])),
    } as Parameters<typeof buildReviewSessionEvents>[0]);
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally { await server.close(); }
}
