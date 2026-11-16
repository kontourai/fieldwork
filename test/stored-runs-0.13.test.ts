import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ReviewSessionEvent } from "@kontourai/survey";
import {
  buildReviewSessionEvents, buildReviewSessionEvent,
  validateReviewSessionEventsForSnapshot,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1, ReviewMutationResponseV1 } from "../src/api-contracts.js";
import { reviewedExport, historicalReviewedExport, upgradeRun, runFieldwork } from "../src/fieldwork.js";
import { currentReviewFence, readRun, withRunReviewLock } from "../src/run-store.js";
import { openRun } from "../src/server.js";
import { memoryClaimsFromReviewedExport } from "../src/memory-source.js";
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
  const original = await readFile(join(runDirectory, "run.json"));
  const partial = await reviewedExport(runDirectory);
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
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.error.code, "RUN_UPGRADE_REQUIRED");
    assert.deepEqual(await readFile(join(runDirectory, "run.json")), original);
    await upgradeRun(runDirectory);
    assert.deepEqual(await readFile(join(runDirectory, "legacy-run-v1.json")), original);
    const upgraded = await readRun(runDirectory);
    assert.equal(upgraded.run.schemaVersion, 2);
    assert.deepEqual(await historicalReviewedExport(runDirectory, { legacyRevision: view.run.revision }), partial);
    const continued = await apiFetch(server, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: storedCount, expectedRevision: view.run.revision }),
    }).then((response) => response.json()) as ReviewMutationResponseV1;
    assert.equal(continued.ok, true, JSON.stringify(continued));
  } finally {
    await server.close();
  }
  const exported = await reviewedExport(runDirectory);
  assert.equal(exported.apiVersion, "fieldwork.kontourai.io/v2");
  assert.equal(exported.bundle.claims.length, 7);
  assert.ok(exported.bundle.claims.every((claim) => claim.status === "verified"));
});

test("upgraded runs refuse changed historical snapshots and unknown profiles", async () => {
  const { directory } = await fixtureRuns("invalid-upgrade");
  const runDirectory = directory("vendorPartial");
  await upgradeRun(runDirectory);
  const recordPath = join(runDirectory, "run.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, JSON.stringify({ ...record, exportProfile: "unknown" }));
  await assert.rejects(readRun(runDirectory));
  await writeFile(recordPath, JSON.stringify(record));
  await unlink(join(runDirectory, "legacy-run-v1.json"));
  await symlink("run.json", join(runDirectory, "legacy-run-v1.json"));
  await assert.rejects(readRun(runDirectory), /symbolic link/);
  await unlink(join(runDirectory, "legacy-run-v1.json"));
  await writeFile(join(runDirectory, "legacy-run-v1.json"), "{}");
  await assert.rejects(readRun(runDirectory), /digest mismatch/);
  await assert.rejects(historicalReviewedExport(runDirectory, { legacyRevision: record.legacyOrigin.revision }));
});

test("v2 memory projection refuses missing or altered Survey verification", async () => {
  const { directory } = await fixtureRuns("policy");
  const runDirectory = directory("generic");
  await upgradeRun(runDirectory);
  const output = await reviewedExport(runDirectory);
  assert.equal(output.apiVersion, "fieldwork.kontourai.io/v2");
  memoryClaimsFromReviewedExport(output);
  const clone = () => structuredClone(output) as any;
  const missingPolicy = clone();
  missingPolicy.bundle.policies = [];
  assert.throws(() => memoryClaimsFromReviewedExport(missingPolicy));
  const alteredPolicy = clone();
  alteredPolicy.bundle.policies.find((policy: any) => policy.id === "survey.review-outcome.v1").requiredMethods = [];
  assert.throws(() => memoryClaimsFromReviewedExport(alteredPolicy));
  const missingClaimPolicy = clone();
  delete missingClaimPolicy.bundle.claims[0].verificationPolicyId;
  assert.throws(() => memoryClaimsFromReviewedExport(missingClaimPolicy));
  const noAttestations = clone();
  noAttestations.bundle.evidence = noAttestations.bundle.evidence.filter((evidence: any) => evidence.method !== "attestation");
  assert.throws(() => memoryClaimsFromReviewedExport(noAttestations));
  const mismatchedAttestation = clone();
  mismatchedAttestation.bundle.evidence.find((evidence: any) => evidence.method === "attestation").sourceRef = "survey:review-outcome:other";
  assert.throws(() => memoryClaimsFromReviewedExport(mismatchedAttestation));
  const missingReferences = clone();
  const attestationIds = new Set(missingReferences.bundle.evidence.filter((evidence: any) => evidence.method === "attestation").map((evidence: any) => evidence.id));
  for (const event of missingReferences.bundle.events) event.evidenceIds = (event.evidenceIds ?? []).filter((id: string) => !attestationIds.has(id));
  assert.throws(() => memoryClaimsFromReviewedExport(missingReferences));
});

test("new runs bind the v2 profile and cannot export a historical v1 snapshot", async () => {
  const root = await tempRoot("profile-new");
  const options = { taskPath: "examples/schema-first/task.json", sourcePath: "examples/schema-first/source.txt", root };
  const first = await runFieldwork(options);
  const second = await runFieldwork(options);
  assert.equal(first.runResource, second.runResource);
  const stored = await readRun(first.runDirectory);
  assert.equal(stored.run.schemaVersion, 2);
  assert.equal(stored.run.exportProfile, "fieldwork.reviewed-export.v2/survey9");
  await assert.rejects(historicalReviewedExport(first.runDirectory, { legacyRevision: 0 }));
  const recordPath = join(first.runDirectory, "run.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  delete record.exportProfile;
  await writeFile(recordPath, JSON.stringify(record));
  await assert.rejects(readRun(first.runDirectory));
});

test("a conflicting or symlinked pre-existing attachment leaves v1 authoritative", async () => {
  const { directory } = await fixtureRuns("upgrade-conflict");
  const runDirectory = directory("vendorPartial");
  const before = await readFile(join(runDirectory, "run.json"));
  const attachment = join(runDirectory, "legacy-run-v1.json");
  await writeFile(attachment, "different");
  await assert.rejects(upgradeRun(runDirectory), /Conflicting legacy snapshot/);
  assert.deepEqual(await readFile(join(runDirectory, "run.json")), before);
  assert.equal((await readRun(runDirectory)).run.schemaVersion, 1);
  await unlink(attachment);
  await symlink("run.json", attachment);
  await assert.rejects(upgradeRun(runDirectory), /symbolic link/);
  assert.deepEqual(await readFile(join(runDirectory, "run.json")), before);
});

test("upgrade cannot publish while another review operation holds the run lock", async () => {
  const { directory } = await fixtureRuns("upgrade-lock");
  const runDirectory = directory("vendorPartial");
  const original = await readFile(join(runDirectory, "run.json"));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const operation = withRunReviewLock(runDirectory, async () => { entered(); await held; });
  await ready;
  try {
    await assert.rejects(upgradeRun(runDirectory), { code: "REVIEW_BUSY" });
    assert.deepEqual(await readFile(join(runDirectory, "run.json")), original);
  } finally {
    release();
    await operation;
  }
  await upgradeRun(runDirectory);
  assert.equal((await readRun(runDirectory)).run.schemaVersion, 2);
});

test("a review append racing upgrade is refused before upgrade or committed with host authority after it", async () => {
  const { directory } = await fixtureRuns("upgrade-append-race");
  const runDirectory = directory("vendorPartial");
  const original = await readFile(join(runDirectory, "run.json"));
  const server = await openRun(runDirectory, { reviewer: { id: "alice", kind: "human" } });
  try {
    const view = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed" as const])) });
    const [_, result] = await Promise.all([
      upgradeRun(runDirectory),
      apiFetch(server, "/api/v1/review", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, expectedEventCount: view.review.events.length, expectedRevision: view.run.revision }) }).then((response) => response.json()) as Promise<ReviewMutationResponseV1>,
    ]);
    assert.deepEqual(await readFile(join(runDirectory, "legacy-run-v1.json")), original);
    const stored = await readRun(runDirectory);
    assert.equal(stored.run.schemaVersion, 2);
    assert.deepEqual(stored.run.review.events.slice(0, view.review.events.length), view.review.events);
    if (result.ok) {
      assert.ok(stored.run.review.events.length > view.review.events.length);
      const exported = await reviewedExport(runDirectory);
      const decisions = exported.reviewRound.decisions as { actor: { id: string; kind: string } }[];
      assert.ok(decisions.some((entry) => entry.actor.id === "alice" && entry.actor.kind === "human"));
    } else {
      assert.equal(result.error.code, "RUN_UPGRADE_REQUIRED");
      assert.equal(stored.run.review.events.length, view.review.events.length);
    }
  } finally { await server.close(); }
});

for (const target of ["run.json", "legacy-run-v1.json"] as const) {
  test(`the final review fence refuses a FIFO at ${target} without blocking`, { skip: process.platform === "win32" }, async () => {
    const { directory } = await fixtureRuns("fence-fifo");
    const runDirectory = directory("vendorPartial");
    await upgradeRun(runDirectory);
    const stored = await readRun(runDirectory);
    assert.equal(currentReviewFence(runDirectory, stored.run), true, "the real upgraded record and sidecar pass the fence");
    const path = join(runDirectory, target);
    await unlink(path);
    await promisify(execFile)("mkfifo", [path]);
    const program = `import { currentReviewFence } from "./src/run-store.ts"; console.log(currentReviewFence(process.argv[1], JSON.parse(process.argv[2])));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, runDirectory, JSON.stringify(stored.run)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2000);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.equal(timedOut, false, `child was killed and reaped after FIFO open blocked: ${JSON.stringify(result)} ${errors}`);
    assert.equal(result.code, 0, errors);
    assert.equal(output.trim(), "false");
  });
}

test("upgrade resumes when a crash left the exact historical sidecar before record publication", async () => {
  const { directory } = await fixtureRuns("upgrade-sidecar-recovery");
  const runDirectory = directory("vendorPartial");
  const original = await readFile(join(runDirectory, "run.json"));
  const historical = await reviewedExport(runDirectory);
  await writeFile(join(runDirectory, "legacy-run-v1.json"), original, { flag: "wx" });
  assert.equal((await readRun(runDirectory)).run.schemaVersion, 1);
  await upgradeRun(runDirectory);
  const upgraded = await readRun(runDirectory);
  assert.equal(upgraded.run.schemaVersion, 2);
  assert.deepEqual(await readFile(join(runDirectory, "legacy-run-v1.json")), original);
  assert.deepEqual(await historicalReviewedExport(runDirectory, { legacyRevision: upgraded.run.legacyOrigin!.revision }), historical);
});

for (const mode of ["notes-only", "cleared-decision"] as const) {
  test(`upgrade accepts a valid ${mode} legacy review without exporting a receipt`, async () => {
    const { directory } = await fixtureRuns(`unfinished-${mode}`);
    const runDirectory = directory("generic");
    const path = join(runDirectory, "run.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    const snapshot = record.review.snapshot as ReviewQueueSessionState;
    const itemName = snapshot.items[0]!.metadata.name;
    const session = { ...snapshot, notesByItemName: { [itemName]: "Review later" }, decisionsByItemName: {} };
    const events = mode === "notes-only" ? buildReviewSessionEvents(session)
      : (() => {
          const decided = buildReviewSessionEvents({ ...session, decisionsByItemName: { [itemName]: "accept-proposed" } });
          return [...decided, buildReviewSessionEvent(session, {
            sessionName: decided[0]!.spec.sessionName, sequence: decided.length + 1,
            eventType: "decision-changed", occurredAt: session.reviewedAt, reviewItemName: itemName,
            data: { workbenchDecision: null },
          })];
        })();
    record.review.events = events;
    record.review.revision = 1;
    await writeFile(path, JSON.stringify(record));
    await readRun(runDirectory);
    await assert.rejects(reviewedExport(runDirectory), { code: "EXPORT_UNDECIDED" });
    await upgradeRun(runDirectory);
    assert.equal((await readRun(runDirectory)).run.schemaVersion, 2);
    await assert.rejects(reviewedExport(runDirectory), { code: "EXPORT_UNDECIDED" });
  });
}

for (const mutation of ["inference", "time", "outcome"] as const) test(`v2 rejects consistent ${mutation} mutations`, async () => {
  const { directory } = await fixtureRuns("duplicated-review-mutation");
  const runDirectory = directory("generic");
  await upgradeRun(runDirectory);
  const output = await reviewedExport(runDirectory);
  memoryClaimsFromReviewedExport(output);
  const inference = structuredClone(output) as any;
  const claim = inference.bundle.claims.find((entry: any) => entry.status === "verified");
  const attestation = inference.bundle.evidence.find((entry: any) => entry.claimId === claim.id && entry.method === "attestation");
  assert.equal(claim.metadata.survey.reviewerKindInferred, true);
  claim.metadata.survey.reviewerKindInferred = false;
  attestation.metadata.reviewerKindInferred = false;
  if (mutation === "inference") return assert.throws(() => memoryClaimsFromReviewedExport(inference));
  if (mutation === "outcome") {
    const altered = structuredClone(output) as any;
    const alteredClaim = altered.bundle.claims.find((entry: any) => entry.status === "verified");
    const alteredAttestation = altered.bundle.evidence.find((entry: any) => entry.claimId === alteredClaim.id && entry.method === "attestation");
    alteredClaim.metadata.survey.reviewOutcomeId = "forged-outcome";
    alteredAttestation.metadata.reviewOutcomeId = "forged-outcome";
    alteredAttestation.sourceRef = "survey:review-outcome:forged-outcome";
    return assert.throws(() => memoryClaimsFromReviewedExport(altered));
  }
  const time = structuredClone(output) as any;
  const changedClaim = time.bundle.claims.find((entry: any) => entry.status === "verified");
  const changedAttestation = time.bundle.evidence.find((entry: any) => entry.claimId === changedClaim.id && entry.method === "attestation");
  const event = time.bundle.events.find((entry: any) => entry.claimId === changedClaim.id && entry.status === "verified");
  changedAttestation.observedAt = "2030-01-01T00:00:00.000Z";
  event.createdAt = changedAttestation.observedAt;
  assert.throws(() => memoryClaimsFromReviewedExport(time));
});
