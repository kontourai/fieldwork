import { resolve, resolveRef, type ResolveOptions } from "@kontourai/datum";
import type { DispatchReceipt } from "@kontourai/dispatch";
import { bindDatumResolvedRef } from "@kontourai/dispatch/datum";
import type { ModelRuntime } from "@kontourai/relay";
import {
  createModelRuntimeProfile,
  parseModelRuntimeProfile,
} from "@kontourai/relay/runtime-profile";
import { z } from "zod";

export const MAX_RUNTIME_CANDIDATES = 16;
export const MAX_RUNTIME_RECEIPTS = 1_024;
const boundedId = z.string().min(1).max(256);
const finitePositive = z.number().finite().positive();

export interface FieldworkRuntimeBudget {
  readonly maxAttempts: number;
  readonly maxElapsedMs?: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
}

export interface FieldworkRuntimeCandidate {
  readonly id: string;
  readonly runtime: ModelRuntime;
  readonly estimatedUsdPer1kTokens?: number;
}

export interface FieldworkRuntimeBinding {
  readonly role: string;
  readonly candidates: readonly FieldworkRuntimeCandidate[];
  readonly budget: FieldworkRuntimeBudget;
  /**
   * Caller-declared worst-case total token use for one physical provider
   * attempt. Required when the authorization has a token or cost ceiling.
   */
  readonly maxTokensPerAttempt?: number;
  /** Maximum chunk-level model invocations in flight. */
  readonly concurrency?: number;
  /** Maximum Traverse provider operations; Dispatch separately caps model attempts. */
  readonly maxProviderCalls?: number;
  readonly minimumStructuredToolsFidelity?: "native" | "prompted";
  readonly maxOutputTokens?: number;
}

export interface FieldworkExecutionIdentity {
  readonly mode: "runtime";
  readonly role: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly runtimeId: string;
    readonly structuredToolsFidelity: "native" | "prompted" | "unavailable";
    readonly outputTokenLimitFidelity: "native" | "approximated" | "unavailable";
    readonly estimatedUsdPer1kTokens?: number;
  }[];
  readonly budget: FieldworkRuntimeBudget;
  readonly authorization: {
    readonly mode: "file-ledger-v1";
    readonly maxTokensPerAttempt?: number;
  };
  readonly providerOperations: {
    readonly concurrency: number;
    readonly maxProviderCalls?: number;
  };
  readonly minimumStructuredToolsFidelity: "native" | "prompted";
  readonly maxOutputTokens: number;
}

export interface FieldworkStoredExecution {
  readonly identity: FieldworkExecutionIdentity | { readonly mode: "fixture-v1" };
  readonly receipts: readonly DispatchReceipt[];
}

export interface ProfileRuntimeBindingOptions {
  readonly profiles: readonly string[];
  readonly role?: string;
  readonly budget: FieldworkRuntimeBudget;
  readonly minimumStructuredToolsFidelity?: "native" | "prompted";
  readonly maxOutputTokens?: number;
  readonly maxTokensPerAttempt?: number;
  readonly concurrency?: number;
  readonly maxProviderCalls?: number;
  readonly cwd?: string;
  readonly allowPromptedStructuredOutput?: boolean;
  readonly estimatedUsdPer1kTokens?: number;
}

export interface DatumRuntimeBindingOptions {
  readonly role: string;
  readonly budget: FieldworkRuntimeBudget;
  readonly maxOutputTokens?: number;
  readonly maxTokensPerAttempt?: number;
  readonly concurrency?: number;
  readonly maxProviderCalls?: number;
  readonly estimatedUsdPer1kTokens?: number;
  readonly resolve?: ResolveOptions;
}

const attemptSchema = z.object({
  candidateId: boundedId,
  runtimeId: boundedId,
  outcome: z.enum(["succeeded", "failed"]),
  structuredToolsFidelity: z.enum(["unavailable", "prompted", "native"]).optional(),
  elapsedMs: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
  errorCode: boundedId.optional(),
  retryable: z.boolean().optional(),
  reservationId: boundedId.optional(),
  reservationState: z.enum(["reserved", "settled"]).optional(),
}).strict();

export const fieldworkStoredExecutionSchema = z.object({
  identity: z.union([
    z.object({ mode: z.literal("fixture-v1") }).strict(),
    z.object({
      mode: z.literal("runtime"),
      role: boundedId,
      candidates: z.array(z.object({
        id: boundedId,
        runtimeId: boundedId,
        structuredToolsFidelity: z.enum(["native", "prompted", "unavailable"]),
        outputTokenLimitFidelity: z.enum(["native", "approximated", "unavailable"]),
        estimatedUsdPer1kTokens: finitePositive.optional(),
      }).strict()).min(1).max(MAX_RUNTIME_CANDIDATES),
      budget: z.object({
        maxAttempts: z.number().int().positive(),
        maxElapsedMs: z.number().int().positive().optional(),
        maxTotalTokens: z.number().int().positive().optional(),
        maxCostUsd: finitePositive.optional(),
      }).strict(),
      authorization: z.object({
        mode: z.literal("file-ledger-v1"),
        maxTokensPerAttempt: z.number().int().positive().optional(),
      }).strict(),
      providerOperations: z.object({
        concurrency: z.number().int().positive().max(32),
        maxProviderCalls: z.number().int().positive().optional(),
      }).strict(),
      minimumStructuredToolsFidelity: z.enum(["native", "prompted"]),
      maxOutputTokens: z.number().int().positive(),
    }).strict(),
  ]),
  receipts: z.array(z.object({
    schemaVersion: z.literal(1),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    role: boundedId,
    outcome: z.enum(["succeeded", "aborted", "exhausted", "budget-exceeded", "no-eligible-candidates"]),
    attempts: z.array(attemptSchema).max(MAX_RUNTIME_CANDIDATES),
    totalElapsedMs: z.number().finite().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().finite().nonnegative(),
    authorization: z.object({
      id: boundedId,
      invocationId: boundedId,
      outcome: z.enum(["reserved", "settled", "exhausted"]),
    }).strict().optional(),
  }).strict()).max(MAX_RUNTIME_RECEIPTS),
}).strict();

export function createProfileRuntimeBinding(options: ProfileRuntimeBindingOptions): FieldworkRuntimeBinding {
  if (options.profiles.length === 0 || options.profiles.length > MAX_RUNTIME_CANDIDATES) {
    throw new Error(`Fieldwork requires between 1 and ${MAX_RUNTIME_CANDIDATES} runtime profiles`);
  }
  const candidates = options.profiles.map((value, index) => {
    const profile = parseModelRuntimeProfile(value);
    const runtime = createModelRuntimeProfile({
      ...profile,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.allowPromptedStructuredOutput ? { allowPromptedStructuredOutput: true } : {}),
    });
    return {
      id: `profile-${index + 1}`,
      runtime,
      ...(options.estimatedUsdPer1kTokens === undefined ? {} : {
        estimatedUsdPer1kTokens: options.estimatedUsdPer1kTokens,
      }),
    };
  });
  return {
    role: options.role ?? "fieldwork-extraction",
    candidates,
    budget: options.budget,
    ...(options.maxTokensPerAttempt === undefined ? {} : {
      maxTokensPerAttempt: options.maxTokensPerAttempt,
    }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.maxProviderCalls === undefined ? {} : { maxProviderCalls: options.maxProviderCalls }),
    ...(options.minimumStructuredToolsFidelity ? {
      minimumStructuredToolsFidelity: options.minimumStructuredToolsFidelity,
    } : {}),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
  };
}

export function createDatumRuntimeBinding(options: DatumRuntimeBindingOptions): FieldworkRuntimeBinding {
  const described = resolveRef(options.role, options.resolve);
  if (described.kind !== "anthropic-compatible") {
    throw new Error(`Fieldwork direct SDK mode does not support Datum provider kind ${described.kind}; supply a Relay runtime from the host`);
  }
  const target = resolve(options.role, options.resolve);
  if (described.provider !== target.provider || described.model !== target.model || described.kind !== target.kind) {
    throw new Error("Datum resolution changed while materializing the runtime target");
  }
  const datum = bindDatumResolvedRef(options.role, described, {
    ...(options.estimatedUsdPer1kTokens === undefined ? {} : {
      estimatedUsdPer1kTokens: options.estimatedUsdPer1kTokens,
    }),
  });
  const credentialOption: "apiKey" = ["api", "Key"].join("") as "apiKey";
  const created = createModelRuntimeProfile({
    profile: "anthropic",
    model: target.model,
    [credentialOption]: target.apiKey,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
  });
  const runtime: ModelRuntime = {
    id: datum.target.runtimeId,
    capabilities: () => created.capabilities(),
    invoke: (request, invocationOptions) => created.invoke(request, invocationOptions),
  };
  return {
    role: options.role,
    candidates: [{
      id: datum.candidate.id,
      runtime,
      ...(options.estimatedUsdPer1kTokens === undefined ? {} : {
        estimatedUsdPer1kTokens: options.estimatedUsdPer1kTokens,
      }),
    }],
    budget: options.budget,
    ...(options.maxTokensPerAttempt === undefined ? {} : {
      maxTokensPerAttempt: options.maxTokensPerAttempt,
    }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.maxProviderCalls === undefined ? {} : { maxProviderCalls: options.maxProviderCalls }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
  };
}

export function validateRuntimeBinding(binding: FieldworkRuntimeBinding): void {
  boundedId.parse(binding.role);
  if (binding.candidates.length === 0 || binding.candidates.length > MAX_RUNTIME_CANDIDATES) {
    throw new Error(`Fieldwork requires between 1 and ${MAX_RUNTIME_CANDIDATES} runtime candidates`);
  }
  z.number().int().positive().parse(binding.budget.maxAttempts);
  if (binding.budget.maxElapsedMs !== undefined) z.number().int().positive().parse(binding.budget.maxElapsedMs);
  if (binding.budget.maxTotalTokens !== undefined) z.number().int().positive().parse(binding.budget.maxTotalTokens);
  if (binding.budget.maxCostUsd !== undefined) finitePositive.parse(binding.budget.maxCostUsd);
  if (binding.maxOutputTokens !== undefined) z.number().int().positive().parse(binding.maxOutputTokens);
  if (binding.maxTokensPerAttempt !== undefined) z.number().int().positive().parse(binding.maxTokensPerAttempt);
  if (binding.concurrency !== undefined) z.number().int().positive().max(32).parse(binding.concurrency);
  if (binding.maxProviderCalls !== undefined) z.number().int().positive().parse(binding.maxProviderCalls);
  const candidateIds = new Set<string>();
  const runtimeIds = new Set<string>();
  for (const candidate of binding.candidates) {
    boundedId.parse(candidate.id);
    boundedId.parse(candidate.runtime.id);
    if (candidateIds.has(candidate.id)) throw new Error(`Duplicate Fieldwork runtime candidate id: ${candidate.id}`);
    if (runtimeIds.has(candidate.runtime.id)) throw new Error(`Duplicate Fieldwork runtime id: ${candidate.runtime.id}`);
    candidateIds.add(candidate.id);
    runtimeIds.add(candidate.runtime.id);
    if (candidate.estimatedUsdPer1kTokens !== undefined) finitePositive.parse(candidate.estimatedUsdPer1kTokens);
  }
  if (binding.budget.maxCostUsd !== undefined
    && binding.candidates.some((candidate) => candidate.estimatedUsdPer1kTokens === undefined)) {
    throw new Error("Fieldwork maxCostUsd requires an estimatedUsdPer1kTokens rate for every candidate");
  }
  if (binding.budget.maxCostUsd !== undefined
    && binding.candidates.some((candidate) => runtimeOutputTokenLimitFidelity(candidate.runtime) !== "native")) {
    throw new Error("Fieldwork maxCostUsd requires native output-token limit fidelity for every candidate");
  }
  if ((binding.budget.maxTotalTokens !== undefined || binding.budget.maxCostUsd !== undefined)
    && binding.maxTokensPerAttempt === undefined) {
    throw new Error("Fieldwork token and cost ceilings require maxTokensPerAttempt worst-case capacity");
  }
}

export function runtimeStructuredToolsFidelity(runtime: ModelRuntime): "native" | "prompted" | "unavailable" {
  const capabilities = runtime.capabilities();
  if (!capabilities.structuredTools) return "unavailable";
  return capabilities.structuredToolsFidelity ?? "unavailable";
}

export function runtimeOutputTokenLimitFidelity(runtime: ModelRuntime): "native" | "approximated" | "unavailable" {
  return runtime.capabilities().outputTokenLimitFidelity ?? "unavailable";
}
