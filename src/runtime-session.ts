import {
  createDispatchRuntime,
  FileAuthorizationLedger,
  type DispatchReceipt,
  type ExecutionBudget,
  type ExecutionCandidate,
} from "@kontourai/dispatch";
import { invocationDigest } from "@kontourai/relay";
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
}

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
      ...(binding.maxProviderCalls === undefined ? {} : {
        maxProviderCalls: binding.maxProviderCalls,
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
  const runtimes = new Map(binding.candidates.map((candidate) => [candidate.runtime.id, candidate.runtime]));
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
  };
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
