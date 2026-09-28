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
 * Two chunks of one source state record.status differently. Survey groups
 * proposals by the claim they would state, so the first round raises ONE
 * review item whose candidate set is a `conflict` holding both values. No
 * decision picks one of them: Survey refuses accept-proposed on a set with two
 * proposed candidates, and reject-all and could-not-confirm select none. The
 * export must then state no reviewed value for the field — never the first
 * candidate's — while still recording what the reviewer decided.
 */

interface ExportedClaim {
  readonly id: string;
  readonly fieldOrBehavior: string;
  readonly value: unknown;
  readonly status: string;
  readonly candidateId?: string;
}
interface Exported {
  readonly bundle: { readonly claims: readonly ExportedClaim[] };
  readonly reviewedGrounding: { readonly outcome: string };
  readonly reviewRound: {
    readonly complete: boolean;
    readonly excluded: readonly unknown[];
    readonly decisions: readonly { readonly reviewItemName: string; readonly claimId: string }[];
  };
}

test("two values for one field are one conflict item holding both", async () => {
  const run = await twoValueRun("shape");
  const [item, ...rest] = await queue(run);
  assert.equal(rest.length, 0);
  assert.equal(item!.spec.candidateSetStatus, "conflict");
  assert.deepEqual(item!.spec.candidates.map((candidate) => candidate.value).sort(), ["Active", "Paused"]);
});

test("rejecting every value exports one rejected claim with no value, never the first candidate", async () => {
  const run = await twoValueRun("reject-all");
  const itemName = await decideTheConflict(run, "reject-proposed");
  const exported = await reviewedExport(run) as unknown as Exported;
  const claims = statusClaims(exported);
  assert.deepEqual(claims.map((claim) => [claim.value, claim.status]), [[null, "rejected"]]);
  assert.equal(claims[0]!.candidateId, undefined);
  assertNoValueStated(exported);
  // The per-claim scope still records the decision, on the set-level claim.
  assert.equal(exported.reviewRound.complete, true);
  assert.deepEqual(exported.reviewRound.excluded, []);
  assert.deepEqual(exported.reviewRound.decisions.map((entry) => [entry.reviewItemName, entry.claimId]), [[itemName, claims[0]!.id]]);
  assert.notEqual(exported.reviewedGrounding.outcome, "allowed");
});

test("could-not-confirm on a conflict exports one disputed claim with no value", async () => {
  const run = await twoValueRun("could-not-confirm");
  await decideTheConflict(run, "could-not-confirm");
  const exported = await reviewedExport(run) as unknown as Exported;
  assert.deepEqual(statusClaims(exported).map((claim) => [claim.value, claim.status]), [[null, "disputed"]]);
  assertNoValueStated(exported);
  assert.notEqual(exported.reviewedGrounding.outcome, "allowed");
});

test("accepting a value of a conflict set cannot be recorded, so nothing reads as verified", async () => {
  const run = await twoValueRun("accept");
  await assert.rejects(() => decideTheConflict(run, "accept-proposed"), /cannot choose between them/);
  await assert.rejects(() => reviewedExport(run), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_UNDECIDED");
    return true;
  });
});

function statusClaims(exported: Exported): readonly ExportedClaim[] {
  return exported.bundle.claims.filter((claim) => claim.fieldOrBehavior === "record.status");
}

/** Neither stated value appears as a claim value anywhere in the bundle. */
function assertNoValueStated(exported: Exported): void {
  for (const claim of exported.bundle.claims) assert.ok(claim.value !== "Active" && claim.value !== "Paused", JSON.stringify(claim));
}

async function twoValueRun(label: string): Promise<string> {
  const root = await tempRoot(`two-values-${label}`);
  const sourcePath = join(root, "source.txt");
  // Enough filler that Traverse prepares two chunks, each with its own Status line.
  await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(700)}Status: Paused\n`);
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath, root });
  return run.runDirectory;
}

async function queue(runDirectory: string): Promise<ReviewQueueSessionState["items"]> {
  const server = await openRun(runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    return (view.review.snapshot as unknown as ReviewQueueSessionState).items;
  } finally { await server.close(); }
}

/** Decides the round's one conflict item through the loopback API and returns its name. */
async function decideTheConflict(runDirectory: string, decision: string): Promise<string> {
  const server = await openRun(runDirectory);
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    assert.equal(snapshot.items.length, 1);
    const name = snapshot.items[0]!.metadata.name;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: { [name]: decision },
      // Survey requires a reason for could-not-confirm.
      notesByItemName: decision === "could-not-confirm" ? { [name]: "The two chunks disagree and neither can be confirmed." } : {},
    } as Parameters<typeof buildReviewSessionEvents>[0]);
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true, JSON.stringify(saved));
    return name;
  } finally { await server.close(); }
}
