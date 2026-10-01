// Regenerates this fixture from the published @kontourai/fieldwork@0.13.0
// (Survey 7, Surface 4.4.0, Lookout 0.8.0): it writes runs, decides them
// through that release's loopback API, and records what each exported.
//
//   mkdir /tmp/fw013 && cd /tmp/fw013 && echo '{"type":"module"}' > package.json
//   npm install @kontourai/fieldwork@0.13.0
//   cp <repo>/test/fixtures/fieldwork-0.13.0/generate.mjs . && node generate.mjs <repo>
//
// Run it only to change what the fixture covers: the fixture is stored state an
// older release wrote, so regenerating it with a newer one defeats its purpose.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runFieldwork, openRun, reviewedExport, recheckFieldwork } from "@kontourai/fieldwork";
import { buildReviewSessionEvents } from "@kontourai/survey/review-workbench";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";

const W = process.argv[2];
const FIXTURE = join(W, "test/fixtures/fieldwork-0.13.0");
const OUT = await mkdtemp(join(tmpdir(), "fieldwork-0.13.0-fixture-"));
const runs = {};

async function decide(runDirectory, choose, selected = () => undefined) {
  const service = await openRun(runDirectory);
  try {
    const h = { "x-fieldwork-capability": service.capabilityToken };
    const view = await (await fetch(`${service.baseUrl}/api/v1/run`, { headers: h })).json();
    const snapshot = view.review.snapshot;
    const sel = Object.fromEntries(snapshot.items.flatMap((item) => { const c = selected(item); return c ? [[item.metadata.name, c]] : []; }));
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.flatMap((item, index) => { const d = choose(item, index); return d ? [[item.metadata.name, d]] : []; })),
      ...(Object.keys(sel).length ? { selectedCandidateIdsByItemName: sel } : {}),
    });
    const response = await fetch(`${service.baseUrl}/api/v1/review`, {
      method: "POST", headers: { ...h, origin: service.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: view.review.eventCount ?? 0, expectedRevision: view.review.revision ?? 0 }),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(`decide failed: ${JSON.stringify(body).slice(0, 400)}`);
  } finally { await service.close(); }
}

// 1. generic, accepted
const generic = await runFieldwork({ taskPath: join(W, "examples/generic/task.json"), sourcePath: join(W, "examples/generic/source.txt"), root: join(OUT, "runs") });
await decide(generic.runDirectory, () => "accept-proposed");
runs.generic = generic.runDirectory;

// 2. conflict, one value chosen
const task = JSON.parse(await readFile(join(W, "examples/generic/task.json"), "utf8"));
const [statusProjection] = task.spec.projections;
task.spec.traverse.targetSchema.push({ path: "record.alpha", type: "string", inferenceType: "explicit" });
task.spec.projections.push({ ...statusProjection, fieldPath: "record.alpha", pattern: "alpha: ([^\\n]+)" });
await mkdir(join(OUT, "inputs"), { recursive: true });
await writeFile(join(OUT, "inputs/conflict-task.json"), JSON.stringify(task));
await writeFile(join(OUT, "inputs/conflict-source.txt"), `alpha: alpha-value\nStatus: Active\n${"filler line of text.\n".repeat(700)}Status: Paused\n`);
const conflict = await runFieldwork({ taskPath: join(OUT, "inputs/conflict-task.json"), sourcePath: join(OUT, "inputs/conflict-source.txt"), root: join(OUT, "runs") });
await decide(conflict.runDirectory,
  (item) => item.spec.candidates.filter((c) => c.role === "proposed").length > 1 ? "select-proposed" : "accept-proposed",
  (item) => { const p = item.spec.candidates.filter((c) => c.role === "proposed"); return p.length > 1 ? p.find((c) => c.value === "Paused").id : undefined; });
runs.conflict = conflict.runDirectory;

// 3. vendor obligations from a file, two of seven fields decided: a session a
//    newer release has to be able to continue
const partial = await runFieldwork({ taskPath: join(W, "examples/vendor-obligations/task.json"), sourcePath: join(W, "examples/vendor-obligations/source.txt"), root: join(OUT, "runs") });
await decide(partial.runDirectory, (_item, index) => index < 2 ? "accept-proposed" : undefined);
runs.vendorPartial = partial.runDirectory;

// 4. vendor obligations: decided first round, then a decided recheck round
const snapshotRoot = join(OUT, "snapshots");
const store = createFilesystemSnapshotStore({ root: snapshotRoot });
const vtask = JSON.parse(await readFile(join(W, "examples/vendor-obligations/task.json"), "utf8"));
const snap = (body, fetchedAt) => ({ sourceId: "northstar-renewal-brief", url: "https://example.invalid/vendor-renewal", status: 200, fetchedAt, body,
  bodyHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "text/plain; charset=utf-8" } });
const prior = snap(await readFile(join(W, "examples/vendor-obligations/source.txt"), "utf8"), "2026-07-25T08:00:00.000Z");
const current = snap(await readFile(join(W, "examples/vendor-obligations/source-revised.txt"), "utf8"), "2026-07-25T09:00:00.000Z");
await store.put(prior);
const priorRef = buildSnapshotSourceRef(prior), currentRef = buildSnapshotSourceRef(current);
const first = await runFieldwork({ taskPath: join(W, "examples/vendor-obligations/task.json"), snapshotRef: priorRef, snapshotRoot, root: join(OUT, "runs") });
await decide(first.runDirectory, () => "accept-proposed");
runs.vendorFirst = first.runDirectory;
const recheck = await recheckFieldwork({
  source: { id: "northstar-renewal-brief", url: "https://example.invalid/vendor-renewal", kind: "web-page", cadenceHint: "manual", renderPolicy: "never", targetSchema: vtask.spec.traverse.targetSchema },
  priorRunDirectory: first.runDirectory, taskPath: join(W, "examples/vendor-obligations/task.json"), root: join(OUT, "runs"),
  observationRoot: join(OUT, "observations"), snapshotRoot,
  acquisition: { check: async () => { await store.put(current); return { sourceId: "northstar-renewal-brief", sourceUrl: "https://example.invalid/vendor-renewal", checkedAt: "2026-07-25T09:00:30.000Z", warnings: [], kind: "changed", priorSnapshotRef: priorRef, currentSnapshotRef: currentRef, changeBasis: "hash" }; } },
});
await decide(recheck.run.runDirectory, () => "accept-proposed");
runs.vendorRecheck = recheck.run.runDirectory;

const exports = {};
await rm(join(FIXTURE, "runs"), { recursive: true, force: true });
for (const [name, dir] of Object.entries(runs)) {
  await cp(dir, join(FIXTURE, "runs", basename(dir)), { recursive: true });
  if (name === "vendorPartial") { exports[name] = { runDirectory: basename(dir) }; continue; }
  const value = await reviewedExport(dir);
  exports[name] = {
    runDirectory: basename(dir),
    sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    claims: value.bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.value, claim.status]),
    reviewedGrounding: value.reviewedGrounding.outcome,
  };
}
await writeFile(join(FIXTURE, "exports.json"), `${JSON.stringify(exports, null, 2)}\n`);
await rm(OUT, { recursive: true, force: true });
console.log(Object.keys(exports).join(", "));
