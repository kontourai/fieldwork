import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildSemanticReviewWork,
  createObservationStore,
  type ProposalSetObservation,
  type SemanticReviewChange,
  type StoredProposalObservationV1,
} from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import type { ReviewItem } from "@kontourai/survey";
import { initialReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { parseFieldworkTask, traverseTask } from "./contracts.js";
import type {
  FieldworkSourceAdapters,
  FieldworkRunResult,
  FieldworkTask,
  JsonObject,
  RunOptions,
} from "./api-contracts.js";
import { runFieldwork } from "./fieldwork.js";
import {
  assertPortableOutput,
  readRun,
  saveReview,
} from "./run-store.js";
import type { FieldworkRuntimeBinding } from "./runtime-contracts.js";

export type FieldworkRecheckClassification =
  | "unchanged-source"
  | "source-unavailable"
  | "task-drift"
  | "preparation-drift"
  | "stable-proposals"
  | "semantic-drift";

export interface FieldworkRecheckAcquisition {
  check(source: FieldworkLookoutSource): Promise<FieldworkCheckResult>;
}

export type FieldworkLookoutSource =
  | {
      readonly id: string;
      readonly url: string;
      readonly cadenceHint: string;
      readonly kind: "web-page" | "api-record";
      readonly targetSchema: FieldworkTask["spec"]["traverse"]["targetSchema"];
      readonly renderPolicy: "never" | "on-shell-warning" | "always";
    }
  | {
      readonly id: string;
      readonly url: string;
      readonly cadenceHint: string;
      readonly kind: "structured-file";
      readonly format: "yaml" | "json" | "csv";
    };

interface FieldworkCheckCommon {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly checkedAt: string;
  readonly warnings: readonly string[];
}
export type FieldworkCheckResult =
  | (FieldworkCheckCommon & { readonly kind: "unchanged-304"; readonly snapshotRef: string })
  | (FieldworkCheckCommon & {
      readonly kind: "unchanged-hash";
      readonly priorSnapshotRef: string;
      readonly currentSnapshotRef: string;
    })
  | (FieldworkCheckCommon & {
      readonly kind: "changed";
      readonly priorSnapshotRef: string | null;
      readonly currentSnapshotRef: string;
      readonly changeBasis: "initial" | "hash";
    })
  | (FieldworkCheckCommon & {
      readonly kind: "error";
      readonly origin: "forage" | "lookout";
      readonly error: unknown;
    });

export interface FieldworkRecheckOptions {
  readonly source: FieldworkLookoutSource;
  readonly priorRunDirectory: string;
  readonly taskPath: string;
  readonly acquisition: FieldworkRecheckAcquisition;
  readonly root?: string;
  readonly observationRoot?: string;
  readonly snapshotRoot?: string;
  readonly runtime?: FieldworkRuntimeBinding;
  readonly sourceAdapters?: FieldworkSourceAdapters;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}

export interface FieldworkEvidenceObservation {
  readonly observationId: string;
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly observedAt: string;
  /** Portable proposal JSON; Traverse remains the semantic schema owner. */
  readonly proposals: readonly JsonObject[];
}

export interface FieldworkRecheckResult {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "FieldworkRecheckResult";
  readonly classification: FieldworkRecheckClassification;
  readonly check: FieldworkCheckResult;
  readonly providerSkipped: boolean;
  readonly priorObservation: FieldworkEvidenceObservation;
  readonly currentObservation: FieldworkEvidenceObservation | null;
  readonly review: {
    readonly transitionId: string | null;
    readonly itemCount: number;
    readonly items: readonly JsonObject[];
  };
  readonly run: FieldworkRunResult | null;
}

/**
 * Recheck one registered source without changing the earlier run or its review
 * history. Lookout owns source/proposal continuity and semantic diffing; a new
 * Fieldwork run owns any resulting Survey review round.
 */
export async function recheckFieldwork(options: FieldworkRecheckOptions): Promise<FieldworkRecheckResult> {
  const prior = await readRun(options.priorRunDirectory);
  const task = parseFieldworkTask(JSON.parse(await readFile(options.taskPath, "utf8")));
  if ("targetSchema" in options.source
    && canonicalJson(options.source.targetSchema) !== canonicalJson(traverseTask(task).targetSchema)) {
    throw withCode("RECHECK_SCHEMA_MISMATCH", "Lookout source schema does not match the selected Fieldwork task");
  }
  const check = await options.acquisition.check(options.source);
  assertCheckIdentity(check, options.source);

  const store = createObservationStore({
    root: resolve(options.observationRoot ?? join(options.root ?? ".fieldwork/runs", ".lookout-observations")),
  });
  const priorObservation = observationFor(options.source.id, prior.envelope);
  const priorStored = await establishPrior(store, priorObservation, options.now?.() ?? prior.run.createdAt);
  assertCheckContinuity(check, priorStored.snapshotRef);

  if (canonicalJson(task) !== canonicalJson(prior.run.task)) {
    return portableResult({
      classification: "task-drift",
      check,
      providerSkipped: true,
      priorObservation: evidence(priorStored),
    });
  }
  if (check.kind === "error") {
    return portableResult({
      classification: "source-unavailable",
      check,
      providerSkipped: true,
      priorObservation: evidence(priorStored),
    });
  }
  if (check.kind === "unchanged-304" || check.kind === "unchanged-hash") {
    return portableResult({
      classification: "unchanged-source",
      check,
      providerSkipped: true,
      priorObservation: evidence(priorStored),
    });
  }

  let currentRun: FieldworkRunResult;
  try {
    currentRun = await runFieldwork(runOptions(options, check.currentSnapshotRef));
  } catch (cause) {
    throw withCode("RECHECK_EXTRACTION_FAILED", "Changed source could not be extracted", cause);
  }
  const current = await readRun(currentRun.runDirectory);
  const currentObservation = observationFor(options.source.id, current.envelope);
  if (current.run.runResource === prior.run.runResource) {
    throw withCode("RECHECK_CONFLICT", "Changed source resolved to the selected prior run");
  }
  if (current.run.review.events.length !== 0 || current.run.review.revision !== 0) {
    throw withCode("RECHECK_CONFLICT", "Existing current run already has review history");
  }

  if (preparationChangedWithoutTaskChange(prior, current)) {
    return portableResult({
      classification: "preparation-drift",
      check,
      providerSkipped: false,
      priorObservation: evidence(priorStored),
      currentObservation: evidence({
        observationId: digestObservation(currentObservation),
        ...currentObservation,
      }),
      items: current.run.review.snapshot.items as unknown as JsonObject[],
      run: currentRun,
    });
  }

  const committed = await store.commit({
    observation: currentObservation,
    recordedAt: options.now?.() ?? new Date().toISOString(),
    check: {
      checkedAt: check.checkedAt,
      resultKind: "changed",
      currentSnapshotRef: check.currentSnapshotRef,
    },
  }, priorStored.observationId);
  if (!committed.ok) {
    const code = committed.error.kind === "continuity-conflict" ? "RECHECK_CONFLICT" : "RECHECK_OBSERVATION_FAILED";
    throw withCode(code, "Source observation could not be committed", committed.error);
  }

  const semantic = buildSemanticReviewWork({
    prior: priorObservation,
    current: currentObservation,
    observationIdentity: {
      prior: priorStored.observationId,
      current: committed.value.observationId,
    },
    selectEntities: (observation) => [observation],
    entityIdentity: (observation) => observation.sourceId,
    proposalsFor: (observation) => observation.proposals,
    fieldIdentity: (_observation, proposal) => proposal.fieldPath,
    claimTarget: (change) => claimTarget(task, change),
  });
  if (!semantic.ok) {
    throw withCode("RECHECK_DIFF_FAILED", "Proposal observations could not be compared", semantic.error);
  }

  const items = semantic.value.items as unknown as ReviewItem[];
  await saveReview(current.directory, current.run, {
    snapshot: initialReviewQueueSessionState(items),
    events: [],
    revision: 0,
  });
  const result = portableResult({
    classification: items.length === 0 ? "stable-proposals" : "semantic-drift",
    check,
    providerSkipped: false,
    priorObservation: evidence(priorStored),
    currentObservation: evidence(committed.value),
    transitionId: semantic.value.transitionId,
    items: semantic.value.items as unknown as JsonObject[],
    run: currentRun,
  });
  return result;
}

type ObservationStore = ReturnType<typeof createObservationStore>;
type StoredObservation = StoredProposalObservationV1;

async function establishPrior(
  store: ObservationStore,
  observation: ProposalSetObservation,
  recordedAt: string,
): Promise<StoredObservation> {
  const loaded = await store.loadLatest(observation.sourceId);
  if (!loaded.ok) throw withCode("RECHECK_OBSERVATION_FAILED", "Prior observation could not be loaded", loaded.error);
  if (loaded.value) {
    if (sameObservation(loaded.value, observation)) return loaded.value;
    throw withCode("RECHECK_CONFLICT", "Stored source continuity does not match the selected prior run");
  }
  const committed = await store.commit({
    observation,
    recordedAt,
    check: {
      checkedAt: observation.observedAt,
      resultKind: "changed",
      currentSnapshotRef: observation.snapshotRef,
    },
  }, null);
  if (committed.ok) return committed.value;
  if (committed.error.kind === "continuity-conflict") {
    const raced = await store.loadLatest(observation.sourceId);
    if (raced.ok && raced.value && sameObservation(raced.value, observation)) return raced.value;
  }
  throw withCode(
    committed.error.kind === "continuity-conflict" ? "RECHECK_CONFLICT" : "RECHECK_OBSERVATION_FAILED",
    "Prior observation could not be established",
    committed.error,
  );
}

function observationFor(
  sourceId: string,
  envelope: Awaited<ReturnType<typeof readRun>>["envelope"],
): ProposalSetObservation {
  if (!envelope.source.snapshotRef) {
    throw withCode("RECHECK_OBSERVATION_FAILED", "Stored extraction is missing snapshot identity");
  }
  return {
    sourceId,
    snapshotRef: envelope.source.snapshotRef,
    observedAt: envelope.result.extractedAt,
    proposals: envelope.result.proposals,
  };
}

function evidence(observation: {
  observationId: string;
  sourceId: string;
  snapshotRef: string;
  observedAt: string;
  proposals: readonly ExtractionProposal[];
}): FieldworkEvidenceObservation {
  return {
    observationId: observation.observationId,
    sourceId: observation.sourceId,
    snapshotRef: observation.snapshotRef,
    observedAt: observation.observedAt,
    proposals: observation.proposals as unknown as readonly JsonObject[],
  };
}

function claimTarget(task: FieldworkTask, change: SemanticReviewChange) {
  const projection = task.spec.projections.find((candidate) => candidate.fieldPath === change.fieldPath);
  if (!projection) throw new Error(`No claim target for ${change.fieldPath}`);
  return { ...projection.claim, fieldOrBehavior: change.fieldPath };
}

function runOptions(options: FieldworkRecheckOptions, snapshotRef: string): RunOptions {
  return {
    taskPath: options.taskPath,
    snapshotRef,
    ...(options.snapshotRoot === undefined ? {} : { snapshotRoot: options.snapshotRoot }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.sourceAdapters === undefined ? {} : { sourceAdapters: options.sourceAdapters }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function preparationChangedWithoutTaskChange(
  prior: Awaited<ReturnType<typeof readRun>>,
  current: Awaited<ReturnType<typeof readRun>>,
): boolean {
  return prior.envelope.source.snapshotRef === current.envelope.source.snapshotRef
    && prior.run.preparedArtifact.digest !== current.run.preparedArtifact.digest;
}

function assertCheckIdentity(check: FieldworkCheckResult, source: FieldworkLookoutSource): void {
  if (check.sourceId !== source.id || check.sourceUrl !== source.url) {
    throw withCode("RECHECK_SOURCE_MISMATCH", "Lookout check does not identify the requested source");
  }
}

function assertCheckContinuity(check: FieldworkCheckResult, priorSnapshotRef: string): void {
  const referencedPrior = check.kind === "unchanged-304"
    ? check.snapshotRef
    : check.kind === "unchanged-hash" || check.kind === "changed"
      ? check.priorSnapshotRef
      : null;
  if (check.kind !== "error" && referencedPrior !== priorSnapshotRef) {
    throw withCode("RECHECK_CONFLICT", "Lookout check does not continue from the selected prior run");
  }
}

function sameObservation(
  stored: { sourceId: string; snapshotRef: string; observedAt: string; proposals: readonly ExtractionProposal[] },
  observation: ProposalSetObservation,
): boolean {
  return stored.sourceId === observation.sourceId
    && stored.snapshotRef === observation.snapshotRef
    && stored.observedAt === observation.observedAt
    && canonicalJson(stored.proposals) === canonicalJson(observation.proposals);
}

function portableResult(input: {
  classification: FieldworkRecheckClassification;
  check: FieldworkCheckResult;
  providerSkipped: boolean;
  priorObservation: FieldworkEvidenceObservation;
  currentObservation?: FieldworkEvidenceObservation;
  transitionId?: string;
  items?: readonly JsonObject[];
  run?: FieldworkRunResult;
}): FieldworkRecheckResult {
  const result: FieldworkRecheckResult = {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkRecheckResult",
    classification: input.classification,
    check: input.check,
    providerSkipped: input.providerSkipped,
    priorObservation: input.priorObservation,
    currentObservation: input.currentObservation ?? null,
    review: {
      transitionId: input.transitionId ?? null,
      itemCount: input.items?.length ?? 0,
      items: input.items ?? [],
    },
    run: input.run ?? null,
  };
  assertPortableOutput({
    classification: result.classification,
    check: result.check,
    priorObservation: result.priorObservation,
    currentObservation: result.currentObservation,
    review: result.review,
  });
  return result;
}

function digestObservation(observation: ProposalSetObservation): string {
  return createHash("sha256").update(canonicalJson(observation)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withCode(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}
