import assert from "node:assert/strict";
import test from "node:test";
import { openRun } from "../src/server.js";
import type { FieldworkRunViewV1, ReviewMutationResponseV1 } from "../src/api-contracts.js";
import { runFieldwork, reviewedExport } from "../src/fieldwork.js";
import { inspectionExport } from "../src/inspection.js";
import { persistedReviewSnapshotSchema } from "../src/survey-persistence.js";
import { canonicalJson } from "../src/contracts.js";
import { apiFetch, tempRoot } from "./helpers.js";
import { buildReviewSessionEvents, type ReviewQueueSessionState, type ReviewWorkbenchDecision } from "@kontourai/survey/review-workbench";
import { lstat, mkdir, readFile, rmdir, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

function eventsFor(initial: FieldworkRunViewV1, decision: ReviewWorkbenchDecision, actorId = "test-reviewer") {
  const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
  return buildReviewSessionEvents({
    ...snapshot,
    decisionsByItemName: { [snapshot.items[0].metadata.name]: decision },
    notesByItemName: decision === "could-not-confirm"
      ? { [snapshot.items[0].metadata.name]: "Evidence is insufficient to confirm" }
      : snapshot.notesByItemName,
    reviewedAt: "2026-07-23T00:00:00.000Z",
    actorId
  });
}

async function view(server: Awaited<ReturnType<typeof openRun>>): Promise<FieldworkRunViewV1> {
  return apiFetch(server, "/api/v1/run").then((response) => response.json());
}

async function post(server: Awaited<ReturnType<typeof openRun>>, events: ReturnType<typeof eventsFor>, expectedRevision = 0): Promise<ReviewMutationResponseV1> {
  return apiFetch(server, "/api/v1/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision })
  }).then((response) => response.json());
}

test("loopback API persists a Survey decision and exports after acceptance", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("api") });
  const server = await openRun(run.runDirectory);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
    const initial = await view(server);
    assert.equal(initial.inspector.candidates[0].alignment, "aligned");
    const acceptedEvents = eventsFor(initial, "accept-proposed");
    const accepted = await post(server, acceptedEvents);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const reloaded = await view(server);
    assert.equal(reloaded.review.events.length, acceptedEvents.length);
    const stale = await post(server, acceptedEvents);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "REVIEW_CONFLICT");
    assert.ok(await reviewedExport(run.runDirectory));
  } finally { await server.close(); }
});

test("exports a canonical static inspection artifact with source disclosure off by default", async () => {
  const run = await runFieldwork({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("inspection-export"),
  });
  const safe = await inspectionExport(run.runDirectory);
  assert.match(safe, /ExtractionInspectorExport/);
  assert.match(safe, /preparedTextIncluded":false/);
  assert.match(safe, /\[redacted\]/);
  assert.doesNotMatch(safe, /Status: Active/);
  const disclosed = await inspectionExport(run.runDirectory, {
    includePreparedText: true,
    includeExcerpts: true,
  });
  assert.match(disclosed, /Status: Active/);
});

test("consecutive decisions append without a spurious review conflict", async () => {
  // The browser keeps its own copy of the events it already persisted and posts
  // it back as the append-only prefix. That copy and the stored history describe
  // identical events but are produced by different schemas, so their key order
  // differs. The prefix check must compare content, not serialization.
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("api-append-order"),
  });
  const server = await openRun(run.runDirectory);
  try {
    const snapshot = (await view(server)).review.snapshot as unknown as ReviewQueueSessionState;
    const decisionsFor = (count: number) => Object.fromEntries(
      snapshot.items.slice(0, count).map((item) => [item.metadata.name, "accept-proposed" as const]),
    );
    const eventsAfter = (count: number) => buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: decisionsFor(count),
      reviewedAt: "2026-07-26T00:00:00.000Z",
      actorId: "test-reviewer",
    });
    const submit = async (events: ReturnType<typeof eventsAfter>, expectedEventCount: number, expectedRevision: number) =>
      apiFetch(server, "/api/v1/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, expectedEventCount, expectedRevision }),
      }).then((response) => response.json() as Promise<ReviewMutationResponseV1>);

    const first = eventsAfter(1);
    assert.equal((await submit(first, 0, 0)).ok, true);

    // The hazard this guards is real: the stored history is not byte-identical
    // to what was posted, only content-identical.
    const stored = (await view(server)).review.events;
    assert.notEqual(JSON.stringify(stored), JSON.stringify(first));
    assert.equal(canonicalJson(stored), canonicalJson(first));

    const second = await submit(eventsAfter(2), first.length, 1);
    assert.equal(second.ok, true, JSON.stringify(second));
    if (second.ok) assert.equal(second.revision, 2);

    const third = await submit(eventsAfter(3), second.ok ? second.eventCount : 0, 2);
    assert.equal(third.ok, true, JSON.stringify(third));
  } finally {
    await server.close();
  }
});

test("every declared value type stays decidable through the mounted workbench", async () => {
  // The Review Workbench validates the reviewer's inline edit against
  // spec.valueDescriptor before accepting a proposal, but only renders the
  // editor it reads that edit from when the item is editable. Envelope-imported
  // items are not editable, so a surviving descriptor makes the workbench
  // validate the empty string and refuse every number, date, and boolean field.
  const run = await runFieldwork({
    taskPath: "examples/vendor-obligations/task.json",
    sourcePath: "examples/vendor-obligations/source.txt",
    root: await tempRoot("api-typed-items"),
  });
  const server = await openRun(run.runDirectory);
  try {
    const served = await view(server);
    const task = JSON.parse(await readFile("examples/vendor-obligations/task.json", "utf8")) as {
      spec: { traverse: { targetSchema: Array<{ type: string }> } };
    };
    const declared = new Set(task.spec.traverse.targetSchema.map((field) => field.type));
    assert.ok(declared.has("number") && declared.has("date"),
      "the fixture must declare typed fields for this guard to mean anything");
    for (const source of [served.review.items, served.review.snapshot.items as unknown[]]) {
      for (const item of source as Array<{ spec: { editable?: boolean; valueDescriptor?: unknown } }>) {
        if (item.spec.editable === false) {
          assert.equal(item.spec.valueDescriptor, undefined,
            "a non-editable item must not carry a descriptor the workbench cannot satisfy");
        }
      }
    }
  } finally {
    await server.close();
  }
});

test("accepts a thousand-item Survey snapshot while preserving bounded task projections", async () => {
  const run = await runFieldwork({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("large-snapshot"),
  });
  const server = await openRun(run.runDirectory);
  try {
    const initial = await view(server);
    const snapshot = structuredClone(initial.review.snapshot) as unknown as ReviewQueueSessionState;
    const template = snapshot.items[0]!;
    const items = Array.from({ length: 1_005 }, (_, index) => ({
      ...structuredClone(template),
      metadata: { ...structuredClone(template.metadata), name: `large-item-${index}` },
      spec: { ...structuredClone(template.spec), target: `large.field.${index}` },
    }));
    assert.equal(persistedReviewSnapshotSchema.parse({
      ...snapshot,
      items,
      activeItemName: items[0]!.metadata.name,
    }).items.length, 1_005);
  } finally {
    await server.close();
  }
});

test("two server instances and path aliases serialize one append-only winner", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("race") });
  const leftServer = await openRun(run.runDirectory);
  const rightServer = await openRun(`${run.runDirectory}/.`);
  try {
    const initial = await view(leftServer);
    const leftEvents = eventsFor(initial, "accept-proposed", "left-reviewer");
    const rightEvents = eventsFor(initial, "reject-proposed", "right-reviewer");
    const [left, right] = await Promise.all([post(leftServer, leftEvents), post(rightServer, rightEvents)]);
    assert.equal([left, right].filter((result) => result.ok).length, 1);
    assert.equal([left, right].filter((result) => !result.ok && result.error.code === "REVIEW_CONFLICT").length, 1);
    const stored = await view(leftServer);
    const actors = new Set(stored.review.events.map((event) => event.spec.actor?.id).filter(Boolean));
    assert.equal(actors.size, 1);
    assert.ok(actors.has("left-reviewer") || actors.has("right-reviewer"));
  } finally { await Promise.all([leftServer.close(), rightServer.close()]); }
});

for (const [name, content] of [
  ["empty", ""],
  ["truncated", "{\"pid\":"],
  ["malformed", "not-json"],
  ["dead-owner", JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 60_000 })]
] as const) {
  test(`an old ${name} review lock is safely recovered`, async () => {
    const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot(`lock-${name}`) });
    const lock = join(run.runDirectory, ".review.lock");
    await writeFile(lock, content);
    await utimes(lock, new Date(0), new Date(0));
    const server = await openRun(run.runDirectory);
    try {
      const initial = await view(server);
      const saved = await post(server, eventsFor(initial, "accept-proposed"));
      assert.equal(saved.ok, true, JSON.stringify(saved));
    } finally { await server.close(); }
  });
}

test("lock recovery never follows symlinks or removes a live owner", async () => {
  for (const mode of ["symlink", "live"] as const) {
    const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot(`lock-${mode}`) });
    const lock = join(run.runDirectory, ".review.lock");
    let target: string | undefined;
    if (mode === "symlink") {
      target = join(await tempRoot("lock-target"), "owner.json");
      await writeFile(target, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await symlink(target, lock);
    } else {
      await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }));
      await utimes(lock, new Date(0), new Date(0));
    }
    const server = await openRun(run.runDirectory);
    try {
      const initial = await view(server);
      const result = await post(server, eventsFor(initial, "accept-proposed"));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "REVIEW_BUSY");
      assert.ok(await lstat(lock));
      if (target) assert.match(await readFile(target, "utf8"), /"pid"/);
    } finally {
      await server.close();
      await unlink(lock);
    }
  }
});

test("lock recovery rejects oversized and non-regular lock entries", async () => {
  for (const mode of ["oversized", "directory"] as const) {
    const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot(`lock-${mode}`) });
    const lock = join(run.runDirectory, ".review.lock");
    if (mode === "oversized") await writeFile(lock, "x".repeat(257));
    else await mkdir(lock);
    if (mode === "oversized") await utimes(lock, new Date(0), new Date(0));
    const server = await openRun(run.runDirectory);
    try {
      const initial = await view(server);
      const result = await post(server, eventsFor(initial, "accept-proposed"));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "REVIEW_BUSY");
      assert.ok(await lstat(lock));
    } finally {
      await server.close();
      if (mode === "oversized") await unlink(lock); else await rmdir(lock);
    }
  }
});

test("loopback mutation boundary requires capability, origin, and JSON", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("boundary") });
  const server = await openRun(run.runDirectory);
  try {
    const unauthorized = await fetch(`${server.baseUrl}/api/v1/run`).then((response) => response.json());
    assert.equal(unauthorized.error.code, "CAPABILITY_REQUIRED");
    const wrongOrigin = await fetch(`${server.baseUrl}/api/v1/review`, {
      method: "POST", headers: {
        "x-fieldwork-capability": server.capabilityToken, origin: "http://evil.invalid",
        "content-type": "application/json"
      }, body: "{}"
    }).then((response) => response.json());
    assert.equal(wrongOrigin.error.code, "ORIGIN_REQUIRED");
    const nonJson = await fetch(`${server.baseUrl}/api/v1/review`, {
      method: "POST", headers: {
        "x-fieldwork-capability": server.capabilityToken, origin: server.baseUrl,
        "content-type": "text/plain"
      }, body: "{}"
    }).then((response) => response.json());
    assert.equal(nonJson.error.code, "JSON_REQUIRED");
  } finally { await server.close(); }
});

test("static asset serving rejects symlinks even when their target is a regular file", async () => {
  const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot("asset-boundary") });
  const outside = join(await tempRoot("asset-outside"), "private.js");
  const asset = join(process.cwd(), "dist/browser/assets/fieldwork-symlink-escape.js");
  await mkdir(join(process.cwd(), "dist/browser/assets"), { recursive: true });
  await writeFile(outside, "globalThis.privateValue = true;");
  await symlink(outside, asset);
  const server = await openRun(run.runDirectory);
  try {
    const response = await fetch(`${server.baseUrl}/assets/fieldwork-symlink-escape.js`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
  } finally {
    await server.close();
    await unlink(asset);
  }
});

for (const decision of ["accept-proposed", "keep-current", "reject-proposed", "could-not-confirm"] as const) {
  test(`${decision} survives server persistence and reload`, async () => {
    const run = await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root: await tempRoot(`decision-${decision}`) });
    if (decision === "keep-current") {
      const path = join(run.runDirectory, "run.json");
      const stored = JSON.parse(await readFile(path, "utf8"));
      const proposed = stored.review.snapshot.items[0].spec.candidates[0];
      stored.review.snapshot.items[0].spec.candidates.unshift({ ...proposed, id: `${proposed.id}.current`, role: "current" });
      await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
    }
    const server = await openRun(run.runDirectory);
    try {
      const initial = await view(server);
      const events = eventsFor(initial, decision);
      const saved = await post(server, events);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const reloaded = await view(server);
      const changed = reloaded.review.events.find((event) => event.spec.eventType === "decision-changed");
      assert.equal(changed?.spec.data?.workbenchDecision, decision);
    } finally { await server.close(); }
  });
}
