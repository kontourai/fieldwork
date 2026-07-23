import assert from "node:assert/strict";
import test from "node:test";
import {
  fieldworkRunViewSchema, preparedArtifactViewSchema, reviewMutationResponseSchema
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
});
