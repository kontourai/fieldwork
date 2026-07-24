import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelInvocationError,
  type ModelBatchInvocationOutcome,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelRuntime,
} from "@kontourai/relay";
import { runFieldwork } from "../src/fieldwork.js";
import type { FieldworkRuntimeBinding } from "../src/runtime-contracts.js";

const markers = [
  { text: "First: Alpha", fieldPath: "record.first", value: "Alpha", at: 100 },
  { text: "Second: Beta", fieldPath: "record.second", value: "Beta", at: 12_500 },
  { text: "Third: Gamma", fieldPath: "record.third", value: "Gamma", at: 24_000 },
] as const;

test("routed physical batching keeps one provider operation, positional fallback, and durable receipts", async () => {
  const fixture = await providerFixture("physical-batch");
  const batchRequests: ModelInvocationRequest[][] = [];
  const fallbackRequests: ModelInvocationRequest[] = [];
  const primary: ModelRuntime = {
    id: "fake:physical-primary",
    capabilities: () => ({
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "native",
      streaming: false,
      abort: true,
      usage: true,
      physicalBatch: true,
      maxBatchSize: 8,
    }),
    async invoke() {
      throw new Error("Fieldwork must not simulate a physical batch with invoke()");
    },
    async invokeBatch(requests) {
      batchRequests.push([...requests]);
      return requests.map((request, index): ModelBatchInvocationOutcome => index === 1
        ? {
            status: "rejected",
            reason: {
              code: "PROVIDER_UNAVAILABLE",
              message: "content-free primary failure",
              retryable: true,
            },
          }
        : { status: "fulfilled", value: resultFor(markerFor(request)) });
    },
  };
  const fallback: ModelRuntime = {
    id: "fake:item-fallback",
    capabilities: () => ({
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "native",
      streaming: false,
      abort: true,
      usage: true,
    }),
    async invoke(request) {
      fallbackRequests.push(request);
      return resultFor(markerFor(request));
    },
  };

  const result = await runFieldwork({
    ...fixture,
    runtime: {
      role: "fieldwork-extraction",
      candidates: [
        { id: "physical-primary", runtime: primary },
        { id: "item-fallback", runtime: fallback },
      ],
      budget: { maxAttempts: 8, maxTotalTokens: 8_000, maxElapsedMs: 60_000 },
      maxTokensPerAttempt: 1_000,
      maxOutputTokens: 256,
      concurrency: 3,
      batchSize: 3,
      maxProviderCalls: 1,
    },
  });
  const stored = await storedArtifacts(result.runDirectory);
  const receipts = stored.run.execution.receipts;

  assert.equal(batchRequests.length, 1);
  assert.equal(batchRequests[0].length, 3);
  assert.equal(fallbackRequests.length, 1);
  assert.deepEqual(
    stored.envelope.result.proposals.map((proposal: { fieldPath: string }) => proposal.fieldPath),
    markers.map((marker) => marker.fieldPath),
  );
  assert.equal(new Set(receipts.map((receipt: { physicalBatch: { operationId: string } }) =>
    receipt.physicalBatch.operationId)).size, 1);
  assert.deepEqual(
    receipts.map((receipt: { physicalBatch: { itemIndex: number } }) => receipt.physicalBatch.itemIndex),
    [0, 1, 2],
  );
  assert.ok(receipts.every((receipt: { physicalBatch: { itemCount: number } }) =>
    receipt.physicalBatch.itemCount === 3));
  assert.deepEqual(receipts.map((receipt: { attempts: unknown[] }) => receipt.attempts.length), [1, 2, 1]);
  assert.equal(receipts[1].attempts[0].reservationState, "reserved");
  assert.equal(receipts[1].attempts[1].reservationState, "settled");
  assert.doesNotMatch(JSON.stringify(stored.run.execution), /source\\.txt|First: Alpha|Second: Beta|Third: Gamma/);
});

test("out-of-order concurrent completion persists source-ordered proposals and invocation-ordered receipts", async () => {
  const fixture = await providerFixture("ordered");
  const completionOrder: string[] = [];
  let active = 0;
  let maxActive = 0;
  let pairStartedCount = 0;
  let releasePair!: () => void;
  let releaseFirst!: () => void;
  let releaseThird!: () => void;
  const pairStarted = new Promise<void>((resolve) => { releasePair = resolve; });
  const secondCompleted = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstCompleted = new Promise<void>((resolve) => { releaseThird = resolve; });
  const runtime = scriptedRuntime(async (request) => {
    const marker = markerFor(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (marker.fieldPath === "record.first" || marker.fieldPath === "record.second") {
      pairStartedCount += 1;
      if (pairStartedCount === 2) releasePair();
      await pairStarted;
    }
    if (marker.fieldPath === "record.first") await secondCompleted;
    if (marker.fieldPath === "record.third") await firstCompleted;
    active -= 1;
    completionOrder.push(marker.fieldPath);
    if (marker.fieldPath === "record.second") releaseFirst();
    if (marker.fieldPath === "record.first") releaseThird();
    return resultFor(marker);
  });

  const result = await runFieldwork({
    ...fixture,
    runtime: binding(runtime, { concurrency: 2 }),
  });
  const stored = await storedArtifacts(result.runDirectory);

  assert.equal(maxActive, 2);
  assert.deepEqual(completionOrder, ["record.second", "record.first", "record.third"]);
  assert.deepEqual(
    stored.envelope.result.proposals.map((proposal: { fieldPath: string }) => proposal.fieldPath),
    markers.map((marker) => marker.fieldPath),
  );
  assert.deepEqual(
    stored.run.execution.receipts.map((receipt: { authorization: { invocationId: string } }) =>
      Number(/^invoke-(\d+)-/.exec(receipt.authorization.invocationId)?.[1])),
    [1, 2, 3],
  );
  for (const marker of markers) {
    const proposal = stored.envelope.result.proposals.find(
      (candidate: { fieldPath: string }) => candidate.fieldPath === marker.fieldPath,
    );
    assert.equal(proposal.provenance.locator, `chars:${marker.at}-${marker.at + marker.text.length}`);
  }
});

test("one failed concurrent chunk remains typed and reserved while successful chunks survive in order", async () => {
  const fixture = await providerFixture("partial");
  const runtime = scriptedRuntime(async (request) => {
    const marker = markerFor(request);
    await delay(marker.fieldPath === "record.first" ? 30 : 0);
    if (marker.fieldPath === "record.second") {
      throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "private provider detail", false);
    }
    return resultFor(marker);
  });

  const result = await runFieldwork({
    ...fixture,
    runtime: binding(runtime, { concurrency: 2 }),
  });
  const stored = await storedArtifacts(result.runDirectory);

  assert.deepEqual(
    stored.envelope.result.proposals.map((proposal: { fieldPath: string }) => proposal.fieldPath),
    ["record.first", "record.third"],
  );
  assert.equal(stored.envelope.result.outcome.status, "success");
  assert.equal(stored.envelope.result.providerFailures[0].kind, "unavailable");
  assert.doesNotMatch(JSON.stringify(stored.run.execution), /private provider detail/);
  const failed = stored.run.execution.receipts.find(
    (receipt: { outcome: string }) => receipt.outcome === "exhausted",
  );
  assert.equal(failed.attempts[0].errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(failed.attempts[0].reservationState, "reserved");
  assert.equal(failed.authorization.outcome, "reserved");
});

test("the Traverse provider-call ceiling stops later chunks without discarding earlier grounded results", async () => {
  const fixture = await providerFixture("ceiling");
  const runtime = scriptedRuntime(async (request) => resultFor(markerFor(request)));
  const result = await runFieldwork({
    ...fixture,
    runtime: binding(runtime, { concurrency: 1, maxProviderCalls: 2 }),
  });
  const stored = await storedArtifacts(result.runDirectory);

  assert.equal(runtime.requests.length, 2);
  assert.deepEqual(
    stored.envelope.result.proposals.map((proposal: { fieldPath: string }) => proposal.fieldPath),
    ["record.first", "record.second"],
  );
  assert.deepEqual(stored.envelope.result.partial, {
    reason: "max-provider-calls",
    completedChunks: 2,
    remainingChunks: 1,
  });
});

test("run-level cancellation stops before provider launch and persists a typed partial result", async () => {
  const fixture = await providerFixture("cancelled");
  const runtime = scriptedRuntime(async (request) => resultFor(markerFor(request)));
  const controller = new AbortController();
  controller.abort();

  const result = await runFieldwork({
    ...fixture,
    runtime: binding(runtime, { concurrency: 2 }),
    signal: controller.signal,
  });
  assert.equal(runtime.requests.length, 0);
  const stored = await storedArtifacts(result.runDirectory);
  assert.deepEqual(stored.envelope.result.partial, {
    reason: "cancelled",
    completedChunks: 0,
    remainingChunks: 3,
  });
  assert.equal(stored.envelope.result.outcome.status, "partial");
});

function binding(
  runtime: ModelRuntime & { requests: ModelInvocationRequest[] },
  operations: { concurrency: number; maxProviderCalls?: number },
): FieldworkRuntimeBinding {
  return {
    role: "fieldwork-extraction",
    candidates: [{ id: "scripted", runtime }],
    budget: { maxAttempts: 8, maxTotalTokens: 8_000, maxElapsedMs: 60_000 },
    maxTokensPerAttempt: 1_000,
    maxOutputTokens: 256,
    concurrency: operations.concurrency,
    ...(operations.maxProviderCalls === undefined ? {} : {
      maxProviderCalls: operations.maxProviderCalls,
    }),
  };
}

function scriptedRuntime(
  invoke: (request: ModelInvocationRequest) => Promise<ModelInvocationResult>,
): ModelRuntime & { requests: ModelInvocationRequest[] } {
  const requests: ModelInvocationRequest[] = [];
  return {
    id: "fake:provider-conformance",
    requests,
    capabilities: () => ({
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "native",
      streaming: false,
      abort: true,
      usage: true,
    }),
    async invoke(request) {
      requests.push(request);
      return invoke(request);
    },
  };
}

function markerFor(request: ModelInvocationRequest): typeof markers[number] {
  const serialized = JSON.stringify(request.messages);
  const marker = markers.find((candidate) => serialized.includes(candidate.text));
  if (!marker) throw new Error("Scripted request did not contain a conformance marker");
  return marker;
}

function resultFor(marker: typeof markers[number]): ModelInvocationResult {
  return {
    provider: "fixture-runtime",
    model: "fixture-model",
    outputText: "",
    toolCalls: [{
      id: `tool-${marker.fieldPath}`,
      name: "submit_extraction_proposals",
      input: {
        proposals: [{
          fieldPath: marker.fieldPath,
          value: marker.value,
          confidence: 0.98,
          excerpt: marker.text,
          locator: null,
          occurrenceHint: null,
        }],
      },
    }],
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    latencyMs: 1,
    stopReason: "tool_use",
  };
}

async function providerFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `fieldwork-provider-${name}-`));
  const sourcePath = join(root, "source.txt");
  const taskPath = join(root, "task.json");
  let source = "x".repeat(25_000);
  for (const marker of markers) {
    source = `${source.slice(0, marker.at)}${marker.text}${source.slice(marker.at + marker.text.length)}`;
  }
  await writeFile(sourcePath, source, "utf8");
  await writeFile(taskPath, JSON.stringify({
    apiVersion: "fieldwork.kontourai.io/v1alpha1",
    kind: "FieldworkTask",
    metadata: { name: `provider-${name}` },
    spec: {
      traverse: {
        version: "1",
        targetSchema: markers.map((marker) => ({
          path: marker.fieldPath,
          type: "string",
          required: true,
          inferenceType: "explicit",
        })),
      },
      projections: markers.map((marker) => ({
        fieldPath: marker.fieldPath,
        pattern: `${marker.text.split(":")[0]}: ([^\\n]+)`,
        claim: {
          subjectType: "record",
          subjectId: "provider-conformance",
          facet: marker.fieldPath,
          claimType: "extracted-field",
          impactLevel: "medium",
        },
      })),
    },
  }), "utf8");
  return { root, sourcePath, taskPath };
}

async function storedArtifacts(runDirectory: string) {
  return {
    run: JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")),
    envelope: JSON.parse(await readFile(join(runDirectory, "extraction-envelope.json"), "utf8")),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
