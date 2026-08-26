import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { restoreReviewedExtractionEvidence } from "@kontourai/surface";
import { parseReviewedWebSourceDescriptor, parseReviewedWebSourceInspection, parseReviewedWebSourceRefs } from "../src/reviewed-web-source-contract.js";
import {
  buildReviewSessionEvent,
  buildReviewSessionEvents,
  defaultReviewSessionName,
  type ReviewQueueSessionState,
} from "@kontourai/survey/review-workbench";
import {
  createFieldworkApplication,
  fieldworkHostPresentationSchema,
  type FieldworkLifecycleEventV1,
} from "../src/index.js";
import { apiFetch, tempRoot } from "./helpers.js";

test("the browser-safe reviewed-source contract rejects untrusted versions and opaque extras", () => {
  assert.throws(() => parseReviewedWebSourceDescriptor({
    apiVersion: "fieldwork.kontourai.io/v2", kind: "ReviewedWebSourceDescriptor", status: "missing",
  }));
  assert.throws(() => parseReviewedWebSourceDescriptor({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status: "restricted", rawBundle: "private",
  }));
  assert.throws(() => parseReviewedWebSourceDescriptor({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status: "available", exactRef: "fieldwork-reviewed-source:v1:" + "0".repeat(64), runResource: "run", captureRef: "capture", preparedArtifact: { ref: "prepared", digest: "0".repeat(64), contentLength: 1 }, review: { revision: 0, state: "reviewed" }, evidence: { id: "e", claimId: "c", proposalIndex: 0, import: { name: "i" }, candidate: { id: "candidate" }, reviewItem: { name: "item" }, reviewDecision: { name: "decision" }, locator: { scheme: "forged", locator: "chars:100-200", occurrence: { index: 0, count: 1, start: 0, end: 1 } } }, integrity: { state: "unchecked" }, inspection: { pageChars: 16_384, maxPages: 8 },
  }));
  assert.throws(() => parseReviewedWebSourceInspection({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef: "fieldwork-reviewed-source:v1:" + "0".repeat(64), integrity: "verified", pages: [{ index: 99, start: 100, end: 1, text: "unrelated" }], totalPages: 0, truncated: false, nextCursor: "0" }));
  assert.throws(() => parseReviewedWebSourceInspection({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef: "fieldwork-reviewed-source:v1:" + "0".repeat(64), integrity: "verified", pages: [{ index: 0, start: 0, end: 16_384, text: "x".repeat(16_384) }], totalPages: 2, truncated: true, nextCursor: "0" }));
  assert.throws(() => parseReviewedWebSourceInspection({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef: "fieldwork-reviewed-source:v1:" + "0".repeat(64), integrity: "verified", pages: [], totalPages: 0, truncated: true, nextCursor: "0" }));
  assert.throws(() => parseReviewedWebSourceInspection({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef: "fieldwork-reviewed-source:v1:" + "0".repeat(64), integrity: "verified", pages: [{ index: 0, start: 0, end: 1, text: "x" }, { index: 1, start: 16_384, end: 16_385, text: "y" }], totalPages: 2, truncated: false }));
  assert.throws(() => parseReviewedWebSourceRefs({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceRefs", status: "available", refs: ["fieldwork-reviewed-source:v1:" + "0".repeat(64), "fieldwork-reviewed-source:v1:" + "0".repeat(64)], truncated: false, nextCursor: "0" }));
  assert.throws(() => parseReviewedWebSourceRefs({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceRefs", status: "available", refs: [], truncated: true, nextCursor: "0" }));
  assert.equal(parseReviewedWebSourceInspection({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef: "fieldwork-reviewed-source:v1:" + "0".repeat(64), integrity: "verified", pages: [{ index: 127, start: 127 * 16_384, end: 128 * 16_384, text: "x".repeat(16_384) }], totalPages: 128, truncated: false }).status, "available");
});

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
  const body = `Status: Active\n${"x".repeat(9 * 16_384)}tail`;
  const snapshot = { sourceId: "reviewed-source", url: `https://example.test/${"a".repeat(500)}`, status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "text/plain" } };
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
  assert.deepEqual(parseReviewedWebSourceRefs(listed), listed);
  assert.equal(listed.refs.length, 1);
  const exactRef = listed.refs[0]!;
  const described = await application.describeReviewedWebSource(exactRef);
  assert.equal(described.status, "available");
  if (described.status === "available") {
    assert.equal(described.integrity.state, "unchecked");
    assert.ok(described.captureRef.length > 512, "an owner-supported exact capture ref is not constrained like an internal ID");
    assert.deepEqual(Object.keys(described.preparedArtifact).sort(), ["contentLength", "digest", "ref"]);
    assert.equal("file" in described.preparedArtifact, false, "storage filenames are never part of the public DTO");
    const exported = await initial.reviewedOutput(run.runDirectory) as { evidence: Parameters<typeof restoreReviewedExtractionEvidence>[0][] };
    const ownerEvidence = exported.evidence
      .filter((entry) => (entry as { metadata?: { reviewedExtraction?: unknown } }).metadata?.reviewedExtraction)
      .map((entry) => ({ entry, restored: restoreReviewedExtractionEvidence(entry) }))
      .find(({ restored }) => restored.proposalIndex === described.evidence.proposalIndex);
    assert.ok(ownerEvidence, "the descriptor must carry an actual owner-exported evidence/claim join");
    assert.equal(described.evidence.id, ownerEvidence.entry.id);
    assert.equal(described.evidence.claimId, ownerEvidence.restored.claimId);
    assert.equal(described.evidence.candidate.id, ownerEvidence.restored.reviewItem?.spec.candidates[0]?.id);
    assert.equal(described.evidence.reviewItem.name, ownerEvidence.restored.reviewItem?.metadata.name);
    assert.equal(described.evidence.reviewDecision.name, ownerEvidence.restored.reviewDecision?.metadata.name);
    assert.equal("excerpt" in described.evidence, false);
    assert.equal("value" in described.evidence, false);
    assert.deepEqual(parseReviewedWebSourceDescriptor(described), described, "the owner never emits a descriptor its published parser rejects");
    assert.throws(() => parseReviewedWebSourceDescriptor({ ...described, evidence: { ...described.evidence, locator: { ...described.evidence.locator, locator: `chars:0-${described.preparedArtifact.contentLength + 1}`, occurrence: { ...described.evidence.locator.occurrence, start: 0, end: described.preparedArtifact.contentLength + 1 } } } }));
  }
  const inspected = await application.inspectReviewedWebSource(exactRef);
  assert.equal(inspected.status, "available");
  if (inspected.status === "available") {
    assert.match(inspected.pages[0]!.text, /Status: Active/);
    assert.equal(inspected.truncated, true, "the first bounded owner page advertises its exact continuation");
    assert.equal(inspected.nextCursor, "8");
  }
  assert.deepEqual(parseReviewedWebSourceInspection(inspected), inspected);
  const continued = await application.inspectReviewedWebSource(exactRef, "8");
  assert.equal(continued.status, "available");
  if (continued.status === "available") {
    assert.equal(continued.truncated, false);
    assert.equal(continued.pages.length, 2);
    assert.ok(continued.pages.at(-1)!.text.length < 16_384, "the final page is the genuine partial remainder");
  }
  assert.deepEqual(parseReviewedWebSourceInspection(continued), continued);
  assert.throws(() => parseReviewedWebSourceInspection({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef, integrity: "verified", pages: [], totalPages: 129, truncated: false }));
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

test("reviewed web sources bind each opaque occurrence and close every final authorization race", async () => {
  const fixture = await reviewedSourceFixture();
  try {
    const owner = createFieldworkApplication({ reviewedWebSourceOwner: { runDirectory: fixture.run.runDirectory, snapshotRoot: fixture.snapshotRoot, authorize: () => true } });
    const listed = await owner.listReviewedWebSourceRefs();
    assert.equal(listed.status, "available");
    if (listed.status !== "available") return;
    assert.equal(listed.refs.length, 2, "two otherwise-identical excerpts retain distinct opaque occurrences");
    const [first, second] = listed.refs;
    await appendRejectedDecision(fixture);
    const after = await owner.listReviewedWebSourceRefs();
    assert.deepEqual(after.status === "available" ? after.refs : [], [first], "rejecting one duplicate cannot publish its sibling");
    assert.equal((await owner.inspectReviewedWebSource(second!)).status, "missing");
    await owner.close();
  } finally { await fixture.close(); }

  for (const operation of ["list", "describe", "inspect"] as const) {
    const raced = await reviewedSourceFixture();
    try {
      let calls = 0;
      const reader = createFieldworkApplication({ reviewedWebSourceOwner: {
        runDirectory: raced.run.runDirectory, snapshotRoot: raced.snapshotRoot,
        authorize: async () => {
          if (++calls === 2) await appendRejectedDecision(raced);
          return true;
        },
      } });
      const refs = await createFieldworkApplication({ reviewedWebSourceOwner: { runDirectory: raced.run.runDirectory, snapshotRoot: raced.snapshotRoot, authorize: () => true } }).listReviewedWebSourceRefs();
      assert.equal(refs.status, "available");
      const exactRef = refs.status === "available" ? refs.refs[0]! : "";
      const result = operation === "list" ? await reader.listReviewedWebSourceRefs()
        : operation === "describe" ? await reader.describeReviewedWebSource(exactRef)
          : await reader.inspectReviewedWebSource(exactRef);
      assert.notEqual(result.status, "available", `${operation} must not publish the review state observed before final authorization`);
      await reader.close();
    } finally { await raced.close(); }
  }
});

test("reviewed source metadata stays closed and authorization failures never escape", async () => {
  const fixture = await reviewedSourceFixture();
  try {
    const publicReader = createFieldworkApplication({ reviewedWebSourceOwner: { runDirectory: fixture.run.runDirectory, snapshotRoot: fixture.snapshotRoot, authorize: () => true } });
    const refs = await publicReader.listReviewedWebSourceRefs();
    assert.equal(refs.status, "available");
    if (refs.status !== "available") return;
    const preparedPath = join(fixture.run.runDirectory, "prepared.txt");
    const prepared = await readFile(preparedPath);
    await unlink(preparedPath);
    const snapshotRecord = (await readdir(fixture.snapshotRoot, { recursive: true })).find((entry) => entry.endsWith(".json") && !entry.includes("identity-index"));
    assert.ok(snapshotRecord);
    await unlink(join(fixture.snapshotRoot, snapshotRecord!));
    const described = await publicReader.describeReviewedWebSource(refs.refs[0]!);
    assert.equal(described.status, "available", "metadata-only listing and description read neither prepared nor snapshot body bytes");
    if (described.status === "available") {
      assert.deepEqual(Object.keys(described.preparedArtifact).sort(), ["contentLength", "digest", "ref"]);
      assert.equal("excerpt" in described.evidence, false, "metadata projection never reads or returns source excerpts");
      assert.equal("value" in described.evidence, false, "metadata projection never returns candidate values");
    }
    await writeFile(preparedPath, prepared);
    await publicReader.close();
  } finally { await fixture.close(); }

  for (const authorize of [
    () => { throw new Error("EACCES /private/owner-secret/key"); },
    async () => Promise.reject(new Error("EACCES /private/owner-secret/key")),
  ]) {
    const fixture = await reviewedSourceFixture();
    try {
      const reader = createFieldworkApplication({ reviewedWebSourceOwner: { runDirectory: fixture.run.runDirectory, snapshotRoot: fixture.snapshotRoot, authorize } });
      const exactRef = "fieldwork-reviewed-source:v1:" + "0".repeat(64);
      for (const result of [await reader.listReviewedWebSourceRefs(), await reader.describeReviewedWebSource(exactRef), await reader.inspectReviewedWebSource(exactRef)]) {
        assert.equal(result.status, "restricted");
        assert.doesNotMatch(JSON.stringify(result), /owner-secret|private/);
      }
      await reader.close();
    } finally { await fixture.close(); }
  }
});

test("reviewed source inspection rejects a physically tampered Forage record without pages", async () => {
  const fixture = await reviewedSourceFixture();
  try {
    const reader = createFieldworkApplication({ reviewedWebSourceOwner: { runDirectory: fixture.run.runDirectory, snapshotRoot: fixture.snapshotRoot, authorize: () => true } });
    const listed = await reader.listReviewedWebSourceRefs();
    assert.equal(listed.status, "available");
    const record = (await readdir(fixture.snapshotRoot, { recursive: true })).find((entry) => entry.endsWith(".json") && !entry.includes("identity-index"));
    assert.ok(record, "the test changes the actual persisted Forage JSON, retaining its filename/hash");
    const file = join(fixture.snapshotRoot, record!);
    const tampered = JSON.parse(await readFile(file, "utf8")) as { url: string };
    tampered.url = "https://example.test/tampered";
    await writeFile(file, JSON.stringify(tampered));
    const inspection = await reader.inspectReviewedWebSource(listed.status === "available" ? listed.refs[0]! : "");
    assert.equal(inspection.status, "corrupt");
    assert.equal("pages" in inspection, false);
    await reader.close();
  } finally { await fixture.close(); }
});

async function reviewedSourceFixture() {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-reviewed-source-snapshots-"));
  const runRoot = await tempRoot("reviewed-source-run");
  const taskPath = join(runRoot, "duplicate-task.json");
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  const first = task.spec.traverse.targetSchema[0];
  const projection = task.spec.projections[0];
  task.spec.traverse.targetSchema.push({ ...first, path: "record.status2" });
  task.spec.projections.push({ ...projection, fieldPath: "record.status2", claim: { ...projection.claim, subjectId: "generic-2" } });
  await writeFile(taskPath, JSON.stringify(task));
  const body = "<main><p>Status: Active</p></main>";
  const snapshot = { sourceId: "reviewed-source", url: "https://example.test/status", status: 200, fetchedAt: "2026-08-26T00:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "text/html" } };
  await createFilesystemSnapshotStore({ root: snapshotRoot }).put(snapshot);
  const initial = createFieldworkApplication();
  const run = await initial.run({ taskPath, snapshotRef: buildSnapshotSourceRef(snapshot), snapshotRoot, root: runRoot });
  const server = await initial.open({ runDirectory: run.runDirectory });
  const view = await server.view();
  const state = view.review.snapshot as unknown as ReviewQueueSessionState;
  const events = buildReviewSessionEvents({ ...state, decisionsByItemName: Object.fromEntries(state.items.map((item) => [item.metadata.name, "accept-proposed"])), reviewedAt: "2026-08-26T00:00:00.000Z", actorId: "reviewed-source-test" });
  const saved = await apiFetch(server, "/api/v1/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }) }).then((response) => response.json());
  assert.equal(saved.ok, true);
  return { run, snapshotRoot, server, initial, close: async () => { await server.close(); await initial.close(); } };
}

async function appendRejectedDecision(fixture: Awaited<ReturnType<typeof reviewedSourceFixture>>): Promise<void> {
  const view = await fixture.server.view();
  const state = { ...(view.review.snapshot as unknown as ReviewQueueSessionState), actorId: "regression-reviewer", reviewedAt: new Date().toISOString() };
  const item = state.items[1]!;
  const events = [...view.review.events,
    buildReviewSessionEvent(state, { sessionName: defaultReviewSessionName, sequence: view.review.events.length + 1, eventType: "decision-changed", occurredAt: state.reviewedAt, reviewItemName: item.metadata.name, reviewDecisionName: `${item.metadata.name}-reject-proposed`, candidateId: item.spec.candidates[0]!.id, status: "rejected", data: { workbenchDecision: "reject-proposed" } }),
    buildReviewSessionEvent(state, { sessionName: defaultReviewSessionName, sequence: view.review.events.length + 2, eventType: "decision-submitted", occurredAt: state.reviewedAt, reviewItemName: item.metadata.name, reviewDecisionName: `${item.metadata.name}-reject-proposed`, candidateId: item.spec.candidates[0]!.id, status: "rejected", data: { workbenchDecision: "reject-proposed" } }),
  ];
  const saved = await apiFetch(fixture.server, "/api/v1/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events, expectedEventCount: view.review.events.length, expectedRevision: view.run.revision }) }).then((response) => response.json());
  assert.equal(saved.ok, true);
}

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
