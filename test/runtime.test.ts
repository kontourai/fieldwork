import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { FakeModelRuntime, ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import { runFieldwork, runFieldworkBatch } from "../src/fieldwork.js";
import { createDatumRuntimeBinding, type FieldworkRuntimeBinding } from "../src/runtime-contracts.js";
import { createFieldworkRuntimeSession } from "../src/runtime-session.js";
import { readRun } from "../src/run-store.js";

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

test("a stored run whose attempt receipts carry Dispatch's served model loads; an unknown modelSource is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-served-model-"));
  const result = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: join(fixture, "source.txt"),
    root,
    runtime: binding([{ id: "primary", runtime: new FakeModelRuntime([modelResult], "fake:served-model") }]),
  });
  const runPath = join(result.runDirectory, "run.json");
  const original = JSON.parse(await readFile(runPath, "utf8"));
  // The shape Dispatch writes on a successful attempt (kontourai/dispatch#65).
  const withServedModel = (modelSource: string) => {
    const stored = structuredClone(original);
    const attempt = stored.execution.receipts[0].attempts[0];
    assert.equal(attempt.outcome, "succeeded");
    attempt.model = "fixture-model";
    attempt.modelSource = modelSource;
    return `${JSON.stringify(stored, null, 2)}\n`;
  };

  await writeFile(runPath, withServedModel("provider-reported"));
  const loaded = await readRun(result.runDirectory);
  assert.equal(loaded.run.execution.receipts[0]?.attempts[0]?.model, "fixture-model");
  assert.equal(loaded.run.execution.receipts[0]?.attempts[0]?.modelSource, "provider-reported");

  await writeFile(runPath, withServedModel("guessed"));
  await assert.rejects(() => readRun(result.runDirectory), /modelSource/);
});

test("a live run records the served model and its source on the receipt and the proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-model-source-"));
  const result = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: join(fixture, "source.txt"),
    root,
    runtime: binding([{ id: "primary", runtime: new FakeModelRuntime([{ ...modelResult, modelSource: "provider-reported" }], "fake:model-source") }]),
  });
  const loaded = await readRun(result.runDirectory);
  const attempt = loaded.run.execution.receipts[0]?.attempts[0];
  assert.equal(attempt?.model, "fixture-model");
  assert.equal(attempt?.modelSource, "provider-reported");
  assert.deepEqual(
    loaded.envelope.result.proposals.map((proposal) => [proposal.producedBy?.model, proposal.producedBy?.modelSource]),
    [["fixture-model", "provider-reported"]],
  );
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

test("direct SDK mode keeps two SDK retries per invocation, whatever Relay's default", async (t) => {
  // An Anthropic-compatible endpoint that is overloaded twice, then answers.
  // Relay releases from kontourai/relay#68 on build the SDK client with no
  // retries unless told otherwise, so without an explicit maxRetries the first
  // 529 would end the invocation.
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      if (requests <= 2) {
        response.writeHead(529, { "content-type": "application/json", "retry-after-ms": "1" });
        response.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "test-model", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }));
  const binding = createDatumRuntimeBinding({
    role: "extraction-default",
    budget: { maxAttempts: 1 },
    resolve: {
      env: { TEST_PROVIDER_KEY: "test-only-credential-value" },
      config: {
        providers: {
          test: {
            kind: "anthropic-compatible",
            auth: { env: "TEST_PROVIDER_KEY" },
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            models: ["test-model"],
          },
        },
        roles: { "extraction-default": "test-model@test" },
      },
    },
  });
  const result = await binding.candidates[0]!.runtime.invoke({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(result.outputText, "ok");
  assert.equal(requests, 3, "one request and two SDK retries");
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

for (const [type, value] of [["array", '["Active","Paused"]'], ["object", '{"state":"Active"}']] as const) {
  test(`a runtime-bound run refuses a ${type} target before any provider call, and the deterministic provider still runs it`, async () => {
    // Traverse's Relay adapter cannot express a nested schema for array/object
    // targets, so a runtime-bound run would fail after validation with an
    // untyped error (fieldwork#139). The deterministic provider supports both.
    const root = await mkdtemp(join(tmpdir(), `fieldwork-runtime-${type}-`));
    const task = JSON.parse(await readFile(join(fixture, "task.json"), "utf8"));
    task.spec.traverse.targetSchema[0].type = type;
    const taskPath = join(root, "task.json");
    const sourcePath = join(root, "source.txt");
    await writeFile(taskPath, JSON.stringify(task));
    await writeFile(sourcePath, `Status: ${value}\n`);
    const runtime = new FakeModelRuntime([modelResult], "fake:primary");
    const runRoot = join(root, "runtime-runs");

    await assert.rejects(
      () => runFieldwork({ taskPath, sourcePath, root: runRoot, runtime: binding([{ id: "primary", runtime }]) }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "TASK_UNSUPPORTED_FIELD_TYPE");
        assert.match(error.message, new RegExp(`record\\.status.*${type}|${type}.*record\\.status`));
        return true;
      },
    );
    assert.equal(runtime.requests.length, 0);
    await assert.rejects(() => readdir(runRoot), { code: "ENOENT" });

    const deterministic = await runFieldwork({ taskPath, sourcePath, root: join(root, "fixture-runs") });
    const envelope = JSON.parse(await readFile(join(deterministic.runDirectory, "extraction-envelope.json"), "utf8"));
    assert.deepEqual(envelope.result.proposals[0].candidateValue, JSON.parse(value));
  });
}

test("a runtime-bound batch keeps the unsupported field type and its field name, not a generic source failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-runtime-batch-array-"));
  const task = JSON.parse(await readFile(join(fixture, "task.json"), "utf8"));
  task.spec.traverse.targetSchema[0].type = "array";
  const taskPath = join(root, "task.json");
  await writeFile(taskPath, JSON.stringify(task));
  const runtime = new FakeModelRuntime([modelResult], "fake:primary");
  const batch = await runFieldworkBatch({
    taskPath,
    root: join(root, "runs"),
    sources: [{ id: "only", sourcePath: join(fixture, "source.txt") }],
    runtime: binding([{ id: "primary", runtime }]),
  });
  assert.equal(batch.failed, 1);
  const [item] = batch.items;
  assert.equal(item?.ok, false);
  if (item && !item.ok) {
    assert.equal(item.error.code, "TASK_UNSUPPORTED_FIELD_TYPE");
    assert.match(item.error.message, /record\.status has type array/);
  }
  assert.equal(runtime.requests.length, 0);
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
