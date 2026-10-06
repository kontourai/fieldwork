import {
  createDispatchRuntime,
  FileAuthorizationLedger,
  type DispatchReceipt,
  type ExecutionBudget,
  type ExecutionCandidate,
} from "@kontourai/dispatch";
import { invocationDigest, type ModelRuntime } from "@kontourai/relay";
import type { ExtractionProvider } from "@kontourai/traverse";
import { createRelayExtractionProvider } from "@kontourai/traverse/relay";
import {
  fieldworkStoredExecutionSchema,
  MAX_RUNTIME_RECEIPTS,
  runtimeOutputTokenLimitFidelity,
  runtimeStructuredToolsFidelity,
  validateRuntimeBinding,
  type FieldworkExecutionIdentity,
  type FieldworkRuntimeBinding,
  type FieldworkRuntimeBudget,
  type FieldworkStoredExecution,
} from "./runtime-contracts.js";

export interface FieldworkRuntimeSession {
  readonly provider: ExtractionProvider;
  readonly execution: FieldworkStoredExecution;
  /** The most recent failed runtime attempt, if any attempt failed. */
  readonly lastFailure: () => FieldworkRuntimeAttemptFailure | undefined;
}

/**
 * Why a runtime attempt failed, as the runtime itself said it. Dispatch's
 * receipt keeps each attempt's error code but not its message, and its own
 * error says only that the invocation was exhausted, so a run that failed on
 * quota or sign-in reported no cause (fieldwork#170).
 */
export interface FieldworkRuntimeAttemptFailure {
  readonly runtimeId: string;
  readonly code: string;
  /** The runtime's own message on one line, kept to one character past `MAX_FAILURE_MESSAGE_CHARS`. */
  readonly message: string;
}

export const MAX_FAILURE_MESSAGE_CHARS = 200;

export interface FieldworkRuntimeSessionOptions {
  readonly authorizationId: string;
  readonly authorizationRoot: string;
}

export function createFieldworkExecutionIdentity(binding: FieldworkRuntimeBinding): FieldworkExecutionIdentity {
  validateRuntimeBinding(binding);
  const minimumFidelity = binding.minimumStructuredToolsFidelity ?? "native";
  const maxOutputTokens = binding.maxOutputTokens ?? 2_048;
  const identities = binding.candidates.map((candidate) => ({
    id: candidate.id,
    runtimeId: candidate.runtime.id,
    structuredToolsFidelity: runtimeStructuredToolsFidelity(candidate.runtime),
    outputTokenLimitFidelity: runtimeOutputTokenLimitFidelity(candidate.runtime),
    ...(candidate.estimatedUsdPer1kTokens === undefined ? {} : {
      estimatedUsdPer1kTokens: candidate.estimatedUsdPer1kTokens,
    }),
  }));
  const identity: FieldworkExecutionIdentity = {
    mode: "runtime",
    role: binding.role,
    candidates: identities,
    budget: { ...binding.budget },
    authorization: {
      mode: "file-ledger-v1",
      ...(binding.maxTokensPerAttempt === undefined ? {} : {
        maxTokensPerAttempt: binding.maxTokensPerAttempt,
      }),
    },
    providerOperations: {
      concurrency: binding.concurrency ?? 1,
      batchSize: binding.batchSize ?? 1,
      ...(binding.maxProviderCalls === undefined ? {} : {
        maxProviderCalls: binding.maxProviderCalls,
      }),
      ...(binding.maxChunks === undefined ? {} : {
        maxChunks: binding.maxChunks,
      }),
    },
    minimumStructuredToolsFidelity: minimumFidelity,
    maxOutputTokens,
  };
  fieldworkStoredExecutionSchema.shape.identity.parse(identity);
  return identity;
}

export function createFieldworkRuntimeSession(
  binding: FieldworkRuntimeBinding,
  options: FieldworkRuntimeSessionOptions,
): FieldworkRuntimeSession {
  const identity = createFieldworkExecutionIdentity(binding);
  const minimumFidelity = identity.minimumStructuredToolsFidelity;
  const maxOutputTokens = identity.maxOutputTokens;
  const receipts: DispatchReceipt[] = [];
  const authorizationLedger = new FileAuthorizationLedger({ root: options.authorizationRoot });
  let invocationSequence = 0;
  let lastFailure: FieldworkRuntimeAttemptFailure | undefined;
  const runtimes = new Map(binding.candidates.map((candidate) => [
    candidate.runtime.id,
    recordingFailures(candidate.runtime, (failure) => { lastFailure = failure; }),
  ]));
  const primaryCapabilities = binding.candidates[0]!.runtime.capabilities();
  const physicalBatch = primaryCapabilities.physicalBatch === true
    && typeof binding.candidates[0]!.runtime.invokeBatch === "function"
    && Number.isInteger(primaryCapabilities.maxBatchSize)
    && primaryCapabilities.maxBatchSize! > 0;
  const candidates: ExecutionCandidate[] = binding.candidates.map((candidate, index) => ({
    id: candidate.id,
    runtimeId: candidate.runtime.id,
    evidence: {
      level: "declared",
      capabilities: identity.candidates[index]!.structuredToolsFidelity === "unavailable" ? [] : ["structured-tools"],
      structuredToolsFidelity: identity.candidates[index]!.structuredToolsFidelity,
      source: "runtime-capabilities",
    },
    ...(candidate.estimatedUsdPer1kTokens === undefined ? {} : {
      estimatedUsdPer1kTokens: candidate.estimatedUsdPer1kTokens,
    }),
    ...(binding.maxTokensPerAttempt === undefined ? {} : {
      worstCaseUsage: {
        maxTokens: binding.maxTokensPerAttempt,
        ...(candidate.estimatedUsdPer1kTokens === undefined ? {} : {
          maxCostUsd: binding.maxTokensPerAttempt * candidate.estimatedUsdPer1kTokens / 1_000,
        }),
      },
    }),
  }));
  const runtime = createDispatchRuntime({
    id: `fieldwork-dispatch:${binding.role}`,
    capabilities: {
      structuredTools: true,
      structuredToolsFidelity: minimumFidelity,
      outputTokenLimitFidelity: "unavailable",
      streaming: false,
      abort: true,
      usage: true,
      ...(physicalBatch ? {
        physicalBatch: true,
        maxBatchSize: primaryCapabilities.maxBatchSize!,
      } : {}),
    },
    runtimes: { get: (runtimeId) => runtimes.get(runtimeId) },
    authorizationLedger,
    plan: (request) => {
      invocationSequence += 1;
      return {
        schemaVersion: 1,
        role: binding.role,
        candidates,
        budget: remainingBudget(binding.budget, receipts),
        authorization: {
          schemaVersion: 1,
          id: options.authorizationId,
          invocationId: `invoke-${invocationSequence}-${invocationDigest(request).slice(0, 32)}`,
          limits: {
            maxAttempts: binding.budget.maxAttempts,
            ...(binding.budget.maxTotalTokens === undefined ? {} : {
              maxTotalTokens: binding.budget.maxTotalTokens,
            }),
            ...(binding.budget.maxCostUsd === undefined ? {} : {
              maxCostUsd: binding.budget.maxCostUsd,
            }),
          },
        },
        policy: {
          requiredCapabilities: ["structured-tools"],
          minimumEvidence: "declared",
          minimumStructuredToolsFidelity: minimumFidelity,
          retryRuntimeFailures: true,
        },
      };
    },
    onReceipt: (receipt) => {
      if (receipts.length >= MAX_RUNTIME_RECEIPTS) throw new Error("Fieldwork runtime receipt limit reached");
      receipts.push(receipt);
      receipts.sort((left, right) => receiptSequence(left) - receiptSequence(right));
    },
  });
  const execution: FieldworkStoredExecution = { identity, receipts };
  fieldworkStoredExecutionSchema.parse(execution);
  return {
    provider: createRelayExtractionProvider({ runtime, maxTokens: maxOutputTokens }),
    execution,
    lastFailure: () => lastFailure,
  };
}

/**
 * The same runtime, reporting each failed attempt before passing the failure
 * on unchanged. Dispatch still sees and classifies the original error.
 */
function recordingFailures(runtime: ModelRuntime, record: (failure: FieldworkRuntimeAttemptFailure) => void): ModelRuntime {
  const note = (reason: unknown): void => {
    const code = (reason as { code?: unknown } | null)?.code;
    const message = (reason as { message?: unknown } | null)?.message;
    record({
      runtimeId: runtime.id,
      code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "RUNTIME_FAILURE",
      message: boundedLine(typeof message === "string" ? message : ""),
    });
  };
  const invokeBatch = runtime.invokeBatch?.bind(runtime);
  return {
    id: runtime.id,
    capabilities: () => runtime.capabilities(),
    invoke: async (request, options) => {
      try { return await runtime.invoke(request, options); }
      catch (error) { note(error); throw error; }
    },
    ...(invokeBatch === undefined ? {} : {
      invokeBatch: async (requests, options) => {
        try {
          const outcomes = await invokeBatch(requests, options);
          for (const outcome of outcomes) if (outcome.status === "rejected") note(outcome.reason);
          return outcomes;
        } catch (error) { note(error); throw error; }
      },
    }),
  };
}

const WITHHELD_WORDS = ["key", "token", "secret", "password", "passwd", "authorization", "bearer", "cookie", "session", "credential"];

/**
 * Whether a runtime's error message may be printed. A runtime's message is
 * whatever the CLI or SDK behind it wrote, and no list of secret shapes is
 * complete, so this is an allowlist: the message is shown only when it reads
 * as plain prose. All of these must hold, and the error code and runtime id
 * are reported either way:
 *
 * - every character is a letter, a digit, a space or one of `, . ' ( ) : ; - _`,
 *   which rules out paths, URLs, assignments, headers and query strings;
 * - it names nothing credential-like: none of `WITHHELD_WORDS` anywhere in
 *   it (outside the phrase "session limit"), nor the word `sig`;
 * - no word of 12 or more characters mixes letters and digits, and no word
 *   is 24 or more characters long (an identifier, a hash, an encoded blob);
 * - it is at most `MAX_FAILURE_MESSAGE_CHARS` characters.
 */
export function runtimeMessageIsPlain(message: string): boolean {
  if (message.length > MAX_FAILURE_MESSAGE_CHARS) return false;
  if (!/^[A-Za-z0-9 ,.'():;_-]*$/u.test(message)) return false;
  // "session limit" is Relay's fixed phrase for a CLI's session usage limit,
  // not a session credential; any other mention of "session" still withholds.
  const lower = message.toLowerCase().replace(/\bsession limit\b/gu, "");
  if (WITHHELD_WORDS.some((word) => lower.includes(word)) || /(?:^|[^a-z0-9])sig(?:[^a-z0-9]|$)/u.test(lower)) return false;
  return message.split(/[^A-Za-z0-9_-]+/u)
    .every((word) => word.length < 24 && !(word.length >= 12 && /[0-9]/u.test(word) && /[A-Za-z]/u.test(word)));
}

/**
 * `text` on one line, kept to one character past the message bound: enough to
 * tell an over-long message from one that fits, and never the whole of it.
 */
function boundedLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.slice(0, MAX_FAILURE_MESSAGE_CHARS + 1);
}

function receiptSequence(receipt: DispatchReceipt): number {
  const match = /^invoke-(\d+)-/.exec(receipt.authorization?.invocationId ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function remainingBudget(budget: FieldworkRuntimeBudget, receipts: readonly DispatchReceipt[]): ExecutionBudget {
  const usedAttempts = receipts.reduce((sum, receipt) => sum + receipt.attempts.length, 0);
  const usedElapsed = receipts.reduce((sum, receipt) => sum + receipt.totalElapsedMs, 0);
  const usedTokens = receipts.reduce((sum, receipt) => sum + receipt.totalTokens, 0);
  const usedCost = receipts.reduce((sum, receipt) => sum + receipt.estimatedCostUsd, 0);
  const exhausted = usedAttempts >= budget.maxAttempts
    || (budget.maxElapsedMs !== undefined && usedElapsed >= budget.maxElapsedMs)
    || (budget.maxTotalTokens !== undefined && usedTokens >= budget.maxTotalTokens)
    || (budget.maxCostUsd !== undefined && usedCost >= budget.maxCostUsd);
  if (exhausted) return { maxAttempts: 1, maxTotalTokens: 0 };
  return {
    maxAttempts: Math.max(1, budget.maxAttempts - usedAttempts),
    ...(budget.maxElapsedMs === undefined ? {} : { maxElapsedMs: budget.maxElapsedMs - usedElapsed }),
    ...(budget.maxTotalTokens === undefined ? {} : { maxTotalTokens: budget.maxTotalTokens - usedTokens }),
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd - usedCost }),
  };
}
