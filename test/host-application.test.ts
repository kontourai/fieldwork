import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  buildReviewSessionEvents,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import {
  createFieldworkApplication,
  fieldworkHostPresentationSchema,
  type FieldworkLifecycleEventV1,
} from "../src/index.js";
import { apiFetch, tempRoot } from "./helpers.js";

test("the application contract launches, presents, observes, and returns one reviewed run", async () => {
  const application = createFieldworkApplication();
  const lifecycle: FieldworkLifecycleEventV1[] = [];
  application.subscribe((event) => lifecycle.push(event));
  application.subscribe(() => { throw new Error("observer failure must be isolated"); });
  const run = await application.run({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("host-application"),
  });
  const presentation = fieldworkHostPresentationSchema.parse({
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkHostPresentation",
    eyebrow: "Station",
    title: "Evidence review",
    theme: "dark",
    navigation: [{ label: "Task", href: "https://station.kontourai.io/tasks/fixture" }],
    returnAction: { label: "Return to Station", href: "https://station.kontourai.io/" },
  });
  const service = await application.open({ runDirectory: run.runDirectory, presentation });
  const sessionLifecycle: FieldworkLifecycleEventV1[] = [];
  service.subscribe((event) => sessionLifecycle.push(event));
  try {
    assert.deepEqual(await apiFetch(service, "/api/v1/host").then((response) => response.json()), presentation);
    const selected = await service.view();
    assert.equal(selected.run.resource, run.runResource);
    const snapshot = selected.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: { [snapshot.items[0]!.metadata.name]: "accept-proposed" },
      reviewedAt: "2026-07-23T00:00:00.000Z",
      actorId: "host-contract-test",
    });
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json());
    assert.equal(saved.ok, true);
    const output = await application.reviewedOutput(run.runDirectory);
    assert.ok(Array.isArray(output.claims));
    assert.deepEqual(sessionLifecycle.map((event) => event.type), ["review-event-persisted"]);
  } finally {
    await service.close();
    await application.close();
  }
  assert.deepEqual(lifecycle.map((event) => event.type), [
    "run-created",
    "run-opened",
    "review-event-persisted",
    "review-exported",
    "run-closed",
  ]);
  assert.deepEqual(lifecycle.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.ok(lifecycle.every((event) => event.runResource === run.runResource));
});

test("host presentation accepts bounded HTTP navigation and rejects executable URLs", () => {
  const base = {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkHostPresentation",
    eyebrow: "Host",
    title: "Review",
    theme: "light",
  } as const;
  assert.equal(fieldworkHostPresentationSchema.safeParse({
    ...base,
    navigation: [{ label: "Home", href: "https://example.invalid/" }],
  }).success, true);
  assert.equal(fieldworkHostPresentationSchema.safeParse({
    ...base,
    navigation: [{ label: "Unsafe", href: "javascript:alert(1)" }],
  }).success, false);
});

test("an authorized host lists, describes, and inspects only a reviewed exact web source", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-reviewed-source-snapshots-"));
  const runRoot = await tempRoot("reviewed-source-run");
  const body = "<main><p>Status: Active</p></main>";
  const snapshot = { sourceId: "reviewed-source", url: "https://example.test/status", status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "text/html" } };
  await createFilesystemSnapshotStore({ root: snapshotRoot }).put(snapshot);
  const ref = buildSnapshotSourceRef(snapshot);
  const initial = createFieldworkApplication();
  const run = await initial.run({ taskPath: "examples/generic/task.json", snapshotRef: ref, snapshotRoot, root: runRoot });
  const server = await initial.open({ runDirectory: run.runDirectory });
  try {
    const view = await server.view();
    const state = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({ ...state, decisionsByItemName: { [state.items[0]!.metadata.name]: "accept-proposed" }, reviewedAt: "2026-08-26T00:00:00.000Z", actorId: "reviewed-source-test" });
    assert.equal((await apiFetch(server, "/api/v1/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }) })).status, 200);
  } finally { await server.close(); await initial.close(); }
  const calls: string[] = [];
  const application = createFieldworkApplication({ reviewedWebSourceOwner: { runDirectory: run.runDirectory, snapshotRoot, authorize: ({ operation }) => { calls.push(operation); return true; } } });
  const listed = await application.listReviewedWebSourceRefs();
  assert.equal(listed.status, "available");
  assert.equal(listed.refs.length, 1);
  const exactRef = listed.refs[0]!;
  const described = await application.describeReviewedWebSource(exactRef);
  assert.equal(described.status, "available");
  if (described.status === "available") {
    assert.equal(described.integrity.state, "unchecked");
    assert.deepEqual(Object.keys(described.preparedArtifact).sort(), ["contentLength", "digest", "ref"]);
    assert.equal("file" in described.preparedArtifact, false, "storage filenames are never part of the public DTO");
  }
  const inspected = await application.inspectReviewedWebSource(exactRef);
  assert.equal(inspected.status, "available");
  if (inspected.status === "available") assert.match(inspected.pages[0]!.text, /Status: Active/);
  assert.ok(calls.filter((operation) => operation === "list").length >= 2);
  assert.ok(calls.filter((operation) => operation === "inspect").length >= 2);
  await application.close();
});

test("reviewed web-source owner reads are total and do not expose a missing owner path", async () => {
  const missing = join(await tempRoot("reviewed-source-missing"), "does-not-exist");
  const application = createFieldworkApplication({
    reviewedWebSourceOwner: { runDirectory: missing, snapshotRoot: missing, authorize: () => true },
  });
  const ref = "fieldwork-reviewed-source:v1:" + "0".repeat(64);
  const result = await application.describeReviewedWebSource(ref);
  assert.deepEqual(result, {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status: "missing",
  });
  await application.close();
});

test("host embedding is exact-origin opt-in and deny-by-default", async () => {
  const application = createFieldworkApplication();
  const run = await application.run({
    taskPath: "examples/generic/task.json",
    sourcePath: "examples/generic/source.txt",
    root: await tempRoot("host-embedding"),
  });
  const denied = await application.open({ runDirectory: run.runDirectory });
  try {
    const policy = (await fetch(denied.url)).headers.get("content-security-policy");
    assert.match(policy ?? "", /frame-ancestors 'none'(?:;|$)/);
  } finally {
    await denied.close();
  }

  const allowed = await application.open({
    runDirectory: run.runDirectory,
    embeddingOrigin: "https://station.example:8443",
  });
  try {
    const policy = (await fetch(allowed.url)).headers.get("content-security-policy");
    assert.match(policy ?? "", /frame-ancestors https:\/\/station\.example:8443(?:;|$)/);
  } finally {
    await allowed.close();
  }

  for (const embeddingOrigin of [
    "javascript:alert(1)",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com/?query=1",
    "https://example.com/#fragment",
    "https://*.example.com",
    "https://example.com;frame-src",
    "https://example.com,https",
    "https://exa_mple.com",
  ]) {
    await assert.rejects(
      application.open({ runDirectory: run.runDirectory, embeddingOrigin }),
      /absolute HTTP\(S\) origin|concrete DNS name or IP address/,
    );
  }
  await application.close();
});
