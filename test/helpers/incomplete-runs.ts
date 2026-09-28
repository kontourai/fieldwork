import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import type { ReviewItem } from "@kontourai/survey";
import { newReviewRound, runFieldwork } from "../../src/fieldwork.js";
import type { FieldworkRuntimeBinding } from "../../src/runtime-contracts.js";
import { tempRoot } from "../helpers.js";

const TASK = "examples/generic/task.json";

/**
 * A run that proposed a value and still lost content: the first chunk states
 * the status, and the provider fails the second chunk, so Traverse reports a
 * `provider-failure` partial outcome with per-chunk coverage.
 */
export async function partialRunWithProposals(label: string): Promise<string> {
  const root = await tempRoot(`partial-${label}`);
  const sourcePath = join(root, "source.txt");
  await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(700)}`);
  const run = await runFieldwork({ taskPath: TASK, sourcePath, root, runtime: statusOnlyRuntime() });
  return run.runDirectory;
}

/**
 * A three-chunk run whose first answer is complete and whose other two stop at
 * the output cap: coverage [complete, output-truncated, output-truncated].
 * Nothing is unread, but two chunks' answers may be missing values.
 */
export async function outputTruncatedRun(label: string): Promise<string> {
  const root = await tempRoot(`output-truncated-${label}`);
  const sourcePath = join(root, "source.txt");
  await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(1_300)}`);
  const run = await runFieldwork({
    taskPath: TASK, sourcePath, root,
    runtime: statusOnlyRuntime({ withoutStatus: "output-truncated" }),
  });
  return run.runDirectory;
}

/** A run cancelled before any provider call: Traverse's `cancelled` partial outcome with nothing proposed. */
export async function zeroProposalPartialRun(label: string): Promise<string> {
  const root = await tempRoot(`zero-proposal-${label}`);
  const sourcePath = join(root, "source.txt");
  await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(700)}`);
  const controller = new AbortController();
  controller.abort();
  const run = await runFieldwork({ taskPath: TASK, sourcePath, root, signal: controller.signal });
  return run.runDirectory;
}

/**
 * A first-round run whose queue has the shape earlier Fieldwork releases wrote
 * (Survey 3 or older; Survey 5 introduced one item per claim slot):
 * item metadata without `proposalIndices`. The queue is re-bound with the same
 * digest rule the run store checks, so only the queue's age is wrong.
 */
export async function runFromOlderFieldwork(label: string): Promise<string> {
  const root = await tempRoot(`older-${label}`);
  const run = await runFieldwork({ taskPath: TASK, sourcePath: "examples/generic/source.txt", root });
  const runPath = join(run.runDirectory, "run.json");
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  const items = (stored.review.snapshot.items as ReviewItem[]).map((item) => {
    const producer = { ...item.metadata.producer } as Record<string, Record<string, unknown>>;
    const { proposalIndices: _proposalIndices, ...envelopeProducer } = producer["survey.kontourai.io/extraction-envelope"]!;
    producer["survey.kontourai.io/extraction-envelope"] = envelopeProducer;
    return { ...item, metadata: { ...item.metadata, producer } };
  });
  stored.review = newReviewRound(items as ReviewItem[], stored.createdAt);
  await writeFile(runPath, JSON.stringify(stored, null, 2));
  return run.runDirectory;
}

/**
 * Proposes the status its chunk states. A chunk that states none fails at the
 * provider, or, with `withoutStatus: "output-truncated"`, answers with no
 * proposals and stops at the output cap.
 */
function statusOnlyRuntime(options: { withoutStatus?: "provider-failure" | "output-truncated" } = {}): FieldworkRuntimeBinding {
  const runtime: ModelRuntime = {
    id: "fake:incomplete-run",
    capabilities: () => ({
      structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native",
      streaming: false, abort: true, usage: true,
    }),
    invoke: async (request) => {
      const match = /Status: (\w+)/.exec(JSON.stringify(request.messages));
      if (!match && options.withoutStatus === "output-truncated") {
        return {
          provider: "fixture-runtime", model: "fixture-model", outputText: "",
          toolCalls: [{ id: "tool-status", name: "submit_extraction_proposals", input: { proposals: [] } }],
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latencyMs: 1, stopReason: "max_tokens",
        };
      }
      if (!match) throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "unavailable", false);
      return {
        provider: "fixture-runtime", model: "fixture-model", outputText: "",
        toolCalls: [{
          id: "tool-status", name: "submit_extraction_proposals",
          input: { proposals: [{ fieldPath: "record.status", value: match[1], confidence: 0.98, excerpt: match[0], locator: null, occurrenceHint: null }] },
        }],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latencyMs: 1, stopReason: "tool_use",
      };
    },
  };
  return {
    role: "fieldwork-extraction",
    candidates: [{ id: "scripted", runtime }],
    budget: { maxAttempts: 8, maxTotalTokens: 8_000, maxElapsedMs: 60_000 },
    maxTokensPerAttempt: 1_000,
  };
}
