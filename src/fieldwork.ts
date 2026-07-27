import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createInMemoryPreparedArtifactStore, extract, resolvePreparedArtifact, serializePortableExtractionResult, type PortableExtractionResultEnvelope
} from "@kontourai/traverse";
import { importExtractionEnvelope, buildCanonicalReviewedTrustInput, buildSurveyTrustBundle, type ReviewCandidate, type ReviewItem } from "@kontourai/survey";
import type { ReviewWorkbenchResult } from "@kontourai/survey/review-workbench";
import { initialReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { deriveServerReviewSessionApplyResult } from "@kontourai/survey/review-workbench/server-review-session";
import { validateTrustBundle } from "@kontourai/surface";
import { FIELDWORK_LIMITS, canonicalJson, parseFieldworkTask, traverseTask, type FieldworkTask } from "./contracts.js";
import {
  parseReviewedExport,
  type FieldworkBatchOptions,
  type FieldworkBatchRunResult,
  type FieldworkRunResult,
  type ReviewedExportV1,
  type RunOptions,
} from "./api-contracts.js";
import { createDeterministicProvider } from "./deterministic-provider.js";
import { assertPortableOutput, defaultRunRoot, readRun, writeRun, type StoredRun } from "./run-store.js";
import { reviewSnapshotHash } from "./survey-persistence.js";
import type { FieldworkStoredExecution } from "./runtime-contracts.js";
import { createFieldworkExecutionIdentity, createFieldworkRuntimeSession } from "./runtime-session.js";
import { resolveFieldworkSource } from "./source-input.js";

/**
 * Source kind Fieldwork reports to Survey for every raw source it records. Both
 * review rounds must agree on it: a recheck round's trust projection records one
 * RawSource per observation, and a kind that drifted between rounds would make
 * two receipts about one source disagree about what the source is.
 */
export const FIELDWORK_SOURCE_KIND: FieldworkSourceKind = "uploaded-document";

export type FieldworkSourceKind = NonNullable<ReviewCandidate["source"]["kind"]>;

export async function runFieldwork(options: RunOptions): Promise<FieldworkRunResult> {
  const taskText = await boundedInput(options.taskPath, FIELDWORK_LIMITS.taskBytes, "task");
  const task = parseFieldworkTask(JSON.parse(taskText));
  const source = await resolveFieldworkSource({
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    ...(options.snapshotRef === undefined ? {} : { snapshotRef: options.snapshotRef }),
    ...(options.snapshotRoot === undefined ? {} : { snapshotRoot: options.snapshotRoot }),
    ...(options.sourceAdapters === undefined ? {} : { adapters: options.sourceAdapters }),
  }, task.metadata.name);
  const executionIdentity = options.runtime ? createFieldworkExecutionIdentity(options.runtime) : undefined;
  const identityInput = `${canonicalJson(source.identity)}:${canonicalJson(task)}${executionIdentity ? `:${canonicalJson(executionIdentity)}` : ""}`;
  const runIdentity = createHash("sha256").update(identityInput).digest("hex").slice(0, 16);
  const runResource = `fieldwork-run:v1:${task.metadata.name}:${runIdentity}`;
  const root = resolve(options.root ?? defaultRunRoot);
  const runDirectory = join(root, `run-${runIdentity}`);
  if (await exists(runDirectory)) {
    const existing = await readRun(runDirectory);
    if (existing.run.runResource !== runResource || canonicalJson(existing.run.task) !== canonicalJson(task)) {
      throw new Error("Existing run identity does not match the requested task");
    }
    return {
      apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkRunResult",
      runDirectory: existing.directory, runResource, proposalCount: existing.envelope.result.proposals.length
    };
  }
  const runtimeSession = options.runtime ? createFieldworkRuntimeSession(options.runtime, {
    authorizationId: `fieldwork:${runIdentity}`,
    authorizationRoot: join(root, ".dispatch-authorizations"),
  }) : undefined;
  if (runtimeSession) assertPortableOutput(runtimeSession.execution);
  const taskSpec = traverseTask(task);
  const store = createInMemoryPreparedArtifactStore();
  const result = await extract({
    content: source.content, contentType: source.contentType, sourceRef: source.sourceRef,
    targetSchema: taskSpec.targetSchema, taskSpec, provider: runtimeSession?.provider ?? createDeterministicProvider(task),
    preparedArtifact: { store, sourceSnapshotRef: source.sourceSnapshotRef },
    ...(source.pdfTextExtractor === undefined ? {} : { pdfTextExtractor: source.pdfTextExtractor }),
    ...(source.imageTextExtractor === undefined ? {} : { imageTextExtractor: source.imageTextExtractor }),
    ...(options.runtime?.concurrency === undefined ? {} : { concurrency: options.runtime.concurrency }),
    ...(options.runtime?.batchSize === undefined ? {} : { batchSize: options.runtime.batchSize }),
    ...(options.runtime?.maxProviderCalls === undefined ? {} : { maxProviderCalls: options.runtime.maxProviderCalls }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.error || !result.preparedArtifact) throw new Error(result.error ?? "Traverse did not produce a prepared artifact");
  const resolution = await resolvePreparedArtifact(result.preparedArtifact, store);
  if (resolution.status !== "available") throw new Error(`Prepared artifact is ${resolution.status}`);
  const envelope = JSON.parse(serializePortableExtractionResult(result, { preparedArtifactResolution: resolution })) as PortableExtractionResultEnvelope;
  assertPortableOutput(envelope);
  const imported = importExtractionEnvelope(envelope, {
    importName: `fieldwork-import:${task.metadata.name}:${runIdentity}`,
    producerNamespace: "fieldwork", sourceKind: FIELDWORK_SOURCE_KIND,
    claimTarget: (proposal) => {
      const projection = task.spec.projections.find((candidate) => candidate.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error(`No claim target for ${proposal.fieldPath}`);
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }
  });
  if (imported.record.status.state !== "grounded") throw new Error("Survey refused ungrounded extraction envelope");
  const run: StoredRun = {
    schemaVersion: 1, runResource, createdAt: new Date().toISOString(), taskName: task.metadata.name, task,
    execution: runtimeSession?.execution ?? fixtureExecution(),
    preparedArtifact: { ref: result.preparedArtifact.ref, digest: result.preparedArtifact.digest, contentLength: result.preparedArtifact.contentLength, file: "prepared.txt" },
    envelopeFile: "extraction-envelope.json", review: newReviewRound(canonicalReviewItems(imported.reviewItems, envelope))
  };
  const persistedDirectory = await writeRun(root, run, envelope, resolution.text);
  return {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkRunResult",
    runDirectory: persistedDirectory, runResource, proposalCount: result.proposals.length
  };
}

export async function runFieldworkBatch(options: FieldworkBatchOptions): Promise<FieldworkBatchRunResult> {
  if (options.sources.length === 0 || options.sources.length > 128) {
    throw Object.assign(
      new Error("Fieldwork batch requires between 1 and 128 sources"),
      { code: "INVALID_ARGUMENT" },
    );
  }
  const ids = new Set<string>();
  const items: FieldworkBatchRunResult["items"][number][] = [];
  for (const source of options.sources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(source.id) || ids.has(source.id)) {
      throw Object.assign(
        new Error("Fieldwork batch source ids must be unique bounded identifiers"),
        { code: "INVALID_ARGUMENT" },
      );
    }
    ids.add(source.id);
    try {
      const run = await runFieldwork({
        taskPath: options.taskPath,
        root: options.root,
        ...(source.sourcePath === undefined ? {} : { sourcePath: source.sourcePath }),
        ...(source.snapshotRef === undefined ? {} : { snapshotRef: source.snapshotRef }),
        ...(source.snapshotRoot === undefined ? {} : { snapshotRoot: source.snapshotRoot }),
        ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
        ...(options.sourceAdapters === undefined ? {} : { sourceAdapters: options.sourceAdapters }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      items.push({ id: source.id, ok: true, run });
    } catch (error) {
      items.push({
        id: source.id,
        ok: false,
        error: batchError(error),
      });
    }
  }
  const succeeded = items.filter((item) => item.ok).length;
  return {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkBatchRunResult",
    items,
    succeeded,
    failed: items.length - succeeded,
  };
}

function batchError(error: unknown): { code: string; message: string } {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "SOURCE_FAILED";
  const safeMessages: Record<string, string> = {
    INVALID_ARGUMENT: "Source input is invalid",
    SNAPSHOT_REPLAY_FAILED: "Exact snapshot replay failed",
    PDF_ADAPTER_REQUIRED: "PDF source requires a configured adapter",
    IMAGE_ADAPTER_REQUIRED: "Image source requires a configured adapter",
  };
  return { code, message: safeMessages[code] ?? "Source processing failed" };
}

function fixtureExecution(): FieldworkStoredExecution {
  return { identity: { mode: "fixture-v1" }, receipts: [] };
}

/**
 * Export the reviewed authority of exactly one run: the decisions recorded
 * against that run's persisted review queue, and nothing else.
 *
 * A first round's queue is the whole extraction, so its receipt is
 * document-shaped. A `fieldwork recheck` round's queue is Lookout's semantic
 * transition, so its receipt is round-shaped — the fields that actually moved.
 * The rule is the same; only the queue differs. Earlier decisions are not
 * folded in: they belong to the run whose snapshot they were made against, and
 * copying them here would produce a second authoritative record of one
 * decision under a different source identity.
 *
 * The persisted snapshot is the projected authority. Rebuilding items from the
 * envelope instead (fieldwork#59) silently agreed on first rounds and refused
 * on recheck rounds, because it projected items the reviewer never saw.
 *
 * Projecting the decided queue makes `assertCanonicalResult` agree with itself,
 * so the independence it used to supply has to be supplied deliberately, twice
 * over: `readRun` checks the queue against the digest bound to its decisions
 * when the round opened, and `assertReviewedQueueIsAttested` checks it against
 * the extraction envelope — an artifact produced by a different step and bound
 * to the prepared bytes by digest. A one-sided edit fails the first; an edit
 * that also refreshes the digest fails the second.
 */
export async function reviewedExport(runDirectory: string): Promise<ReviewedExportV1> {
  const stored = await readRun(runDirectory);
  assertPortableOutput(stored.envelope);
  const imported = importExtractionEnvelope(stored.envelope, {
    importName: importNameFor(stored.run), producerNamespace: "fieldwork", sourceKind: FIELDWORK_SOURCE_KIND,
    claimTarget: (proposal) => {
      const projection = stored.run.task.spec.projections.find((candidate) => candidate.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error(`No claim target for ${proposal.fieldPath}`);
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }
  });
  if (imported.record.status.state !== "grounded") throw new Error("Export refused: extraction is not grounded");
  const items = stored.run.review.snapshot.items as readonly ReviewItem[];
  assertReviewedQueueIsAttested(items, canonicalReviewItems(imported.reviewItems, stored.envelope), stored.envelope);
  const record = reviewSessionRecord(stored.run, stored.run.review.events.length);
  const applied = deriveServerReviewSessionApplyResult({ record, events: stored.run.review.events, requiredResolvedItems: "all" });
  if (!applied.ok) {
    throw new Error(`Export refused: ${applied.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" ")}`);
  }
  assertGroundedSelection(items, applied.results);
  assertOneDecisionPerClaimTarget(items, applied.results);
  const canonical = projectCanonicalReview(stored.run.runResource, items, applied.results);
  const bundle = validateTrustBundle(buildSurveyTrustBundle(canonical.surveyInput, { projectionContextId: canonical.projectionContextId }));
  assertPortableOutput(bundle);
  return parseReviewedExport(bundle);
}

/**
 * Check the decided queue against an artifact it was not derived from.
 *
 * Before fieldwork#59, Survey received envelope-derived items while the results
 * came from the persisted queue, so `assertCanonicalResult` compared two
 * independent origins and a queue edited after the decision disagreed with the
 * envelope. Projecting the decided queue is the right authority but removes
 * that second origin, so it is restored here explicitly — and widened from the
 * selected candidate to the whole item.
 *
 * The extraction envelope is the independent side: a separate file, bound to
 * the prepared bytes by digest and re-validated on every read
 * (`assertPreparedIdentity`).
 *
 * - An envelope-derived item must be exactly what importing that envelope
 *   produces.
 * - A recheck item's current-observation candidates are this run's own
 *   extraction, so each must match a stored proposal — or, when it records an
 *   absence, match no proposal at all.
 * - Anything else has no attesting artifact and is refused rather than trusted.
 *
 * A recheck item's *prior*-observation candidates are the one part no artifact
 * in this run can attest: they came from a snapshot this run never extracted.
 * They are covered only by the persisted queue binding, which a rewrite of
 * `run.json` could keep consistent. That gap is accepted and disclosed
 * (docs/decisions/local-run-artifacts.md, fieldwork#65); closing it needs the
 * prior observation to carry an attestation this run can check on its own.
 */
function assertReviewedQueueIsAttested(
  items: readonly ReviewItem[],
  envelopeItems: readonly ReviewItem[],
  envelope: PortableExtractionResultEnvelope
): void {
  const envelopeByName = new Map(envelopeItems.map((item) => [item.metadata.name, item]));
  const proposals = envelope.result.proposals;
  for (const item of items) {
    const attested = envelopeByName.get(item.metadata.name);
    if (attested) {
      if (canonicalJson(item) !== canonicalJson(attested)) {
        throw unattested(`review item ${item.metadata.name} does not match the extraction it was imported from`);
      }
      continue;
    }
    if (!item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER]) {
      throw unattested(`review item ${item.metadata.name} has no extraction or recheck provenance to check it against`);
    }
    for (const candidate of item.spec.candidates) {
      const round = candidate.producer?.[RECHECK_ROUND_PRODUCER] as { evidenceObservation?: unknown } | undefined;
      if (round?.evidenceObservation !== "current") continue;
      const observed = candidate.producer?.[SEMANTIC_TRANSITION_PRODUCER] as { evidenceState?: unknown } | undefined;
      const matches = proposals.filter((proposal) => proposal.fieldPath === candidate.extraction.target);
      if (observed?.evidenceState !== "present") {
        if (matches.length > 0) {
          throw unattested(`review item ${item.metadata.name} records ${candidate.extraction.target} as absent, but this run extracted it`);
        }
        continue;
      }
      const grounded = matches.some((proposal) => canonicalJson(proposal.candidateValue) === canonicalJson(candidate.value)
        && proposal.provenance.locator === candidate.locator?.locator
        && proposal.provenance.excerpt === candidate.locator?.excerpt
        && proposal.extractor === candidate.extraction.extractor);
      if (!grounded) {
        throw unattested(`review item ${item.metadata.name} states a ${candidate.extraction.target} this run's extraction does not`);
      }
    }
  }
}

function unattested(detail: string): Error {
  return Object.assign(
    new Error(
      `Export refused: this run's reviewed queue is not attested by its own extraction — ${detail}. `
      + "The reviewed queue is the authority for what was decided, so it has to agree with the artifact it was built from; "
      + "re-run the source rather than editing stored review state."
    ),
    { code: "EXPORT_UNATTESTED_QUEUE" }
  );
}

function projectCanonicalReview(
  runResource: string,
  items: readonly ReviewItem[],
  results: readonly ReviewWorkbenchResult[]
): ReturnType<typeof buildCanonicalReviewedTrustInput> {
  try {
    return buildCanonicalReviewedTrustInput({
      source: runResource, generatedAt: new Date().toISOString(), projectionContextId: runResource,
      items, results
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "the review round could not be projected";
    throw Object.assign(
      new Error(`Export refused: this run's reviewed round cannot be projected into a trust bundle. ${detail}`, { cause }),
      { code: "EXPORT_NOT_PROJECTABLE" }
    );
  }
}

/**
 * Survey requires every claim projected from a document to cite the span it
 * came from (`assertProducerDiscipline`, to-surface.ts). A recheck round can
 * resolve onto a candidate that records an *absence* — a removed proposal, an
 * added one seen from the side that did not have it, a coverage or provenance
 * gap — and an absence has no span. Say that plainly here instead of letting
 * Survey's terse locator error be the whole story.
 *
 * Which decision is exportable depends on which side is grounded, so name that
 * side rather than assume it: on a removal the prior value is the grounded one
 * (`keep current`), on an addition the proposed value is (`accept proposed`).
 * Advising `keep current` unconditionally would prescribe the decision that is
 * already failing whenever the absent side is the prior one. When neither side
 * cites a span there is nothing to advise: recording the transition itself
 * would need a reviewed-retraction record the trust bundle has no shape for,
 * which is an upstream question, not something to fake with an uncited claim.
 */
function assertGroundedSelection(items: readonly ReviewItem[], results: readonly ReviewWorkbenchResult[]): void {
  const itemsByName = new Map(items.map((item) => [item.metadata.name, item]));
  for (const result of results) {
    const item = itemsByName.get(result.reviewItemName);
    const selected = item?.spec.candidates.find((candidate) => candidate.id === result.selectedCandidateId);
    if (!item || !selected || selected.locator?.locator) continue;
    throw Object.assign(
      new Error(
        `Export refused: ${selected.claimTarget.fieldOrBehavior} is resolved onto a candidate that records no source span `
        + `(review item ${item.metadata.name}, decision ${result.decision}). A reviewed claim about a document has to cite `
        + `where in the document it came from, and this candidate is an absence. ${groundedAdvice(item)}`
      ),
      { code: "EXPORT_UNGROUNDED_SELECTION" }
    );
  }
}

/** The decision on this item that selects a candidate which does cite a span. */
function groundedAdvice(item: ReviewItem): string {
  const grounded = item.spec.candidates.filter((candidate) => candidate.locator?.locator);
  if (grounded.some((candidate) => candidate.role === "proposed")) {
    return "Decide the item \"accept proposed\" to resolve onto the value this source states; "
      + "an absence itself is not representable as a cited claim.";
  }
  if (grounded.some((candidate) => candidate.role === "current")) {
    return "Decide the item \"keep current\" to carry the previously grounded value forward; "
      + "an absence itself is not representable as a cited claim.";
  }
  return "Neither side of this item cites a span, so no decision on it can be exported: "
    + "a transition between two absences is not representable as a cited claim.";
}

/**
 * A trust bundle states one reviewed value per claim target. A recheck round can
 * raise two items for one drifted field — a value change and a provenance
 * change (kontourai/lookout#34) — and deciding those two differently would
 * otherwise export a receipt that asserts two values for one field. Refuse,
 * naming the field, rather than emit the contradiction.
 */
function assertOneDecisionPerClaimTarget(items: readonly ReviewItem[], results: readonly ReviewWorkbenchResult[]): void {
  const itemsByName = new Map(items.map((item) => [item.metadata.name, item]));
  const decided = new Map<string, { itemName: string; outcome: string }>();
  for (const result of results) {
    const item = itemsByName.get(result.reviewItemName);
    const selected = item?.spec.candidates.find((candidate) => candidate.id === result.selectedCandidateId);
    if (!selected) continue;
    const { claimId: _claimId, ...target } = selected.claimTarget;
    const key = canonicalJson(target);
    const outcome = canonicalJson({ status: result.status, value: result.effectiveValue });
    const existing = decided.get(key);
    if (existing && existing.outcome !== outcome) {
      throw Object.assign(
        new Error(
          `Export refused: this review round records conflicting decisions for ${target.fieldOrBehavior}. `
          + `Items ${existing.itemName} and ${result.reviewItemName} resolve the same field to different reviewed values; `
          + "decide them the same way and export again."
        ),
        { code: "EXPORT_CONFLICTING_DECISIONS" }
      );
    }
    if (!existing) decided.set(key, { itemName: result.reviewItemName, outcome });
  }
}

/**
 * Open a review round over `items` and bind it: the digest is taken once, here,
 * from the queue the reviewer is about to be shown, and every later write of
 * this run carries it forward rather than recomputing it.
 */
export function newReviewRound(items: readonly ReviewItem[]): StoredRun["review"] {
  const snapshot = initialReviewQueueSessionState(items as ReviewItem[]);
  return { snapshot, events: [], revision: 0, snapshotHash: reviewSnapshotHash(snapshot) };
}

export function reviewSessionName(_run: StoredRun): string { return "review-workbench-session"; }

/**
 * Server review-session record for a stored run, carrying the queue digest
 * persisted with the decisions rather than one recomputed from the queue being
 * checked. `createServerReviewSessionRecord` derives the hash from the snapshot
 * handed to it, so a record built that way can only ever agree with itself.
 *
 * `readRun` is the gate that actually stops a rewritten queue, and it runs
 * before any caller reaches here — this keeps the same discipline at the
 * projection boundary so the self-agreeing shape is not reintroduced, and
 * fault injection on it is correctly caught by nothing.
 */
export function reviewSessionRecord(run: StoredRun, eventCount: number): {
  sessionName: string; snapshot: StoredRun["review"]["snapshot"]; snapshotHash: string;
  eventCount: number; updatedAt: string;
} {
  return {
    sessionName: reviewSessionName(run), snapshot: run.review.snapshot,
    snapshotHash: run.review.snapshotHash, eventCount, updatedAt: run.createdAt,
  };
}
export function importNameFor(run: StoredRun): string { return `fieldwork-import:${run.taskName}:${run.runResource.split(":").at(-1)}`; }

export const SEMANTIC_TRANSITION_PRODUCER = "lookout.kontourai.io/semantic-transition";
export const RECHECK_ROUND_PRODUCER = "fieldwork.kontourai.io/recheck-round";

export interface RecheckRoundObservation {
  /** Lookout's committed proposal-observation identity. */
  readonly observationId: string;
  /** Extractor that produced that observation, for candidates whose evidence is absent. */
  readonly extractor: string;
}

export interface RecheckRoundBinding {
  readonly sourceKind: FieldworkSourceKind;
  readonly transitionId: string;
  readonly prior: RecheckRoundObservation;
  readonly current: RecheckRoundObservation;
}

/**
 * Complete a Lookout semantic review round so the items the reviewer decides
 * are already projectable into a Survey trust bundle, and stamp the round
 * identity a receipt needs.
 *
 * Three application-owned facts are missing from `buildSemanticReviewWork`
 * output and cannot be invented at export time without contradicting the
 * decided snapshot (fieldwork#59):
 *
 * - `source.kind` — Survey takes the source kind as a caller option
 *   (`importExtractionEnvelope`); Lookout has no equivalent, so every semantic
 *   candidate lacks it and `buildCanonicalReviewedTrustInput` refuses.
 * - `source.sourceId` — Lookout reuses the *registry* source id for both sides
 *   of a transition, so two snapshots of one source collide on one RawSource
 *   record. Survey's own importer identifies a raw source by its snapshot ref;
 *   this matches that convention, and the registry id remains inside the ref.
 * - `extraction.extractor` — omitted when a side has no evidence (an added or
 *   removed proposal), which is exactly when the projection still needs to say
 *   which extractor observed nothing there.
 *
 * The durable home for all three is Lookout (kontourai/lookout#35): this is a
 * narrow composition adapter, in the same spirit as `canonicalReviewItems`.
 *
 * `RECHECK_ROUND_PRODUCER` rides the candidate producer channel because that is
 * the only path from a ReviewItem into exported Evidence metadata, so a receipt
 * can say which transition a claim belongs to and — via `evidenceObservation` —
 * whether its value was carried forward from the prior observation or affirmed
 * against the new one.
 */
export function canonicalSemanticReviewItems(items: readonly ReviewItem[], round: RecheckRoundBinding): ReviewItem[] {
  return items.map((item) => {
    const transition = item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER] as { semanticKind?: unknown } | undefined;
    const semanticKind = transition?.semanticKind;
    if (typeof semanticKind !== "string" || semanticKind.length === 0) {
      throw new Error("Semantic review item does not carry its Lookout transition kind");
    }
    return {
      ...item,
      spec: {
        ...item.spec,
        candidates: item.spec.candidates.map((candidate) => {
          const producer = candidate.producer?.[SEMANTIC_TRANSITION_PRODUCER] as { observationId?: unknown } | undefined;
          const observationId = producer?.observationId;
          const observedPrior = observationId === round.prior.observationId;
          if (!observedPrior && observationId !== round.current.observationId) {
            throw new Error("Semantic review candidate does not belong to the observations under review");
          }
          return {
            ...candidate,
            source: { ...candidate.source, kind: round.sourceKind, sourceId: candidate.source.sourceRef },
            extraction: {
              ...candidate.extraction,
              extractor: candidate.extraction.extractor
                ?? (observedPrior ? round.prior.extractor : round.current.extractor),
            },
            producer: {
              ...candidate.producer,
              [RECHECK_ROUND_PRODUCER]: {
                transitionId: round.transitionId,
                semanticKind,
                priorObservationId: round.prior.observationId,
                currentObservationId: round.current.observationId,
                evidenceObservation: observedPrior ? "prior" : "current",
              },
            },
          };
        }),
      },
    };
  });
}

/**
 * Temporary Survey #187 compatibility adapter; remove once the envelope importer
 * supplies `extraction.extractedAt`.
 */
export function canonicalReviewItems(items: readonly ReviewItem[], envelope: PortableExtractionResultEnvelope): ReviewItem[] {
  return items.map((item) => ({
    ...item,
    spec: {
      ...item.spec,
      candidates: item.spec.candidates.map((candidate) => ({
        ...candidate,
        extraction: { ...candidate.extraction, extractedAt: envelope.result.extractedAt },
      })),
    },
  }));
}

async function boundedInput(path: string, maxBytes: number, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Fieldwork ${label} must be a regular file`);
  if (metadata.size > maxBytes) throw new Error(`Fieldwork ${label} exceeds the configured size limit`);
  return readFile(path, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
