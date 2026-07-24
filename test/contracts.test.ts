import assert from "node:assert/strict";
import test from "node:test";
import {
  fieldworkHostPresentationSchema, fieldworkLifecycleEventSchema,
  fieldworkAcquisitionResultSchema, fieldworkBatchRunResultSchema,
  fieldworkRunResultSchema, fieldworkRunViewSchema, preparedArtifactViewSchema,
  reviewMutationResponseSchema,
} from "../src/api-contracts.js";

const runView = {
  apiVersion: "fieldwork.kontourai.io/v1",
  kind: "FieldworkRunView",
  ok: true,
  run: { resource: "fieldwork-run:v1:generic:0123456789abcdef", revision: 0 },
  inspector: { sources: [], candidates: [] },
  review: { snapshot: { items: [] }, items: [], events: [], apply: { ok: true, results: [] } }
};

test("Fieldwork response schemas validate the complete advertised JSON transport", () => {
  assert.equal(fieldworkHostPresentationSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkHostPresentation",
    eyebrow: "Station", title: "Review", theme: "dark",
    navigation: [{ label: "Task", href: "https://station.kontourai.io/tasks/fixture" }],
  }).success, true);
  assert.equal(fieldworkLifecycleEventSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkLifecycleEvent",
    sequence: 1, type: "run-opened",
    runResource: "fieldwork-run:v1:generic:0123456789abcdef",
    revision: 0, eventCount: 0,
  }).success, true);
  assert.equal(fieldworkRunViewSchema.safeParse(runView).success, true);
  for (const malformed of [
    { ...runView, inspector: [] },
    { ...runView, review: { ...runView.review, snapshot: [] } },
    { ...runView, review: { ...runView.review, events: ["not-an-object"] } },
    { ...runView, review: { ...runView.review, apply: null } },
    { ...runView, unexpected: true }
  ]) assert.equal(fieldworkRunViewSchema.safeParse(malformed).success, false);

  assert.equal(reviewMutationResponseSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewMutationResult", ok: true,
    events: [], eventCount: 0, revision: 1, apply: { ok: true }
  }).success, true);
  assert.equal(reviewMutationResponseSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewMutationResult", ok: true,
    events: [[]], eventCount: 1, revision: 1, apply: { ok: true }
  }).success, false);

  assert.equal(preparedArtifactViewSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "PreparedArtifactView", ok: true,
    text: "prepared", artifact: {
      ref: "traverse-prepared-artifact:v1:sha256:value",
      digest: "a".repeat(64), contentLength: 8, file: "prepared.txt"
    }
  }).success, true);

  const run = {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkRunResult",
    runDirectory: "run-local",
    runResource: "fieldwork-run:v1:generic:0123456789abcdef",
    proposalCount: 1,
  };
  assert.equal(fieldworkRunResultSchema.safeParse(run).success, true);
  assert.equal(fieldworkAcquisitionResultSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkAcquisitionResult",
    pages: [{
      sourceRef: "forage-snapshot:source?url=https%3A%2F%2Fexample.invalid&sha256=a",
      status: 200,
      depth: 0,
      rendered: false,
      warningCount: 0,
    }],
    truncated: false,
    warningCount: 0,
  }).success, true);
  assert.equal(fieldworkBatchRunResultSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkBatchRunResult",
    items: [
      { id: "first", ok: true, run },
      { id: "second", ok: false, error: { code: "SOURCE_FAILED", message: "Source processing failed" } },
    ],
    succeeded: 1,
    failed: 1,
  }).success, true);
  assert.equal(fieldworkBatchRunResultSchema.safeParse({
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkBatchRunResult",
    items: [{ id: "first", ok: true, run }],
    succeeded: 0,
    failed: 0,
  }).success, false);
});
