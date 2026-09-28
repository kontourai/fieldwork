import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";

const exec = promisify(execFile);

/*
 * fieldwork#149: the reviewed export used to be all-or-nothing per run, so one
 * contested field blocked every other reviewed claim. Each claim whose item is
 * decided, grounded, projectable and unambiguous now exports; everything else
 * is listed with a typed reason and exports no claim.
 */

interface ExportedBundle {
  bundle: { claims: { fieldOrBehavior: string; value: unknown; status: string }[] };
  reviewRound: {
    kind: string;
    revision: number;
    complete: boolean;
    excluded: { fieldPath: string; itemNames: string[]; code: string }[];
    decisions: { reviewItemName: string }[];
  };
}

const fields = ["alpha", "bravo", "charlie", "delta", "echo"] as const;

/*
 * record.status is stated twice with different values, so Survey raises one
 * conflict item holding both (six items over six fields). No decision selects
 * one of its values: rejecting them all exports a set-level claim with no
 * value, and leaving it undecided excludes it.
 */
const isConflict = (item: { candidateCount: number }) => item.candidateCount > 1;

test("six items over six fields with one conflict set: rejecting it exports five verified claims and one with no value", async () => {
  const run = await sixFieldRun("conflict");
  const items = await queue(run);
  assert.equal(items.length, 6);
  assert.deepEqual(items.filter(isConflict).map((item) => item.fieldPath), ["record.status"]);
  await decide(run, Object.fromEntries(items.map((item) => [item.name, isConflict(item) ? "reject-proposed" : "accept-proposed"])));

  const exported = await reviewedExport(run) as unknown as ExportedBundle;
  assert.deepEqual(exported.bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.status, claim.value]).sort(), [
    ...fields.map((field) => [`record.${field}`, "verified", `${field}-value`]),
    ["record.status", "rejected", null],
  ].sort());
  assert.deepEqual(exported.reviewRound.excluded, []);
  assert.equal(exported.reviewRound.complete, true);
  assert.equal(exported.reviewRound.revision, 1);
  assert.equal(exported.reviewRound.decisions.length, 6);
  assert.doesNotMatch(JSON.stringify(exported.bundle.claims.map((claim) => claim.value)), /Active|Paused/);
});

test("an undecided item is listed as EXPORT_UNDECIDED and never becomes a claim, while the others export", async () => {
  const run = await sixFieldRun("undecided");
  const items = await queue(run);
  const left = items.find((item) => item.fieldPath === "record.echo")!;
  await decide(run, Object.fromEntries(items
    .filter((item) => item !== left)
    .map((item) => [item.name, isConflict(item) ? "reject-proposed" : "accept-proposed"])));

  const exported = await reviewedExport(run) as unknown as ExportedBundle;
  assert.deepEqual(exported.reviewRound.excluded, [{ fieldPath: "record.echo", itemNames: [left.name], code: "EXPORT_UNDECIDED" }]);
  assert.equal(exported.bundle.claims.some((claim) => claim.fieldOrBehavior === "record.echo"), false);
  assert.equal(exported.bundle.claims.length, 5);
  assert.equal(exported.reviewRound.complete, false);
});

test("an undecided conflict set exports no value for that field and lists it", async () => {
  const run = await sixFieldRun("unsettled");
  const items = await queue(run);
  const conflict = items.find(isConflict)!;
  await decide(run, Object.fromEntries(items.filter((item) => item !== conflict).map((item) => [item.name, "accept-proposed"])));

  const exported = await reviewedExport(run) as unknown as ExportedBundle;
  assert.equal(exported.bundle.claims.some((claim) => claim.fieldOrBehavior === "record.status"), false);
  assert.equal(exported.bundle.claims.length, 5);
  assert.deepEqual(exported.reviewRound.excluded, [
    { fieldPath: "record.status", itemNames: [conflict.name], code: "EXPORT_UNDECIDED" },
  ]);
  assert.equal(exported.reviewRound.complete, false);
});

test("excluded is empty and the export complete exactly when every item exported", async () => {
  const run = await sixFieldRun("complete");
  const items = await queue(run);
  await decide(run, Object.fromEntries(items.map((item) => [item.name, isConflict(item) ? "reject-proposed" : "accept-proposed"])));
  const exported = await reviewedExport(run) as unknown as ExportedBundle;
  assert.equal(exported.bundle.claims.length, items.length);
  assert.deepEqual(exported.reviewRound.excluded, []);
  assert.equal(exported.reviewRound.complete, true);
});

test("the CLI writes a partial export but reports what it left out and exits non-zero", async () => {
  const run = await sixFieldRun("cli");
  const items = await queue(run);
  await decide(run, Object.fromEntries(items.filter((item) => !isConflict(item)).map((item) => [item.name, "accept-proposed"])));
  const outputPath = join(run, "..", "export.json");
  await assert.rejects(
    () => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "export", run, "--output", outputPath, "--json"]),
    (error: { code?: number; stdout: string }) => {
      assert.equal(error.code, 3);
      const summary = JSON.parse(error.stdout);
      assert.equal(summary.complete, false);
      assert.deepEqual(summary.excluded.map((entry: { code: string }) => entry.code), ["EXPORT_UNDECIDED"]);
      return true;
    },
  );
  assert.equal((JSON.parse(await readFile(outputPath, "utf8")) as ExportedBundle).bundle.claims.length, 5);
});

async function sixFieldRun(label: string): Promise<string> {
  const root = await tempRoot(`per-claim-${label}`);
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  const [statusProjection] = task.spec.projections;
  task.metadata.name = "six-field-record";
  for (const field of fields) {
    task.spec.traverse.targetSchema.push({ path: `record.${field}`, type: "string", inferenceType: "explicit" });
    task.spec.projections.push({ ...statusProjection, fieldPath: `record.${field}`, pattern: `${field}: ([^\\n]+)` });
  }
  const taskPath = join(root, "task.json");
  const sourcePath = join(root, "source.txt");
  await writeFile(taskPath, JSON.stringify(task));
  // Enough filler that Traverse prepares two chunks, each with its own Status line.
  await writeFile(sourcePath, `${fields.map((field) => `${field}: ${field}-value\n`).join("")}Status: Active\n`
    + `${"filler line of text.\n".repeat(700)}Status: Paused\n`);
  return (await runFieldwork({ taskPath, sourcePath, root })).runDirectory;
}

async function queue(runDirectory: string): Promise<{ name: string; fieldPath: string; candidateCount: number }[]> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    return (view.review.snapshot as unknown as ReviewQueueSessionState).items.map((item) => ({
      name: item.metadata.name,
      fieldPath: item.spec.candidates[0]!.claimTarget.fieldOrBehavior,
      candidateCount: item.spec.candidates.length,
    }));
  } finally { await service.close(); }
}

async function decide(runDirectory: string, decisions: Record<string, string>): Promise<void> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: decisions } as Parameters<typeof buildReviewSessionEvents>[0]);
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true, JSON.stringify(saved));
  } finally { await service.close(); }
}
