import {
  createDispatchRuntime,
  type DispatchReceipt,
  type ExecutionBudget,
  type ExecutionCandidate,
} from "@kontourai/dispatch";
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

export function createFieldworkRuntimeSession(binding: FieldworkRuntimeBinding): FieldworkRuntimeSession {
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
    minimumStructuredToolsFidelity: minimumFidelity,
    maxOutputTokens,
  };
  const receipts: DispatchReceipt[] = [];
  const runtimes = new Map(binding.candidates.map((candidate) => [candidate.runtime.id, candidate.runtime]));
  const candidates: ExecutionCandidate[] = binding.candidates.map((candidate, index) => ({
    id: candidate.id,
    runtimeId: candidate.runtime.id,
    evidence: {
      level: "declared",
      capabilities: identities[index]!.structuredToolsFidelity === "unavailable" ? [] : ["structured-tools"],
      structuredToolsFidelity: identities[index]!.structuredToolsFidelity,
      source: "runtime-capabilities",
    },
    ...(candidate.estimatedUsdPer1kTokens === undefined ? {} : {
      estimatedUsdPer1kTokens: candidate.estimatedUsdPer1kTokens,
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
    plan: () => ({
      schemaVersion: 1,
      role: binding.role,
      candidates,
      budget: remainingBudget(binding.budget, receipts),
      policy: {
        requiredCapabilities: ["structured-tools"],
        minimumEvidence: "declared",
        minimumStructuredToolsFidelity: minimumFidelity,
        retryRuntimeFailures: true,
      },
    }),
    onReceipt: (receipt) => {
      if (receipts.length >= MAX_RUNTIME_RECEIPTS) throw new Error("Fieldwork runtime receipt limit reached");
      receipts.push(receipt);
    },
  });
  const execution: FieldworkStoredExecution = { identity, receipts };
  fieldworkStoredExecutionSchema.parse(execution);
  return {
    provider: createRelayExtractionProvider({ runtime, maxTokens: maxOutputTokens }),
    execution,
  };
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
