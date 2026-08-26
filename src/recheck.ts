import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  admitProposalObservation,
  admitSourceCheck,
  buildSemanticReviewWork,
  createObservationStore,
  type ProposalSetObservation,
  type LookoutSource,
  type CheckResult,
  type SemanticReviewChange,
  type StoredProposalObservationV1,
} from "@kontourai/lookout";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  FieldworkSourceCheckReceiptStore,
  type Capture,
} from "./source-check-receipts.js";
import type { ExtractionProposal } from "@kontourai/traverse";
import type { ReviewItem } from "@kontourai/survey";
import { parseFieldworkTask, traverseTask } from "./contracts.js";
import type {
  FieldworkSourceAdapters,
  FieldworkRunResult,
  FieldworkTask,
  JsonObject,
  RunOptions,
} from "./api-contracts.js";
import {
  canonicalSemanticReviewItems,
  FIELDWORK_SOURCE_KIND,
  newReviewRound,
  runFieldwork,
} from "./fieldwork.js";
import { assertPortableOutput, readRun, saveReview, withRunReviewLock } from "./run-store.js";
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
  readonly warnings: string[];
}
/** Fieldwork's closed facade mirrors an owner result without leaking owner declarations. */
export type FieldworkCheckResult =
  | (FieldworkCheckCommon & {
      readonly kind: "unchanged-304";
      readonly snapshotRef: string;
    })
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
  /** Fieldwork-owned receipt root; never shared with Lookout or Survey. */
  readonly receiptRoot?: string;
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
  readonly apiVersion: "fieldwork.kontourai.io/v2";
  readonly kind: "FieldworkRecheckResult";
  readonly classification: FieldworkRecheckClassification;
  /** Distinguishes preflight not-run from completed and failed acquisition. */
  readonly acquisition:
    | { readonly kind: "not-run"; readonly reason: "task-drift" }
    | { readonly kind: "completed" }
    | { readonly kind: "failed" };
  readonly check: FieldworkCheckResult | null;
  readonly providerSkipped: boolean;
  readonly priorObservation: FieldworkEvidenceObservation | null;
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
export async function recheckFieldwork(
  options: FieldworkRecheckOptions,
): Promise<FieldworkRecheckResult> {
  /* Capture every capability and identity before the first await. Callers may
   * mutate their options object while acquisition is suspended; that must not
   * redirect a live operation into another source or private store. */
  const invocation = captureInvocation(options);
  const [prior, taskText] = await Promise.all([
    readRun(invocation.priorRunDirectory),
    readFile(invocation.taskPath, "utf8"),
  ]);
  const task = parseFieldworkTask(
    JSON.parse(taskText),
  );
  if (
    "targetSchema" in invocation.source &&
    canonicalJson(invocation.source.targetSchema) !==
      canonicalJson(traverseTask(task).targetSchema)
  ) {
    throw withCode(
      "RECHECK_SCHEMA_MISMATCH",
      "Lookout source schema does not match the selected Fieldwork task",
    );
  }
  const store = createObservationStore({
    root: resolve(
      invocation.observationRoot ??
        join(invocation.root ?? ".fieldwork/runs", ".lookout-observations"),
    ),
  });
  const priorObservation = observationFor(invocation.source.id, prior.envelope);

  // This is deliberately read-only: task drift is decided before acquisition,
  // receipt pending-state, snapshots, or a synthetic proposal observation.
  if (canonicalJson(task) !== canonicalJson(prior.run.task)) {
    const loaded = await store.loadLatest(invocation.source.id);
    if (!loaded.ok) {
      throw withCode(
        "RECHECK_OBSERVATION_FAILED",
        "Prior observation could not be loaded",
        loaded.error,
      );
    }
    if (loaded.value && !sameObservation(loaded.value, priorObservation)) {
      throw withCode(
        "RECHECK_CONFLICT",
        "Stored source continuity does not match the selected prior run",
      );
    }
    return portableResult({
      classification: "task-drift",
      acquisition: { kind: "not-run", reason: "task-drift" },
      check: null,
      providerSkipped: true,
      priorObservation: loaded.value ? evidence(loaded.value) : null,
    });
  }
  const snapshotStore = createFilesystemSnapshotStore({
    root: invocation.snapshotRoot ?? ".fieldwork/snapshots",
  });
  const priorStored = await establishPrior(
    store,
    snapshotStore,
    invocation.source,
    priorObservation,
    invocation.now?.() ?? prior.run.createdAt,
  );
  const receipts = new FieldworkSourceCheckReceiptStore(
    invocation.receiptRoot ??
      join(invocation.root ?? ".fieldwork/runs", ".source-check-receipts"),
  );
  // Publish pending before network I/O. A later started check therefore makes
  // an earlier completion non-current rather than silently reviving it.
  // Receipt storage freezes its own baseline. This recheck integration remains
  // intentionally narrow while the public currentness reader is completed.
  let priorCapture = await exactReceiptCapture(snapshotStore, priorStored.snapshotRef);
  let expectedAcquisitionRef = priorCapture.snapshotRef;
  const assertAcquisitionHead = async (): Promise<void> => {
    const latest = await snapshotStore.latest(invocation.source.id);
    if (!latest || buildSnapshotSourceRef(latest) !== expectedAcquisitionRef) {
      throw withCode("RECHECK_CONFLICT", "Source acquisition advanced during recheck");
    }
  };
  const readProposalHead = async (): Promise<string | null> => {
    const latest = await store.loadLatest(invocation.source.id);
    if (!latest.ok) throw withCode("RECHECK_OBSERVATION_FAILED", "Proposal head could not be loaded");
    return latest.value?.observationId ?? null;
  };
  // Read the previous immutable receipt against its own proposal witness first.
  // Only after selecting its actual acquisition capture can a new operation
  // fence both heads around every receipt-store callback.
  const existingReceipt = await receipts.readCurrent(invocation.source.id, readProposalHead);
  if (existingReceipt.kind === "available") {
    priorCapture = existingReceipt.receipt.currentCapture;
    expectedAcquisitionRef = priorCapture.snapshotRef;
  } else if (existingReceipt.kind !== "missing") {
    throw withCode("RECHECK_CONFLICT", "Prior source currentness is not available");
  }
  const readHead = async (): Promise<string | null> => {
    await assertAcquisitionHead();
    const head = await readProposalHead();
    await assertAcquisitionHead();
    return head;
  };
  const pending = await receipts.begin(
    invocation.source.id,
    {
      pointerToken: await receipts.currentPointerToken(invocation.source.id),
      proposalHeadId: priorStored.observationId,
      admittedAcquisition: priorCapture,
    },
    readProposalHead,
  );
  let check: FieldworkCheckResult;
  try {
    // The owner result is data, not a live mutable capability. Freeze its
    // exact identity before Lookout's asynchronous admission starts.
    check = snapshotCheck(await invocation.check(invocation.source));
  } catch {
    return portableResult({
      classification: "source-unavailable",
      acquisition: { kind: "failed" },
      check: null,
      providerSkipped: true,
      priorObservation: evidence(priorStored),
    });
  }
  assertCheckIdentity(check, invocation.source);
  if (check.kind === "error") {
    return portableResult({
      classification: "source-unavailable",
      acquisition: { kind: "failed" },
      check,
      providerSkipped: true,
      priorObservation: evidence(priorStored),
    });
  }
  const checkAdmission = await admitSourceCheck({
    source: lookoutSource(invocation.source),
    check: asLookoutCheck(check),
    expectedPriorSnapshotRef: priorCapture.snapshotRef,
    snapshotStore,
  });
  if (!checkAdmission.ok) {
    // A legacy preparation-drift fixture has no new source capture. It is a
    // non-current diagnostic result, never a receipt-backed semantic success.
    if (check.kind === "changed" && check.currentSnapshotRef === priorCapture.snapshotRef) {
      const currentRun = await runFieldwork(runOptions(invocation, check.currentSnapshotRef));
      const current = await readRun(currentRun.runDirectory);
      if (preparationChangedWithoutTaskChange(prior, current)) {
        return portableResult({
          classification: "preparation-drift",
          acquisition: { kind: "completed" },
          check,
          providerSkipped: false,
          priorObservation: evidence(priorStored),
          currentObservation: evidence({ observationId: digestObservation(observationFor(invocation.source.id, current.envelope)), ...observationFor(invocation.source.id, current.envelope) }),
          items: current.run.review.snapshot.items as unknown as JsonObject[],
          run: currentRun,
        });
      }
    }
    throw withCode(
      checkAdmission.error.kind === "invalid-input"
        ? "RECHECK_OBSERVATION_FAILED"
        : "RECHECK_CONFLICT",
      checkAdmission.error.kind === "invalid-input"
        ? "Source check could not be admitted"
        : "Source check conflicts with the selected baseline",
      checkAdmission.error,
    );
  }
  const admittedCheck = checkAdmission.value;
  // The actual Forage acquisition head is independent of Lookout's proposal
  // head. A deferred older check must not relabel a newer capture as current.
  expectedAcquisitionRef = admittedCheck.current.snapshotRef;
  await assertAcquisitionHead();
  if (check.kind === "unchanged-304" || check.kind === "unchanged-hash") {
    await finalizeReceipt(receipts, pending,
      receiptCompletion(
        check.kind,
        priorStored.observationId,
        priorCapture,
        admittedCheck.current,
        check.checkedAt,
      ),
      readHead,
    );
    return portableResult({
      classification: "unchanged-source",
      acquisition: { kind: "completed" },
      check,
      providerSkipped: true,
      priorObservation: evidence(priorStored),
    });
  }

  let currentRun: FieldworkRunResult;
  try {
    currentRun = await runFieldwork(
      runOptions(invocation, admittedCheck.current.snapshotRef),
    );
  } catch (cause) {
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Source recheck requires recovery",
      cause,
    );
  }
  const current = await readRun(currentRun.runDirectory);
  const currentObservation = observationFor(
    invocation.source.id,
    current.envelope,
  );
  if (current.run.runResource === prior.run.runResource) {
    throw withCode(
      "RECHECK_CONFLICT",
      "Changed source resolved to the selected prior run",
    );
  }
  if (
    current.run.review.events.length !== 0 ||
    current.run.review.revision !== 0
  ) {
    throw withCode(
      "RECHECK_CONFLICT",
      "Existing current run already has review history",
    );
  }

  if (preparationChangedWithoutTaskChange(prior, current)) {
    return portableResult({
      classification: "preparation-drift",
      check,
      acquisition: { kind: "completed" },
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

  // Admission is deliberately before the Lookout mutation: a dependency bump
  // alone cannot protect a direct Fieldwork commit from unauthenticated refs.
  const admitted = await admitProposalObservation({
    source: lookoutSource(invocation.source),
    current: currentObservation,
    check: {
      checkedAt: check.checkedAt,
      resultKind: "changed",
      currentSnapshotRef: check.currentSnapshotRef,
    },
    prior: priorStored,
    snapshotStore,
  });
  if (!admitted.ok)
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Current source capture could not be admitted",
      admitted.error,
    );
  const committed = await store.commit(
    {
      observation: currentObservation,
      recordedAt: invocation.now?.() ?? new Date().toISOString(),
      check: {
        checkedAt: check.checkedAt,
        resultKind: "changed",
        currentSnapshotRef: check.currentSnapshotRef,
      },
    },
    priorStored.observationId,
  );
  if (!committed.ok) {
    const code =
      committed.error.kind === "continuity-conflict"
        ? "RECHECK_CONFLICT"
        : "RECHECK_OBSERVATION_FAILED";
    throw withCode(
      code,
      "Source observation could not be committed",
      committed.error,
    );
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
    throw withCode(
      "RECHECK_DIFF_FAILED",
      "Proposal observations could not be compared",
      semantic.error,
    );
  }

  // The round is completed here, not at export: the snapshot the reviewer
  // decides against is the projected authority, so anything the trust bundle
  // needs has to be part of the item they saw (fieldwork#59).
  const items = canonicalSemanticReviewItems(
    semantic.value.items as unknown as ReviewItem[],
    {
      sourceKind: FIELDWORK_SOURCE_KIND,
      transitionId: semantic.value.transitionId,
      prior: {
        observationId: priorStored.observationId,
        extractor: extractorFor(prior.envelope),
      },
      current: {
        observationId: committed.value.observationId,
        extractor: extractorFor(current.envelope),
      },
    },
  );
  try {
    await withRunReviewLock(current.directory, async (stored) => {
      // A recheck may only replace the untouched initial queue. A public
      // Survey append that wins the proposal-commit race is durable review
      // authority, not stale state to overwrite.
      if (
        stored.run.review.revision !== current.run.review.revision ||
        canonicalJson(stored.run.review.events) !==
          canonicalJson(current.run.review.events) ||
        stored.run.review.snapshotHash !== current.run.review.snapshotHash ||
        canonicalJson(stored.run.review.snapshot) !==
          canonicalJson(current.run.review.snapshot)
      ) {
        throw withCode(
          "RECHECK_CONFLICT",
          "Changed source run already has review history",
        );
      }
      await saveReview(stored.directory, stored.run, newReviewRound(items));
    });
  } catch (cause) {
    if ((cause as { code?: string } | undefined)?.code === "RECHECK_CONFLICT") {
      throw cause;
    }
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Source recheck requires recovery",
      cause,
    );
  }
  await finalizeReceipt(
    receipts,
    pending,
    receiptCompletion(
      "changed",
      committed.value.observationId,
      priorCapture,
      admittedCheck.current,
      check.checkedAt,
      priorStored.observationId,
    ),
    readHead,
  );
  const result = portableResult({
    classification: items.length === 0 ? "stable-proposals" : "semantic-drift",
    acquisition: { kind: "completed" },
    check,
    providerSkipped: false,
    priorObservation: evidence(priorStored),
    currentObservation: evidence(committed.value),
    transitionId: semantic.value.transitionId,
    items: items as unknown as JsonObject[],
    run: currentRun,
  });
  return result;
}

type ObservationStore = ReturnType<typeof createObservationStore>;
type StoredObservation = StoredProposalObservationV1;

function receiptCompletion(
  outcome:
    | "unchanged-304"
    | "unchanged-hash"
    | "changed"
    | "error"
    | "extraction-failure",
  resultProposalHeadId: string,
  priorCapture: Capture,
  currentCapture: Capture,
  checkedAt: string,
  priorProposalHeadId = resultProposalHeadId,
) {
  return {
    checkedAt,
    outcome,
    priorProposalHeadId,
    resultProposalHeadId,
    priorCapture,
    currentCapture,
  } as const;
}

async function establishPrior(
  store: ObservationStore,
  snapshotStore: ReturnType<typeof createFilesystemSnapshotStore>,
  source: FieldworkLookoutSource,
  observation: ProposalSetObservation,
  recordedAt: string,
): Promise<StoredObservation> {
  const loaded = await store.loadLatest(observation.sourceId);
  if (!loaded.ok)
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Prior observation could not be loaded",
      loaded.error,
    );
  if (loaded.value) {
    if (sameObservation(loaded.value, observation)) {
      const admitted = await admitProposalObservation({
        source: lookoutSource(source),
        current: observation,
        check: loaded.value.check,
        prior: null,
        snapshotStore,
      });
      if (!admitted.ok && !await historicalPriorUrlMove(
        admitted.error,
        source,
        observation.snapshotRef,
        snapshotStore,
      ))
        throw withCode(
          "RECHECK_OBSERVATION_FAILED",
          "Prior source capture could not be admitted",
          admitted.error,
        );
      return loaded.value;
    }
    throw withCode(
      "RECHECK_CONFLICT",
      "Stored source continuity does not match the selected prior run",
    );
  }
  const anchor = {
    checkedAt: observation.observedAt,
    resultKind: "changed" as const,
    currentSnapshotRef: observation.snapshotRef,
  };
  const admitted = await admitProposalObservation({
    source: lookoutSource(source),
    current: observation,
    check: anchor,
    prior: null,
    snapshotStore,
  });
  if (!admitted.ok && !await historicalPriorUrlMove(
    admitted.error,
    source,
    observation.snapshotRef,
    snapshotStore,
  ))
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Prior source capture could not be admitted",
      admitted.error,
    );
  const committed = await store.commit(
    {
      observation,
      recordedAt,
      check: anchor,
    },
    null,
  );
  if (committed.ok) return committed.value;
  if (committed.error.kind === "continuity-conflict") {
    const raced = await store.loadLatest(observation.sourceId);
    if (raced.ok && raced.value && sameObservation(raced.value, observation))
      return raced.value;
  }
  throw withCode(
    committed.error.kind === "continuity-conflict"
      ? "RECHECK_CONFLICT"
      : "RECHECK_OBSERVATION_FAILED",
    "Prior observation could not be established",
    committed.error,
  );
}

/**
 * A selected reviewed run can predate a registry URL move. Its exact Forage
 * reference remains a real historical fact; the later shared Check admission
 * authenticates it as the check's prior side, never as today’s capture.
 */
async function historicalPriorUrlMove(
  error: { readonly classification: string },
  source: FieldworkLookoutSource,
  snapshotRef: string,
  snapshotStore: ReturnType<typeof createFilesystemSnapshotStore>,
): Promise<boolean> {
  if (error.classification !== "url-binding") return false;
  const resolved = await resolveSnapshotSourceRef(snapshotStore, snapshotRef);
  return resolved.ok && resolved.snapshot.sourceId === source.id;
}

function observationFor(
  sourceId: string,
  envelope: Awaited<ReturnType<typeof readRun>>["envelope"],
): ProposalSetObservation {
  if (!envelope.source.snapshotRef) {
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Stored extraction is missing snapshot identity",
    );
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

/**
 * Extractor identity for one observation, used for the side of a transition
 * that has no evidence: a removed proposal still needs to record which
 * extractor observed nothing at that target.
 */
function extractorFor(
  envelope: Awaited<ReturnType<typeof readRun>>["envelope"],
): string {
  const extractor = envelope.result.provider;
  if (typeof extractor !== "string" || extractor.length === 0) {
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Stored extraction is missing its extractor identity",
    );
  }
  return extractor;
}

function claimTarget(task: FieldworkTask, change: SemanticReviewChange) {
  const projection = task.spec.projections.find(
    (candidate) => candidate.fieldPath === change.fieldPath,
  );
  if (!projection) throw new Error(`No claim target for ${change.fieldPath}`);
  return { ...projection.claim, fieldOrBehavior: change.fieldPath };
}

function runOptions(
  options: Invocation,
  snapshotRef: string,
): RunOptions {
  return {
    taskPath: options.taskPath,
    snapshotRef,
    ...(options.snapshotRoot === undefined
      ? {}
      : { snapshotRoot: options.snapshotRoot }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.sourceAdapters === undefined
      ? {}
      : { sourceAdapters: options.sourceAdapters }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function preparationChangedWithoutTaskChange(
  prior: Awaited<ReturnType<typeof readRun>>,
  current: Awaited<ReturnType<typeof readRun>>,
): boolean {
  return (
    prior.envelope.source.snapshotRef === current.envelope.source.snapshotRef &&
    prior.run.preparedArtifact.digest !== current.run.preparedArtifact.digest
  );
}

function assertCheckIdentity(
  check: FieldworkCheckResult,
  source: FieldworkLookoutSource,
): void {
  if (check.sourceId !== source.id || check.sourceUrl !== source.url) {
    throw withCode(
      "RECHECK_SOURCE_MISMATCH",
      "Lookout check does not identify the requested source",
    );
  }
}

function asLookoutCheck(check: FieldworkCheckResult): CheckResult {
  return check as CheckResult;
}

function assertCheckContinuity(
  check: FieldworkCheckResult,
  priorSnapshotRef: string,
): void {
  const referencedPrior =
    check.kind === "unchanged-304"
      ? check.snapshotRef
      : check.kind === "unchanged-hash" || check.kind === "changed"
        ? check.priorSnapshotRef
        : null;
  if (check.kind !== "error" && referencedPrior !== priorSnapshotRef) {
    throw withCode(
      "RECHECK_CONFLICT",
      "Lookout check does not continue from the selected prior run",
    );
  }
}

function sameObservation(
  stored: {
    sourceId: string;
    snapshotRef: string;
    observedAt: string;
    proposals: readonly ExtractionProposal[];
  },
  observation: ProposalSetObservation,
): boolean {
  return (
    stored.sourceId === observation.sourceId &&
    stored.snapshotRef === observation.snapshotRef &&
    stored.observedAt === observation.observedAt &&
    canonicalJson(stored.proposals) === canonicalJson(observation.proposals)
  );
}

// Fieldwork's public DTO is readonly; Lookout's registered-source DTO predates
// that readonly contract. Clone at the cross-owner seam instead of exposing a
// private Lookout type through Fieldwork.
function lookoutSource(source: FieldworkLookoutSource): LookoutSource {
  return "targetSchema" in source
    ? ({
        ...source,
        targetSchema: source.targetSchema.map((field) => ({
          ...field,
          ...(field.enumValues ? { enumValues: [...field.enumValues] } : {}),
        })),
      } as LookoutSource)
    : ({ ...source } as LookoutSource);
}

function portableResult(input: {
  classification: FieldworkRecheckClassification;
  acquisition: FieldworkRecheckResult["acquisition"];
  check: FieldworkCheckResult | null;
  providerSkipped: boolean;
  priorObservation: FieldworkEvidenceObservation | null;
  currentObservation?: FieldworkEvidenceObservation;
  transitionId?: string;
  items?: readonly JsonObject[];
  run?: FieldworkRunResult;
}): FieldworkRecheckResult {
  const result: FieldworkRecheckResult = {
    apiVersion: "fieldwork.kontourai.io/v2",
    kind: "FieldworkRecheckResult",
    classification: input.classification,
    acquisition: input.acquisition,
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

interface Invocation {
  readonly source: FieldworkLookoutSource;
  readonly priorRunDirectory: string;
  readonly taskPath: string;
  readonly check: (source: FieldworkLookoutSource) => Promise<FieldworkCheckResult>;
  readonly root?: string;
  readonly observationRoot?: string;
  readonly receiptRoot?: string;
  readonly snapshotRoot?: string;
  readonly runtime?: FieldworkRuntimeBinding;
  readonly sourceAdapters?: FieldworkSourceAdapters;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}

function captureInvocation(options: FieldworkRecheckOptions): Invocation {
  const acquisition = options.acquisition;
  return {
    source: structuredClone(options.source),
    priorRunDirectory: options.priorRunDirectory,
    taskPath: options.taskPath,
    check: acquisition.check.bind(acquisition),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.observationRoot === undefined ? {} : { observationRoot: options.observationRoot }),
    ...(options.receiptRoot === undefined ? {} : { receiptRoot: options.receiptRoot }),
    ...(options.snapshotRoot === undefined ? {} : { snapshotRoot: options.snapshotRoot }),
    ...(options.runtime === undefined
      ? {}
      : { runtime: snapshotRuntimeBinding(options.runtime) }),
    ...(options.sourceAdapters === undefined ? {} : { sourceAdapters: options.sourceAdapters }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

function snapshotRuntimeBinding(
  binding: FieldworkRuntimeBinding,
): FieldworkRuntimeBinding {
  // Keep ModelRuntime instances opaque and live: they are capabilities, not
  // serializable configuration. Clone every plain routing/budget field that
  // becomes durable run identity before any asynchronous work begins.
  return {
    role: binding.role,
    candidates: binding.candidates.map((candidate) => ({
      id: candidate.id,
      runtime: candidate.runtime,
      ...(candidate.estimatedUsdPer1kTokens === undefined
        ? {}
        : { estimatedUsdPer1kTokens: candidate.estimatedUsdPer1kTokens }),
    })),
    budget: {
      maxAttempts: binding.budget.maxAttempts,
      ...(binding.budget.maxElapsedMs === undefined
        ? {}
        : { maxElapsedMs: binding.budget.maxElapsedMs }),
      ...(binding.budget.maxTotalTokens === undefined
        ? {}
        : { maxTotalTokens: binding.budget.maxTotalTokens }),
      ...(binding.budget.maxCostUsd === undefined
        ? {}
        : { maxCostUsd: binding.budget.maxCostUsd }),
    },
    ...(binding.maxTokensPerAttempt === undefined
      ? {}
      : { maxTokensPerAttempt: binding.maxTokensPerAttempt }),
    ...(binding.concurrency === undefined ? {} : { concurrency: binding.concurrency }),
    ...(binding.batchSize === undefined ? {} : { batchSize: binding.batchSize }),
    ...(binding.maxProviderCalls === undefined
      ? {}
      : { maxProviderCalls: binding.maxProviderCalls }),
    ...(binding.maxChunks === undefined ? {} : { maxChunks: binding.maxChunks }),
    ...(binding.minimumStructuredToolsFidelity === undefined
      ? {}
      : { minimumStructuredToolsFidelity: binding.minimumStructuredToolsFidelity }),
    ...(binding.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: binding.maxOutputTokens }),
  };
}

function snapshotCheck(value: FieldworkCheckResult): FieldworkCheckResult {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Source check could not be captured",
      cause,
    );
  }
}

async function exactReceiptCapture(
  snapshotStore: ReturnType<typeof createFilesystemSnapshotStore>,
  snapshotRef: string,
): Promise<Capture> {
  const resolved = await resolveSnapshotSourceRef(snapshotStore, snapshotRef);
  if (!resolved.ok) {
    throw withCode(
      "RECHECK_OBSERVATION_FAILED",
      "Prior source capture could not be resolved",
      resolved.error,
    );
  }
  return {
    sourceId: resolved.snapshot.sourceId,
    snapshotRef,
    url: resolved.snapshot.url,
    bodyHash: resolved.snapshot.bodyHash,
    fetchedAt: resolved.snapshot.fetchedAt,
    ...(resolved.reference.snapshotDigest
      ? { snapshotDigest: resolved.reference.snapshotDigest }
      : {}),
    integrity: resolved.integrity,
  };
}

async function finalizeReceipt(
  receipts: FieldworkSourceCheckReceiptStore,
  pending: Awaited<ReturnType<FieldworkSourceCheckReceiptStore["begin"]>>,
  completion: Parameters<FieldworkSourceCheckReceiptStore["finalize"]>[1],
  readHead: () => Promise<string | null>,
): Promise<void> {
  const result = await receipts.finalize(pending, completion, readHead);
  if (result.kind !== "available") {
    throw withCode(
      result.kind === "corrupt" || result.kind === "busy"
        ? "RECHECK_OBSERVATION_FAILED"
        : "RECHECK_CONFLICT",
      result.kind === "corrupt" || result.kind === "busy"
        ? "Source recheck requires recovery"
        : "Source recheck was superseded",
    );
  }
}

function digestObservation(observation: ProposalSetObservation): string {
  return createHash("sha256").update(canonicalJson(observation)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withCode(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}
