import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FakeModelRuntime, ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import { runFieldwork } from "../src/fieldwork.js";
import { createDatumRuntimeBinding, type FieldworkRuntimeBinding } from "../src/runtime-contracts.js";
import { createFieldworkRuntimeSession } from "../src/runtime-session.js";

const fixture = resolve("examples/generic");
const modelResult = {
  provider: "fixture-runtime",
  model: "fixture-model",
  outputText: "",
  toolCalls: [{
    id: "tool-1",
    name: "submit_extraction_proposals",
    input: {
      proposals: [{
        fieldPath: "record.status",
        value: "Active",
        confidence: 0.97,
        excerpt: "Status: Active",
        locator: null,
        occurrenceHint: null,
      }],
    },
  }],
  usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
  latencyMs: 1,
  stopReason: "tool_use",
};

test("a Relay runtime uses the same task and stores a Dispatch receipt without request content", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-"));
  const runtime = new FakeModelRuntime([modelResult], "fake:primary");
  const result = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: join(fixture, "source.txt"),
    root,
    runtime: binding([{ id: "primary", runtime }]),
  });
  const stored = JSON.parse(await readFile(join(result.runDirectory, "run.json"), "utf8"));
  assert.equal(stored.execution.identity.mode, "runtime");
  assert.equal(stored.execution.identity.candidates[0].runtimeId, "fake:primary");
  assert.equal(stored.execution.receipts.length, 1);
  assert.equal(stored.execution.receipts[0].outcome, "succeeded");
  assert.equal(stored.execution.receipts[0].attempts[0].totalTokens, 12);
  assert.doesNotMatch(JSON.stringify(stored.execution), /Status: Active|submit_extraction_proposals|api[_-]?key/i);
});

test("retryable runtime failure falls back in declared order and remains receipt-visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-fallback-"));
  const failed: ModelRuntime = {
    id: "fake:failed",
    capabilities: () => ({
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "native",
      streaming: false,
      abort: true,
      usage: true,
    }),
    async invoke() {
      throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "private native diagnostic", true);
    },
  };
  const fallback = new FakeModelRuntime([modelResult], "fake:fallback");
  const result = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: join(fixture, "source.txt"),
    root,
    runtime: binding([{ id: "first", runtime: failed }, { id: "second", runtime: fallback }]),
  });
  const stored = JSON.parse(await readFile(join(result.runDirectory, "run.json"), "utf8"));
  assert.deepEqual(stored.execution.receipts[0].attempts.map((attempt: { candidateId: string; outcome: string; errorCode?: string }) => ({
    candidateId: attempt.candidateId,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
  })), [
    { candidateId: "first", outcome: "failed", errorCode: "PROVIDER_UNAVAILABLE" },
    { candidateId: "second", outcome: "succeeded", errorCode: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify(stored.execution), /private native diagnostic/);
});

test("runtime selection participates in identity while the Fieldwork task stays unchanged", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "fieldwork-runtime-identity-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "fieldwork-runtime-identity-b-"));
  const first = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: join(fixture, "source.txt"),
    root: firstRoot,
    runtime: binding([{ id: "primary", runtime: new FakeModelRuntime([modelResult], "fake:a") }]),
  });
  const second = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: join(fixture, "source.txt"),
    root: secondRoot,
    runtime: binding([{ id: "primary", runtime: new FakeModelRuntime([modelResult], "fake:b") }]),
  });
  assert.notEqual(first.runResource, second.runResource);
});

test("authorization-wide attempt budget stops a later extraction invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-budget-"));
  const runtime = new FakeModelRuntime([modelResult, modelResult], "fake:budget");
  const session = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime }], 1),
    sessionOptions(root, "fieldwork:test-budget"),
  );
  const request = {
    content: "Status: Active",
    contentType: "text" as const,
    targetSchema: [{ path: "record.status", type: "string" as const }],
  };
  await session.provider.extract(request);
  await assert.rejects(() => session.provider.extract(request), /budget-exceeded/);
  assert.deepEqual(session.execution.receipts.map((receipt) => receipt.outcome), ["succeeded", "budget-exceeded"]);
  assert.equal(runtime.requests.length, 1);
});

test("Datum materializes a supported SDK target without putting its credential in execution identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-datum-"));
  const credentialValue = "test-only-credential-value";
  const runtime = createDatumRuntimeBinding({
    role: "extraction-default",
    budget: { maxAttempts: 1, maxCostUsd: 1 },
    maxTokensPerAttempt: 1_000,
    estimatedUsdPer1kTokens: 0.01,
    resolve: {
      env: { TEST_PROVIDER_KEY: credentialValue },
      config: {
        providers: {
          test: {
            kind: "anthropic-compatible",
            auth: { env: "TEST_PROVIDER_KEY" },
            models: ["test-model"],
          },
        },
        roles: { "extraction-default": "test-model@test" },
      },
    },
  });
  const execution = createFieldworkRuntimeSession(
    runtime,
    sessionOptions(root, "fieldwork:test-datum"),
  ).execution;
  assert.equal(execution.identity.mode, "runtime");
  assert.doesNotMatch(JSON.stringify(execution), new RegExp(credentialValue));
});

test("durable authorization settles successful usage in a private content-free ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-ledger-"));
  const runtime = new FakeModelRuntime([modelResult], "fake:ledger");
  const session = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime }], 2),
    sessionOptions(root, "fieldwork:test-ledger"),
  );
  await session.provider.extract(extractionRequest("Status: Active"));

  const [ledgerName] = await readdir(join(root, "authorizations"));
  assert.ok(ledgerName?.endsWith(".json"));
  const ledgerPath = join(root, "authorizations", ledgerName);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const reservation = Object.values(ledger.reservations)[0] as {
    state: string;
    usage: { attempts: number; totalTokens: number };
  };
  assert.equal(reservation.state, "settled");
  assert.deepEqual(reservation.usage, { attempts: 1, totalTokens: 12, costUsd: 0 });
  assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(ledger), /Status: Active|submit_extraction_proposals|api[_-]?key/i);
  assert.equal(session.execution.receipts[0]?.authorization?.outcome, "settled");
});

test("a failed candidate stays conservatively reserved while an ordered fallback settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-reserved-"));
  const failed: ModelRuntime = {
    id: "fake:reserved-failure",
    capabilities: () => ({
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "native",
      streaming: false,
      abort: true,
      usage: true,
    }),
    async invoke() {
      throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "private native diagnostic", true);
    },
  };
  const fallback = new FakeModelRuntime([modelResult], "fake:reserved-fallback");
  const session = createFieldworkRuntimeSession(
    binding([{ id: "first", runtime: failed }, { id: "second", runtime: fallback }], 3),
    sessionOptions(root, "fieldwork:test-reserved"),
  );
  await session.provider.extract(extractionRequest("Status: Active"));

  const [ledgerName] = await readdir(join(root, "authorizations"));
  const ledger = JSON.parse(await readFile(join(root, "authorizations", ledgerName!), "utf8"));
  assert.deepEqual(
    Object.values(ledger.reservations).map((value) => (value as { state: string }).state),
    ["reserved", "settled"],
  );
  assert.equal(session.execution.receipts[0]?.authorization?.outcome, "reserved");
  assert.deepEqual(
    session.execution.receipts[0]?.attempts.map((attempt) => [attempt.candidateId, attempt.reservationState]),
    [["first", "reserved"], ["second", "settled"]],
  );
});

test("authorization capacity survives a new session and prevents another provider launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-restart-"));
  const authorization = sessionOptions(root, "fieldwork:test-restart");
  const firstRuntime = new FakeModelRuntime([modelResult], "fake:restart");
  const first = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime: firstRuntime }], 1),
    authorization,
  );
  await first.provider.extract(extractionRequest("Status: Active"));

  const secondRuntime = new FakeModelRuntime([modelResult], "fake:restart");
  const second = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime: secondRuntime }], 1),
    authorization,
  );
  await assert.rejects(
    () => second.provider.extract(extractionRequest("Status: Pending")),
    /budget-exceeded/,
  );
  assert.equal(secondRuntime.requests.length, 0);
  assert.equal(second.execution.receipts[0]?.authorization?.outcome, "exhausted");
});

test("an identical invocation is never replayed automatically after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-replay-"));
  const authorization = sessionOptions(root, "fieldwork:test-replay");
  const first = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime: new FakeModelRuntime([modelResult], "fake:replay") }], 2),
    authorization,
  );
  await first.provider.extract(extractionRequest("Status: Active"));

  const replayRuntime = new FakeModelRuntime([modelResult], "fake:replay");
  const replay = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime: replayRuntime }], 2),
    authorization,
  );
  await assert.rejects(
    () => replay.provider.extract(extractionRequest("Status: Active")),
    /automatic provider replay is refused/,
  );
  assert.equal(replayRuntime.requests.length, 0);
});

test("pre-dispatch cancellation records an aborted receipt without reserving capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-abort-"));
  const runtime = new FakeModelRuntime([modelResult], "fake:abort");
  const session = createFieldworkRuntimeSession(
    binding([{ id: "primary", runtime }], 1),
    sessionOptions(root, "fieldwork:test-abort"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => session.provider.extract({ ...extractionRequest("Status: Active"), signal: controller.signal }),
    /aborted/,
  );
  assert.equal(runtime.requests.length, 0);
  assert.equal(session.execution.receipts[0]?.outcome, "aborted");
  assert.equal(session.execution.receipts[0]?.authorization, undefined);
});

function binding(
  candidates: FieldworkRuntimeBinding["candidates"],
  maxAttempts = 4,
): FieldworkRuntimeBinding {
  return {
    role: "fieldwork-extraction",
    candidates,
    budget: { maxAttempts, maxTotalTokens: 1_000, maxElapsedMs: 60_000 },
    maxTokensPerAttempt: 100,
  };
}

function sessionOptions(root: string, authorizationId: string) {
  return { authorizationId, authorizationRoot: join(root, "authorizations") };
}

function extractionRequest(content: string) {
  return {
    content,
    contentType: "text" as const,
    targetSchema: [{ path: "record.status", type: "string" as const }],
  };
}
