import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { fetchSource, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createCheckRunner, createObservationStore, type CheckResult, type LookoutSource } from "@kontourai/lookout";
import { FakeModelRuntime } from "@kontourai/relay";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { openRun, runFieldwork, type FieldworkRuntimeBinding, type FieldworkRunViewV1 } from "../../src/index.js";
import { readRun } from "../../src/run-store.js";
import { FieldworkSourceCheckReceiptStore, type Capture } from "../../src/source-check-receipts.js";
import { apiFetch } from "../helpers.js";

export const taskPath = resolve("examples/generic/task.json");
export const fetchedAt = (step: number) => `2026-08-26T10:00:0${step}.000Z`;
export const checkedAt = (step: number) => `2026-08-26T11:00:0${step}.000Z`;

function modelResult(value: string) {
  return {
    provider: "fixture-runtime", model: "fixture-model", outputText: "",
    toolCalls: [{ id: "tool-1", name: "submit_extraction_proposals", input: { proposals: [{
      fieldPath: "record.status", value, confidence: 0.97, excerpt: `Status: ${value}`,
      locator: null, occurrenceHint: null,
    }] } }],
    usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, latencyMs: 1, stopReason: "tool_use",
  };
}

/**
 * The principal fixture uses real HTTP sockets and Forage's explicit test-only
 * origin allowance, with guarded egress still enabled. Additional fault tests
 * use Forage's injected Response transport at a generic HTTPS URL so today's
 * independent HTTP receipt rejection does not mask their failure sites.
 * Neither fixture changes a production policy or substitutes CheckResults.
 */
export async function ownerFixture(t: TestContext, transport: "http" | "response" = "response", legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-recheck-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let mode: "same" | "304" | "changed" | "error" = "same";
  let tick = 0;
  const requests: { validator: string | null; status: number }[] = [];
  const response = (headers: Headers) => {
    const status = mode === "304" ? 304 : mode === "error" ? 503 : 200;
    requests.push({ validator: headers.get("if-none-match"), status });
    return new Response(status === 304 ? null : mode === "changed" ? "Status: Pending" : "Status: Active", {
      status, headers: { "content-type": "text/plain; charset=utf-8", etag: mode === "changed" ? '"v2"' : '"v1"' },
    });
  };
  let origin = "https://example.invalid";
  if (transport === "http") {
    const server = createServer(async (request, outgoing) => {
      const incoming = response(new Headers(Object.entries(request.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])));
      outgoing.writeHead(incoming.status, Object.fromEntries(incoming.headers));
      outgoing.end(incoming.status === 304 ? undefined : await incoming.text());
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    t.after(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  }
  const source: LookoutSource = {
    id: "record-source", url: `${origin}/record`, kind: "web-page", cadenceHint: "manual", renderPolicy: "never",
    targetSchema: [{ path: "record.status", type: "string", inferenceType: "explicit" }],
  };
  const snapshotRoot = join(root, "snapshots"), runRoot = join(root, "runs");
  const observationRoot = join(root, "observations"), receiptRoot = join(root, "receipts");
  const snapshots = createFilesystemSnapshotStore({ root: snapshotRoot });
  const runner = createCheckRunner({
    store: snapshots,
    clock: () => checkedAt(tick),
    fetchSource: (config, options) => {
      ++tick;
      return fetchSource({ ...config, respectRobots: false, retries: 0, minDelayMs: 0,
        egress: { guarded: true, ...(transport === "http" ? { testOnlyAllowedLoopbackOrigins: [origin] } : {}) },
      }, { ...options, clock: () => fetchedAt(tick),
        ...(transport === "response" ? { fetch: async (_url: string, init?: RequestInit) => response(new Headers(init?.headers)) } : {}),
      });
    },
  });
  const initial = await runner.check(source);
  assert.equal(initial.kind, "changed");
  assert.ok(initial.kind === "changed");
  assert.equal(initial.changeBasis, "initial");
  const initialRef = legacy ? initial.currentSnapshotRef.replace(/&snapshotSha256=[^&]+$/, "") : initial.currentSnapshotRef;
  const runtime = new FakeModelRuntime([modelResult("Active"), modelResult("Pending")], "fake:recheck-owner");
  const binding: FieldworkRuntimeBinding = { role: "extract", candidates: [{ id: "fixture", runtime }], budget: { maxAttempts: 4 } };
  const prior = await runFieldwork({ taskPath, snapshotRef: initialRef, snapshotRoot, root: runRoot, runtime: binding });
  await decidePrior(prior.runDirectory);
  const priorBytes = await readFile(join(prior.runDirectory, "run.json"), "utf8");
  const stored = await readRun(prior.runDirectory);
  const observations = createObservationStore({ root: observationRoot });
  const receipts = new FieldworkSourceCheckReceiptStore(receiptRoot);
  const readHead = async () => {
    const latest = await observations.loadLatest(source.id);
    assert.ok(latest.ok);
    return latest.value?.observationId ?? null;
  };
  const options = { source, priorRunDirectory: prior.runDirectory, taskPath, root: runRoot,
    snapshotRoot, observationRoot, receiptRoot, runtime: binding, now: () => "2026-08-26T12:00:00.000Z" };
  return {
    root, source, snapshots, snapshotRoot, runRoot, observations, observationRoot, receipts, receiptRoot,
    prior, priorBytes, initialRef, initial, runtime, binding, stored, options, requests, readHead,
    setMode(value: typeof mode) { mode = value; },
    check: () => runner.check(source),
    capture: (ref: string) => capture(snapshots, ref),
    async establishProposal() {
      const committed = await observations.commit({ observation: {
        sourceId: source.id, snapshotRef: initialRef, observedAt: stored.envelope.result.extractedAt,
        proposals: stored.envelope.result.proposals,
      }, recordedAt: options.now(), check: { checkedAt: stored.envelope.result.extractedAt,
        resultKind: "changed", currentSnapshotRef: initialRef } }, null);
      assert.ok(committed.ok);
      return committed.value;
    },
    async frozenPrior() {
      assert.equal(await readFile(join(prior.runDirectory, "run.json"), "utf8"), priorBytes);
    },
  };
}

export async function capture(store: ReturnType<typeof createFilesystemSnapshotStore>, ref: string): Promise<Capture> {
  const admitted = await resolveSnapshotSourceRef(store, ref);
  assert.ok(admitted.ok);
  const value = admitted.snapshot;
  return { sourceId: value.sourceId, snapshotRef: ref, url: value.url, bodyHash: value.bodyHash,
    fetchedAt: value.fetchedAt, integrity: admitted.integrity,
    ...(admitted.reference.snapshotDigest ? { snapshotDigest: admitted.reference.snapshotDigest } : {}) };
}

export function currentRef(check: CheckResult): string {
  assert.notEqual(check.kind, "error");
  return check.kind === "unchanged-304" ? check.snapshotRef : (check as Exclude<CheckResult, { kind: "error" } | { kind: "unchanged-304" }>).currentSnapshotRef;
}

export async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name);
      result[file.slice(root.length)] = (await readFile(file)).toString("base64");
    }
  }
  return result;
}

async function decidePrior(directory: string) {
  const service = await openRun(directory, { port: 0 });
  try {
    const view = await apiFetch(service, "/api/v1/run").then((r) => r.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({ ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"])),
    } as Parameters<typeof buildReviewSessionEvents>[0]);
    const saved = await apiFetch(service, "/api/v1/review", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: view.run.revision }),
    }).then((r) => r.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
  } finally { await service.close(); }
}
