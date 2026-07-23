import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFieldworkTask } from "../src/contracts.js";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { tempRoot } from "./helpers.js";
import { assertPortableOutput, portablePath, readRun } from "../src/run-store.js";
import { openRun } from "../src/server.js";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { apiFetch } from "./helpers.js";
import { buildReviewSessionEvents } from "@kontourai/survey/review-workbench";

test("task validation rejects projections not declared by Traverse", () => {
  assert.throws(() => parseFieldworkTask({ apiVersion: "fieldwork.kontourai.io/v1alpha1", kind: "FieldworkTask", metadata: { name: "bad" }, spec: { traverse: { version: "1", targetSchema: [{ path: "a", type: "string" }] }, projections: [{ fieldPath: "b", pattern: "b: (.+)", claim: { subjectType: "x", subjectId: "x", facet: "x", claimType: "x", impactLevel: "low" } }] } }));
});

test("task validation rejects duplicate projection field paths before claim binding", () => {
  assert.throws(() => parseFieldworkTask({
    apiVersion: "fieldwork.kontourai.io/v1alpha1",
    kind: "FieldworkTask",
    metadata: { name: "duplicate-field-path" },
    spec: {
      traverse: { version: "1", targetSchema: [{ path: "status", type: "string" }] },
      projections: [
        { fieldPath: "status", pattern: "Earlier: ([^\\n]+)", claim: { subjectType: "record", subjectId: "earlier", facet: "status", claimType: "field", impactLevel: "medium" } },
        { fieldPath: "status", pattern: "Later: ([^\\n]+)", claim: { subjectType: "record", subjectId: "later", facet: "status", claimType: "field", impactLevel: "medium" } }
      ]
    }
  }), /declared more than once/);
});

test("production run rejects duplicate projection field paths before creating artifacts", async () => {
  const fixtureRoot = await tempRoot("duplicate-field-path");
  const runRoot = join(fixtureRoot, "runs");
  const taskPath = join(fixtureRoot, "task.json");
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  task.spec.projections.push({
    ...task.spec.projections[0],
    pattern: "State: ([^\\n]+)",
    claim: { ...task.spec.projections[0].claim, subjectId: "different-subject" }
  });
  await writeFile(taskPath, JSON.stringify(task));
  await mkdir(runRoot);

  await assert.rejects(
    () => runFieldwork({ taskPath, sourcePath: "examples/generic/source.txt", root: runRoot }),
    /Projection record\.status is declared more than once/
  );
  assert.deepEqual(await readdir(runRoot), []);
});

test("deterministic extraction persists exact prepared content and refuses unreviewed export", async () => {
  const result = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("core") });
  const stored = JSON.parse(await readFile(join(result.runDirectory, "run.json"), "utf8"));
  assert.equal(stored.preparedArtifact.contentLength, "Status: Active\n".length);
  await assert.rejects(() => reviewedExport(result.runDirectory), /unresolved-review-item/);
});

test("task digest changes create a distinct run directory and paths cannot escape a root", async () => {
  const root = await tempRoot("identity"), taskPath = `${root}/task.json`;
  const original = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  await writeFile(taskPath, JSON.stringify(original));
  const first = await runFieldwork({ taskPath, sourcePath: "examples/generic/source.txt", root });
  original.spec.projections[0].claim.subjectId = "different-generic-record";
  await writeFile(taskPath, JSON.stringify(original));
  const second = await runFieldwork({ taskPath, sourcePath: "examples/generic/source.txt", root });
  assert.notEqual(first.runDirectory, second.runDirectory);
  assert.throws(() => portablePath(root, `${root}/../outside`), /escapes/);
});

test("identical rerun preserves the valid review log and revision", async () => {
  const root = await tempRoot("rerun");
  const first = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root });
  const server = await openRun(first.runDirectory);
  let count = 0;
  try {
    const initial = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: { [snapshot.items[0].metadata.name]: "accept-proposed" }
    });
    count = events.length;
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 })
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally { await server.close(); }
  const second = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root });
  assert.equal(await realpath(second.runDirectory), await realpath(first.runDirectory));
  const stored = await readRun(second.runDirectory);
  assert.equal(stored.run.review.events.length, count);
  assert.equal(stored.run.review.revision, 1);
});

test("prepared text and mutable run metadata cannot be jointly retargeted away from the Traverse envelope", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("tamper") });
  const runPath = join(run.runDirectory, "run.json");
  const metadata = JSON.parse(await readFile(runPath, "utf8"));
  const replacement = "Status: Inactive\n";
  const digest = (await import("node:crypto")).createHash("sha256").update(replacement).digest("hex");
  metadata.preparedArtifact.digest = digest;
  metadata.preparedArtifact.contentLength = replacement.length;
  await writeFile(runPath, JSON.stringify(metadata));
  await writeFile(join(run.runDirectory, "prepared.txt"), replacement);
  const tamperedMetadata = await readFile(runPath, "utf8");
  await assert.rejects(() => reviewedExport(run.runDirectory), /identity/);
  await assert.rejects(() => runFieldwork({
    taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt",
    root: join(run.runDirectory, "..")
  }), /identity/);
  assert.equal(await readFile(runPath, "utf8"), tamperedMetadata);
});

test("runtime artifacts reject symlinks and unsafe task patterns", async () => {
  const root = await tempRoot("symlink");
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root });
  const prepared = join(run.runDirectory, "prepared.txt"), moved = join(run.runDirectory, "prepared-real.txt");
  await rename(prepared, moved);
  await symlink(moved, prepared);
  await assert.rejects(() => readRun(run.runDirectory), /symbolic link/);
  const original = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  original.spec.projections[0].pattern = "Status: ((a+)+)$";
  assert.throws(() => parseFieldworkTask(original), /unsupported deterministic pattern/);
});

test("persisted Survey state is structurally and semantically validated before serve or export", async () => {
  const structural = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("survey-structural") });
  const structuralPath = join(structural.runDirectory, "run.json");
  const malformed = JSON.parse(await readFile(structuralPath, "utf8"));
  delete malformed.review.snapshot.items[0].spec.candidates[0].source;
  await writeFile(structuralPath, JSON.stringify(malformed));
  await assert.rejects(() => openRun(structural.runDirectory));

  const semantic = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("survey-semantic") });
  const server = await openRun(semantic.runDirectory);
  try {
    const initial = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: { [snapshot.items[0].metadata.name]: "accept-proposed" }
    });
    await apiFetch(server, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 })
    });
  } finally { await server.close(); }
  const semanticPath = join(semantic.runDirectory, "run.json");
  const invalid = JSON.parse(await readFile(semanticPath, "utf8"));
  const decision = invalid.review.events.find((event: { spec: { eventType: string } }) => event.spec.eventType === "decision-changed");
  decision.spec.reviewItemName = "unknown-review-item";
  await writeFile(semanticPath, JSON.stringify(invalid));
  await assert.rejects(() => reviewedExport(semantic.runDirectory));
});

test("portable disclosure scan rejects cross-platform paths and credential values without rejecting resource refs", () => {
  for (const hostile of [
    "/private", "/root/.ssh/id_rsa", "/opt/private", "~/secret.txt", "C:\\Users\\reviewer\\token.txt",
    "\\\\server\\share\\secret.txt", "file:///home/reviewer/private.txt",
    "Bearer abcdefghijklmnop", "api_token=abcdefghijklmnop", "sk-proj-example-secret",
    "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    "github_pat_11AA0_exampleSyntheticToken1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  ]) assert.throws(() => assertPortableOutput({ note: hostile }), /private path|credential/);
  assert.doesNotThrow(() => assertPortableOutput({
    source: "fieldwork-source:v1:generic-record:0123456789abcdef",
    locator: "chars:0-14", subject: "record:generic-1", url: "https://example.invalid/public"
  }));
});

test("hostile Survey review content is refused by reviewed export", async () => {
  const hostileValues = [
    "/private",
    "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
    "github_pat_11AA0_exampleSyntheticToken1234567890",
    "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  ];
  for (const [index, hostile] of hostileValues.entries()) {
    const run = await runFieldwork({
      taskPath: "examples/generic/task.json",
      sourcePath: "examples/generic/source.txt",
      root: await tempRoot(`portable-reviewed-export-${index}`)
    });
    const server = await openRun(run.runDirectory);
    try {
      const initial = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
      const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
      const itemName = snapshot.items[0].metadata.name;
      const events = buildReviewSessionEvents({
        ...snapshot,
        decisionsByItemName: { [itemName]: "accept-proposed" },
        notesByItemName: { [itemName]: hostile }
      });
      const saved = await apiFetch(server, "/api/v1/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 })
      }).then((response) => response.json()) as { ok: boolean };
      assert.equal(saved.ok, true);
    } finally {
      await server.close();
    }
    await assert.rejects(() => reviewedExport(run.runDirectory), /private path|credential/);
  }
});
