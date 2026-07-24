import assert from "node:assert/strict";
import test from "node:test";
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
