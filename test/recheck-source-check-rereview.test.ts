import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fetchSource } from "@kontourai/forage/fetch";
import { createCheckRunner, type CheckResult, type LookoutSource } from "@kontourai/lookout";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { openRun, recheckFieldwork, type FieldworkRunViewV1 } from "../src/index.js";
import { readRun } from "../src/run-store.js";
import { apiFetch } from "./helpers.js";
import { checkedAt, fetchedAt, ownerFixture } from "./helpers/recheck-owner-fixture.js";

test("historical proposal baseline survives a legitimate registered URL move", async (t) => {
  const f = await ownerFixture(t);
  const source: LookoutSource = { ...f.source, url: "https://example.invalid/moved-record" };
  let acquisitions = 0;
  const runner = createCheckRunner({
    store: f.snapshots,
    clock: () => checkedAt(2),
    fetchSource: (config, options) => fetchSource({
      ...config, respectRobots: false, retries: 0, minDelayMs: 0, egress: { guarded: true },
    }, {
      ...options, clock: () => fetchedAt(2),
      fetch: async () => new Response("Status: Pending", {
        headers: { "content-type": "text/plain; charset=utf-8", etag: '"v2"' },
      }),
    }),
  });
  const result = await recheckFieldwork({
    ...f.options, source, acquisition: {
      async check(actualSource) { ++acquisitions; return runner.check(actualSource as LookoutSource); },
    },
  });
  assert.equal(acquisitions, 1);
  assert.equal(result.classification, "semantic-drift");
  const receipt = await f.receipts.readCurrent(f.source.id, f.readHead);
  assert.ok(receipt.kind === "available");
  assert.equal(receipt.receipt.priorCapture.url, f.source.url);
  assert.equal(receipt.receipt.currentCapture.url, source.url);
  await f.frozenPrior();
});

test("invocation freezes plain runtime routing and budget configuration before its first await", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("changed");
  // Keep the opaque ModelRuntime instance intact; mutate only plain caller configuration.
  const runtime = {
    ...f.binding,
    candidates: f.binding.candidates.map((candidate) => ({ ...candidate })),
    budget: { ...f.binding.budget },
  };
  const expected = { role: runtime.role, candidateId: runtime.candidates[0]!.id, maxAttempts: runtime.budget.maxAttempts };
  const pending = recheckFieldwork({ ...f.options, runtime, acquisition: { check: f.check } });
  runtime.role = "substituted-role";
  runtime.candidates[0]!.id = "substituted-candidate";
  runtime.budget.maxAttempts = 9;
  const result = await pending;
  assert.ok(result.run);
  const current = await readRun(result.run.runDirectory);
  assert.equal(current.run.execution.identity.mode, "runtime");
  assert.ok(current.run.execution.identity.mode === "runtime");
  const actual = {
    role: current.run.execution.identity.role,
    candidateId: current.run.execution.identity.candidates[0]!.id,
    maxAttempts: current.run.execution.identity.budget.maxAttempts,
  };
  t.diagnostic(JSON.stringify({ expected, actual, classification: result.classification }));
  await f.frozenPrior();
  assert.deepEqual(actual, expected);
});

test("receipt checkedAt remains the actual owner result captured before admission awaits", async (t) => {
  const f = await ownerFixture(t);
  const originalOpen = fs.open;
  let armed = false;
  let mutated = false;
  let ownerResult: CheckResult | undefined;
  let originalCheckedAt: string | undefined;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (armed && String(args[0]).startsWith(`${f.snapshotRoot}/`) && String(args[0]).endsWith(".json")) {
      armed = false;
      mutated = true;
      assert.ok(ownerResult);
      ownerResult.checkedAt = "2099-01-01T00:00:00.000Z";
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = await recheckFieldwork({ ...f.options, acquisition: {
      async check() {
        ownerResult = await f.check();
        originalCheckedAt = ownerResult.checkedAt;
        armed = true;
        return ownerResult;
      },
    } });
    assert.ok(mutated, "the mutation must occur during real post-acquisition snapshot I/O");
    const current = await f.receipts.readCurrent(f.source.id, f.readHead);
    assert.ok(current.kind === "available");
    t.diagnostic(JSON.stringify({ originalCheckedAt, publishedCheckedAt: current.receipt.checkedAt, returnedCheckedAt: result.check?.checkedAt }));
    await f.frozenPrior();
    assert.equal(current.receipt.checkedAt, originalCheckedAt);
    assert.equal(result.check?.checkedAt, originalCheckedAt);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("public Survey decisions appended while changed recheck commits are never overwritten by round replacement", async (t) => {
  const f = await ownerFixture(t);
  f.setMode("changed");
  const originalOpen = fs.open;
  let armed = false;
  let reviewedDirectory: string | undefined;
  let acceptedEvents = 0;
  let acceptedRevision = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = String(args[0]);
    if (armed && file.startsWith(`${f.observationRoot}/`) && file.includes("/latest.json.tmp-")) {
      armed = false;
      const runs = (await fs.readdir(f.runRoot)).filter((name) => name.startsWith("run-") && join(f.runRoot, name) !== f.prior.runDirectory);
      assert.equal(runs.length, 1);
      reviewedDirectory = join(f.runRoot, runs[0]!);
      const service = await openRun(reviewedDirectory, { port: 0 });
      try {
        const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
        const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
        const events = buildReviewSessionEvents({
          ...snapshot,
          decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"])),
        } as Parameters<typeof buildReviewSessionEvents>[0]);
        const saved = await apiFetch(service, "/api/v1/review", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: view.run.revision }),
        }).then((response) => response.json());
        assert.equal(saved.ok, true, JSON.stringify(saved));
        acceptedEvents = saved.eventCount;
        acceptedRevision = saved.revision;
        assert.ok(acceptedEvents > 0);
      } finally { await service.close(); }
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof recheckFieldwork>> | undefined;
  let failure: unknown;
  try {
    try {
      result = await recheckFieldwork({ ...f.options, acquisition: {
        async check() { const actual = await f.check(); armed = true; return actual; },
      } });
    } catch (error) { failure = error; }
    assert.ok(reviewedDirectory, "the public review must race after the new run exists and before proposal commit returns");
    const current = await readRun(reviewedDirectory);
    t.diagnostic(JSON.stringify({ acceptedEvents, acceptedRevision, finalEvents: current.run.review.events.length,
      finalRevision: current.run.review.revision, classification: result?.classification,
      failureCode: (failure as { code?: string } | undefined)?.code }));
    await f.frozenPrior();
    assert.equal(current.run.review.events.length, acceptedEvents, "a successful public append was erased");
    assert.equal(current.run.review.revision, acceptedRevision);
    assert.equal(result, undefined, "a raced existing review must not be replaced and returned as semantic success");
    assert.equal((failure as { code?: string } | undefined)?.code, "RECHECK_CONFLICT");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
