import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createInMemoryPreparedArtifactStore, extract, resolvePreparedArtifact, serializePortableExtractionResult,
  type ExtractionProposal, type PortableExtractionOutcome, type PortableExtractionResultEnvelope
} from "@kontourai/traverse";
import {
  importExtractionEnvelope, buildCanonicalReviewedTrustInput, buildReviewItemsFromExtractionEnvelopeImport, buildSurveyTrustBundle,
  type ExtractionEnvelopeImportOptions, type ExtractionEnvelopeImportResult, type ReviewCandidate, type ReviewItem
} from "@kontourai/survey";
import type { ReviewWorkbenchResult } from "@kontourai/survey/review-workbench";
import {
  assertReviewQueueAgainstExtractionImport,
  bindReviewQueue,
  decisionSelectsNoCandidate,
  hashReviewQueueSnapshot,
  initialReviewQueueSessionState,
  UnattestedExtractionQueueError,
} from "@kontourai/survey/review-workbench";
import { deriveServerReviewSessionApplyResult } from "@kontourai/survey/review-workbench/server-review-session";
import { validateTrustBundle } from "@kontourai/surface";
import { FIELDWORK_LIMITS, canonicalJson, parseFieldworkTask, traverseTask, type FieldworkTask } from "./contracts.js";
import {
  parseReviewedExport,
  type FieldworkBatchOptions,
  type FieldworkBatchRunResult,
  type FieldworkRunViewV1,
  type FieldworkRunOutcome,
  type FieldworkRunResult,
  type ReviewedExportV1,
  type RunOptions,
} from "./api-contracts.js";
import { createDeterministicProvider } from "./deterministic-provider.js";
import {
  assertPortableOutput, defaultRunRoot, extractionEnvelopeDigest, readRun, writeRun,
  type StoredRun, type StoredRunMetadataRead
} from "./run-store.js";
import { REVIEW_SESSION_NAME } from "./survey-persistence.js";
import type { FieldworkStoredExecution } from "./runtime-contracts.js";
import {
  createFieldworkExecutionIdentity, createFieldworkRuntimeSession, runtimeMessageIsPlain, type FieldworkRuntimeSession,
} from "./runtime-session.js";
import { resolveFieldworkSource } from "./source-input.js";
import { buildReviewedEvidenceEnrichment, REVIEWED_EVIDENCE_COLLECTED_BY, REVIEWED_GROUNDING_POLICY_ID } from "./reviewed-evidence.js";
import { attributeReviewResults, UNATTRIBUTED_ACTOR_ID, type ReviewDecisionAttribution } from "./review-attribution.js";
import { candidateSchemaMismatch } from "./schema-match.js";

/**
 * Source kind Fieldwork reports to Survey for every raw source it records. Both
 * review rounds must agree on it: a recheck round's trust projection records one
 * RawSource per observation, and a kind that drifted between rounds would make
 * two receipts about one source disagree about what the source is.
 */
export const FIELDWORK_SOURCE_KIND: FieldworkSourceKind = "uploaded-document";

export type FieldworkSourceKind = NonNullable<ReviewCandidate["source"]["kind"]>;

/**
 * `FieldworkRunOutcome` mirrors Traverse's `PortableExtractionOutcome` rather
 * than importing it (see api-contracts.ts). Requiring assignability in both
 * directions here, where Traverse's types are already in scope, makes a
 * reason Traverse adds or removes a compile error instead of a run that
 * cannot report its own outcome.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const runOutcomeMirrorsTraverse: MutuallyAssignable<FieldworkRunOutcome, PortableExtractionOutcome> = true;
void runOutcomeMirrorsTraverse;

export async function runFieldwork(options: RunOptions): Promise<FieldworkRunResult> {
  const taskText = await boundedInput(options.taskPath, FIELDWORK_LIMITS.taskBytes, "task");
  const task = parseFieldworkTask(JSON.parse(taskText));
  if (options.runtime) assertRuntimeSupportsTask(task);
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
      runDirectory: existing.directory, runResource, proposalCount: existing.envelope.result.proposals.length,
      outcome: existing.envelope.result.outcome,
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
    ...(options.runtime?.maxChunks === undefined ? {} : { maxChunks: options.runtime.maxChunks }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.error || !result.preparedArtifact) {
    throw extractionFailure(result.error ?? "Traverse did not produce a prepared artifact", runtimeSession);
  }
  const resolution = await resolvePreparedArtifact(result.preparedArtifact, store);
  if (resolution.status !== "available") throw new Error(`Prepared artifact is ${resolution.status}`);
  const envelope = JSON.parse(serializePortableExtractionResult(result, { preparedArtifactResolution: resolution })) as PortableExtractionResultEnvelope;
  assertPortableOutput(envelope);
  const { imported, extraction } = bindExtraction(task, `fieldwork-import:${task.metadata.name}:${runIdentity}`, envelope, resolution.text);
  const createdAt = new Date().toISOString();
  const run: StoredRun = {
    schemaVersion: 1, runResource, createdAt, taskName: task.metadata.name, task,
    execution: runtimeSession?.execution ?? fixtureExecution(),
    preparedArtifact: { ref: result.preparedArtifact.ref, digest: result.preparedArtifact.digest, contentLength: result.preparedArtifact.contentLength, file: "prepared.txt" },
    envelopeFile: "extraction-envelope.json",
    extraction,
    review: newReviewRound(imported.reviewItems, createdAt)
  };
  const persistedDirectory = await writeRun(root, run, envelope, resolution.text);
  return {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkRunResult",
    runDirectory: persistedDirectory, runResource, proposalCount: result.proposals.length,
    outcome: envelope.result.outcome,
  };
}

/**
 * A failed extraction, with the cause when a model runtime was the reason.
 * Dispatch reports a spent runtime only as "ended with exhausted"; the last
 * failed attempt's code and the runtime's own message say why (quota,
 * sign-in, an unavailable CLI). The message is shown only when it reads as
 * plain prose (`runtimeMessageIsPlain`); otherwise only the code is reported.
 */
function extractionFailure(message: string, session: FieldworkRuntimeSession | undefined): Error {
  const failure = session?.lastFailure();
  if (!failure) return new Error(message);
  const failedAttempts = session!.execution.receipts
    .reduce((count, receipt) => count + receipt.attempts.filter((attempt) => attempt.outcome === "failed").length, 0);
  const cause = !failure.message ? ""
    : runtimeMessageIsPlain(failure.message) ? `: ${failure.message}`
    : " (details withheld)";
  return Object.assign(
    new Error(
      `${message}. The last attempt on runtime ${failure.runtimeId} failed with ${failure.code}${cause}`
      + `${failedAttempts > 0 ? ` (${failedAttempts} failed ${failedAttempts === 1 ? "attempt" : "attempts"} recorded).` : "."}`
    ),
    { code: "RUNTIME_INVOCATION_FAILED", runtimeFailure: { runtimeId: failure.runtimeId, code: failure.code } },
  );
}

/**
 * Import a new run's extraction and bind it to the run. Survey checks every
 * excerpt against the prepared text, leaves out a proposal whose span does not
 * match (recording it on its claim slot as an excluded rival), and records the
 * import as verified. The binding written into `run.json` is the envelope's
 * digest and that verified status, so a later read can refuse an envelope
 * edited after the run was created.
 */
export function bindExtraction(
  task: FieldworkTask,
  importName: string,
  envelope: PortableExtractionResultEnvelope,
  preparedText: string,
): { readonly imported: ExtractionEnvelopeImportResult; readonly extraction: NonNullable<StoredRun["extraction"]> } {
  const prepared = envelope.result.preparedArtifact;
  if (!prepared) throw new Error("Traverse did not record a prepared artifact");
  const imported = importExtractionEnvelope(envelope, {
    ...extractionImportOptions(task, importName),
    artifact: { status: "available", text: preparedText, actualDigest: prepared.digest },
  });
  assertImportRecordsItsOwnOutcome(imported);
  if (imported.record.status.provenance !== "verified") throw new Error("Survey did not verify the extraction's excerpts");
  return {
    imported,
    extraction: {
      envelopeDigest: extractionEnvelopeDigest(envelope),
      importStatus: structuredClone(imported.record.status) as NonNullable<StoredRun["extraction"]>["importStatus"],
    },
  };
}

/**
 * Survey imports a grounded extraction, or one that is unresolved because the
 * extraction itself says it is incomplete: a partial run that proposed nothing
 * (`extraction-incomplete`). That run is persisted with an empty review queue
 * and its typed partial outcome, so it reads as incomplete rather than as a
 * complete run that found nothing, and export refuses it on coverage. Every
 * other unresolved import (an unavailable or mismatched artifact, an excerpt
 * that is not in the source) is refused here as before. A `failure` outcome
 * never reaches this point: Traverse reports it with `result.error`, which
 * `runFieldwork` refuses before import.
 */
function assertImportRecordsItsOwnOutcome(imported: ExtractionEnvelopeImportResult): void {
  const { state, diagnostics } = imported.record.status;
  if (state === "grounded") return;
  if (diagnostics.length > 0 && diagnostics.every((diagnostic) => diagnostic.kind === "extraction-incomplete")) return;
  throw new Error("Survey refused ungrounded extraction envelope");
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
  // A task-level refusal names a task field, never source text, so its own
  // message is safe to carry and is the only thing that says which field.
  if (code === "TASK_UNSUPPORTED_FIELD_TYPE" && error instanceof Error) return { code, message: error.message };
  // Built by `extractionFailure` from a bounded, checked runtime message.
  if (code === "RUNTIME_INVOCATION_FAILED" && error instanceof Error) return { code, message: error.message };
  return { code, message: safeMessages[code] ?? "Source processing failed" };
}

/**
 * A model runtime always runs through Traverse's Relay adapter, which cannot
 * express a nested schema for `array` or `object` targets and refuses them only
 * once extraction starts, with an untyped error. Refuse the task up front,
 * naming the field. The deterministic provider supports both types, so this
 * applies only when a runtime is bound. Remove once Traverse can express nested
 * target schemas (fieldwork#139).
 */
export function assertRuntimeSupportsTask(task: FieldworkTask): void {
  const unsupported = task.spec.traverse.targetSchema.find((field) => field.type === "array" || field.type === "object");
  if (!unsupported) return;
  throw Object.assign(
    new Error(
      `Task field ${unsupported.path} has type ${unsupported.type}, which a model runtime cannot extract yet: `
      + "Traverse's Relay adapter has no nested schema for array or object targets. "
      + "Use a scalar type for this field, or run the task without a model runtime."
    ),
    { code: "TASK_UNSUPPORTED_FIELD_TYPE" }
  );
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
export async function reviewedExport(
  runDirectory: string,
  options: { readonly maxEstimatedBytes?: number } = {},
): Promise<ReviewedExportV1> {
  const stored = await readRun(runDirectory);
  assertCompleteCoverage(stored.envelope);
  assertExportSizeWithinCeiling(stored, options.maxEstimatedBytes ?? FIELDWORK_LIMITS.reviewedExportEstimateBytes);
  const queue = stored.run.review.snapshot.items as readonly ReviewItem[];
  if (queue.some((item) => item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER])) {
    assertExcerptsMatchPreparedText(stored.envelope, stored.preparedText);
  }
  const projection = projectAttestedReviewedProjection(stored);
  const { refused, unchecked } = classifyGroundingRefusals(projection);
  const bundle = validateTrustBundle(buildSurveyTrustBundle(projection.canonical.surveyInput, { projectionContextId: projection.canonical.projectionContextId }));
  const output = {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "ReviewedExport",
    bundle: disputeContestedClaims(withReviewedGroundingEvidence(bundle, projection.enrichment), refused),
    reviewedGrounding: withSchemaMismatchGaps(projection.enrichment.grounding, refused),
    reviewRound: reviewRoundScope(stored, projection, refused, unchecked),
  };
  assertPortableOutput(output);
  return parseReviewedExport(output);
}

/**
 * What this export covers of its review round: the revision it was taken at,
 * every claim it left out and why, and who decided each claim it carries, how,
 * and when the server accepted it. `complete` is true exactly when nothing was
 * excluded, so a consumer can tell a complete export from a partial one.
 *
 * Attribution lives here rather than on Survey's review outcome until Survey
 * can hold an actor kind and review mode (kontourai/survey#234). The outcome's
 * own `actor` and `reviewedAt` already carry the stamped actor and time.
 */
function reviewRoundScope(
  stored: StoredRunMetadataRead,
  projection: ReturnType<typeof projectAttestedReviewedProjection>,
  groundingRefused: readonly GroundingRefusedClaim[],
  groundingUnchecked: readonly GroundingRefusedClaim[],
): Record<string, unknown> {
  return {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "ReviewedExportScope",
    revision: stored.run.review.revision,
    eventCount: stored.run.review.events.length,
    complete: projection.excluded.length === 0,
    excluded: projection.excluded,
    // Present only when a claim the review accepted is not supported by its
    // grounding, or states a value that does not satisfy its field's schema,
    // so the receipt never states it as plainly verified.
    ...(groundingRefused.length === 0 ? {} : { groundingRefused }),
    // Present only when Surface cannot check a verified claim's structure
    // (an array or object value). Nothing disputes such a claim, so it stays
    // verified; this says its grounding was not fully evaluated.
    ...(groundingUnchecked.length === 0 ? {} : { groundingUnchecked }),
    decisions: projection.attribution,
  };
}

/** A claim the review accepted whose reviewed grounding was refused, and why. */
export interface GroundingRefusedClaim {
  readonly claimId: string;
  readonly fieldPath: string;
  readonly gaps: readonly string[];
  readonly evidenceIds: readonly string[];
  /** With a `schema-mismatch` gap: Traverse's `evidenceMatch.schema` for the accepted value, when it recorded one. */
  readonly schemaMatch?: string;
}

/**
 * The accepted value does not satisfy its field's declared schema: a number
 * field holding the text "2.1", a date field holding "21 March 2013". Fieldwork
 * names this gap itself, from two recorded facts: Traverse's
 * `evidenceMatch.schema` on the accepted proposal, and Surface deriving
 * `invalid` structural trust for it. Surface's own gap kinds for an invalid
 * value are the ones it also reports for a value it cannot check at all, and
 * its date check accepts any string, so neither says this on its own.
 */
export const SCHEMA_MISMATCH_GAP = "schema-mismatch";

/**
 * Gaps Surface reports for a value whose structure it cannot validate (an
 * `array` or `object` field). They say the grounding was not fully evaluated,
 * not that anything contradicts the value.
 */
const STRUCTURAL_GAPS = new Set(["evidence-not-entailing", "structure-not-validated", "profile-gap"]);
/** Gaps that mean a rival value for the claim was never resolved: the claim is contested. */
const RIVAL_GAPS = new Set(["excluded-rival-unresolved", "hidden-conflict", "chosen-over-rival-unresolved"]);

/**
 * Claims the review resolved to a verified value whose grounding nonetheless
 * does not hold, split by why. `refused` holds claims with any gap beyond
 * Surface's structural limits: a value contested by an excluded rival, or a
 * value that does not satisfy its field's schema (`schema-mismatch`).
 * `unchecked` holds claims whose only gaps are structural: a value Surface
 * could not check, with nothing recorded against it. A rejected or unconfirmed
 * claim already does not read as verified, so neither lists it.
 */
export function classifyGroundingRefusals(projection: Pick<ReturnType<typeof projectAttestedReviewedProjection>, "canonical" | "enrichment" | "items" | "results">): {
  readonly refused: GroundingRefusedClaim[];
  readonly unchecked: GroundingRefusedClaim[];
} {
  const { grounding } = projection.enrichment;
  const gapsByClaim = new Map<string, { kinds: string[]; evidenceIds: string[]; schemaMatch?: string }>();
  const entryFor = (claimId: string) => {
    const entry = gapsByClaim.get(claimId) ?? { kinds: [], evidenceIds: [] };
    gapsByClaim.set(claimId, entry);
    return entry;
  };
  const add = (claimId: string, kind: string, evidenceId?: string) => {
    const entry = entryFor(claimId);
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
    if (evidenceId !== undefined && !entry.evidenceIds.includes(evidenceId)) entry.evidenceIds.push(evidenceId);
  };
  if (grounding.outcome === "refused") {
    for (const gap of grounding.gaps) {
      if (!("claimId" in gap)) continue;
      const evidenceId = "evidenceId" in gap ? gap.evidenceId : undefined;
      add(gap.claimId, gap.kind, evidenceId);
      // `unvalidated` is a value Surface could not check; `invalid` is one it
      // checked and found not to be of the declared type.
      if (gap.kind === "structure-not-validated" && gap.structuralTrust === "invalid") add(gap.claimId, SCHEMA_MISMATCH_GAP, evidenceId);
    }
  }
  for (const mismatch of acceptedSchemaMismatches(projection)) {
    add(mismatch.claimId, SCHEMA_MISMATCH_GAP, mismatch.evidenceId);
    entryFor(mismatch.claimId).schemaMatch = mismatch.schema;
  }
  const refused: GroundingRefusedClaim[] = [];
  const unchecked: GroundingRefusedClaim[] = [];
  for (const claim of projection.canonical.surveyInput.claims) {
    const entry = gapsByClaim.get(claim.id);
    if (claim.status !== "verified" || !entry) continue;
    const listed = {
      claimId: claim.id, fieldPath: claim.fieldOrBehavior, gaps: entry.kinds, evidenceIds: entry.evidenceIds,
      ...(entry.schemaMatch === undefined ? {} : { schemaMatch: entry.schemaMatch }),
    };
    (entry.kinds.every((kind) => STRUCTURAL_GAPS.has(kind)) ? unchecked : refused).push(listed);
  }
  return { refused, unchecked };
}

/**
 * Accepted candidates whose value Traverse recorded as not satisfying the
 * field's schema. Only an envelope-imported candidate carries the record, and
 * those items are not editable, so the decided value is the candidate's own.
 */
function acceptedSchemaMismatches(
  projection: Pick<ReturnType<typeof projectAttestedReviewedProjection>, "canonical" | "enrichment" | "items" | "results">,
): { readonly claimId: string; readonly evidenceId?: string; readonly schema: string }[] {
  const claimIdByCandidateId = claimIdsByCandidate(projection.canonical.surveyInput);
  const resultsByName = new Map(projection.results.map((result) => [result.reviewItemName, result]));
  const evidenceIds = new Set(projection.enrichment.additionalEvidence.map((evidence) => evidence.id));
  return projection.items.flatMap((item) => {
    const result = resultsByName.get(item.metadata.name);
    const selected = result === undefined ? undefined : selectedCandidateOf(item, result);
    if (!result || !selected) return [];
    const mismatch = candidateSchemaMismatch(selected);
    const claimId = claimIdForItem(item, claimIdByCandidateId);
    if (!mismatch || !claimId) return [];
    const evidenceId = `${item.metadata.name}.reviewed-extraction-evidence`;
    return [{ claimId, schema: mismatch.schema, ...(evidenceIds.has(evidenceId) ? { evidenceId } : {}) }];
  });
}

/** Claims whose grounding was refused for a reason other than Surface's structural limits. */
export function groundingRefusedClaims(projection: Pick<ReturnType<typeof projectAttestedReviewedProjection>, "canonical" | "enrichment" | "items" | "results">): GroundingRefusedClaim[] {
  return classifyGroundingRefusals(projection).refused;
}

/**
 * A verified claim whose grounding was refused because a rival value is
 * unresolved is contested, and one whose accepted value does not satisfy its
 * field's schema is not a verified value of that field. Both are stated as
 * disputed. Surface derives a claim's status from its
 * verification events, so the claim's own status field alone is not enough:
 * a later `disputed` event from this export, citing the reviewed evidence the
 * policy refused, makes Surface's trust report say disputed. The reviewer's
 * own `verified` event is kept as recorded.
 */
export function disputeContestedClaims<T extends ReturnType<typeof validateTrustBundle>>(
  bundle: T,
  refused: readonly GroundingRefusedClaim[],
  now: Date = new Date(),
): T {
  const contested = refused.filter((entry) => disputeReasons(entry).length > 0);
  if (contested.length === 0) return bundle;
  const ids = new Set(contested.map((entry) => entry.claimId));
  // Surface takes a claim's newest event, and on a tie keeps the earlier one in
  // array order, so the dispute must be strictly newer than every event already
  // recorded for the claim, whatever this host's clock says (skew, or a run
  // moved between hosts).
  const disputedAt = (claimId: string): string => new Date(Math.max(
    now.getTime(),
    ...bundle.events.filter((event) => event.claimId === claimId)
      .flatMap((event) => [event.createdAt, event.verifiedAt])
      .flatMap((instant) => instant === undefined || Number.isNaN(Date.parse(instant)) ? [] : [Date.parse(instant) + 1]),
  )).toISOString();
  return validateTrustBundle({
    ...bundle,
    claims: bundle.claims.map((claim) => ids.has(claim.id) ? { ...claim, status: "disputed" as const } : claim),
    events: [...bundle.events, ...contested.map((entry) => ({
      id: `${entry.claimId}.reviewed-grounding-dispute`,
      claimId: entry.claimId,
      status: "disputed" as const,
      actor: REVIEWED_EVIDENCE_COLLECTED_BY,
      method: REVIEWED_GROUNDING_POLICY_ID,
      evidenceIds: [...entry.evidenceIds],
      createdAt: disputedAt(entry.claimId),
      notes: `Reviewed grounding refused: ${disputeReasons(entry).join(", ")}.`,
    }))],
  }) as T;
}

/**
 * Why an accepted claim is stated as disputed: the unresolved rival gaps, and
 * a schema mismatch with the rule Traverse recorded it under, or `invalid`
 * when only Surface's derivation says so.
 */
function disputeReasons(entry: GroundingRefusedClaim): string[] {
  return [
    ...entry.gaps.filter((gap) => RIVAL_GAPS.has(gap)),
    ...(entry.gaps.includes(SCHEMA_MISMATCH_GAP) ? [`${SCHEMA_MISMATCH_GAP} (${entry.schemaMatch ?? "invalid"})`] : []),
  ];
}

/**
 * Surface's evaluation with Fieldwork's schema-mismatch gaps added. Surface
 * accepts any string as a `date`, so on its own it allows a claim whose date
 * is "21 March 2013"; the export's evaluation must not read `allowed` over a
 * claim the same export states as disputed.
 */
function withSchemaMismatchGaps<T extends ReturnType<typeof buildReviewedEvidenceEnrichment>["grounding"]>(
  grounding: T,
  refused: readonly GroundingRefusedClaim[],
): T {
  const mismatched = refused.filter((entry) => entry.gaps.includes(SCHEMA_MISMATCH_GAP));
  if (mismatched.length === 0 || grounding.outcome === "not-evaluated") return grounding;
  return {
    ...grounding,
    outcome: "refused",
    gaps: [...(grounding.gaps ?? []), ...mismatched.map((entry) => ({
      kind: SCHEMA_MISMATCH_GAP,
      claimId: entry.claimId,
      ...(entry.evidenceIds[0] === undefined ? {} : { evidenceId: entry.evidenceIds[0] }),
      ...(entry.schemaMatch === undefined ? {} : { schemaMatch: entry.schemaMatch }),
    }))],
  } as unknown as T;
}

/**
 * A reviewed export states grounding over the document, so it must not be built
 * from an extraction that did not read all of it. Traverse records two kinds of
 * incomplete coverage: a typed partial outcome (a chunk, call, token or cancel
 * ceiling stopped later chunks), and a chunk whose provider call failed, which
 * leaves `outcome.status` at `success` and is recorded only in
 * `providerFailures`. Either way a field that lived in the unread text has no
 * claim and no gap, so exporting would read as complete. Surface's
 * reviewed-grounding policy has no coverage gap kind to carry this inside the
 * bundle, so refuse instead (fieldwork#136).
 *
 * This lives on the export path rather than in the shared projection: the
 * per-proposal reviewed-web-source reads describe one grounded proposal, not
 * the document's coverage.
 */
function assertCompleteCoverage(envelope: PortableExtractionResultEnvelope): void {
  const { outcome, providerFailures = [] } = envelope.result;
  const reasons: string[] = [];
  if (outcome.status === "partial") reasons.push(`partial: ${outcome.reason}`);
  else if (outcome.status !== "success") reasons.push(`${outcome.status}: ${outcome.category}/${outcome.code}`);
  for (const failure of providerFailures) reasons.push(`provider ${failure.provider} failed (${failure.kind})`);
  if (reasons.length === 0) return;
  throw Object.assign(
    new Error(
      `Export refused: this run's extraction did not cover the whole document (${reasons.join("; ")}). `
      + "Fields in the unread text have neither a claim nor a gap, so a reviewed export would read as complete; "
      + "re-run the source so that every chunk is extracted."
    ),
    { code: "EXPORT_COVERAGE_INCOMPLETE" }
  );
}

/**
 * Every first-round item's reviewed-extraction evidence embeds the whole
 * import record, envelope included, so an export carries one envelope copy per
 * decided proposal and grows with the square of the proposal count. A few
 * hundred proposals would otherwise fail late, inside serialization, with a
 * runtime string-length or memory error. Estimate the size before projecting
 * any evidence and refuse above the ceiling (fieldwork#141). A recheck round
 * projects no such evidence, so it has nothing to estimate. Remove once
 * Surface's reviewed-extraction evidence profile can reference one shared
 * envelope instead of cloning it per entry.
 */
function assertExportSizeWithinCeiling(stored: StoredRunMetadataRead, maxEstimatedBytes: number): void {
  const items = stored.run.review.snapshot.items as readonly ReviewItem[];
  if (items.some((item) => item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER])) return;
  const estimatedBytes = Buffer.byteLength(JSON.stringify(stored.envelope)) * items.length;
  if (estimatedBytes <= maxEstimatedBytes) return;
  throw Object.assign(
    new Error(
      `Export refused: a reviewed export of ${items.length} proposals is estimated at ${estimatedBytes} bytes, `
      + `above the ${maxEstimatedBytes}-byte ceiling. Each proposal's reviewed evidence embeds the whole extraction, `
      + "so export size grows with the square of the proposal count; split the source or narrow the task so fewer proposals are reviewed per run."
    ),
    { code: "EXPORT_TOO_LARGE" }
  );
}

/**
 * The queue/envelope attestation compares two stored artifacts with each other;
 * neither is the source. An edit that rewrites an envelope excerpt and
 * re-derives the queue from it passes that check, and would export a verified
 * claim citing text the document does not contain (fieldwork#140). `readRun`
 * has already bound the prepared text to its digest, so compare every
 * proposal's `chars:a-b` span with those bytes — the same rule the review
 * inspector uses to show `excerpt-mismatch`. The inspector's own per-candidate
 * state is not reused: it marks every candidate of a source once any one
 * mismatches, so it cannot name the field that does.
 *
 * Only a recheck round needs this now. A first round's queue is attested
 * against an import Survey verified against the same prepared text, which
 * leaves a mismatched proposal out of the queue and records it as an excluded
 * rival; the grounding policy then refuses the claim it was a rival for,
 * instead of this refusing the whole export. A recheck round's current-side
 * candidates are matched against the envelope's proposals directly, so a
 * mismatched one would still be cited there.
 */
function assertExcerptsMatchPreparedText(envelope: PortableExtractionResultEnvelope, preparedText: string): void {
  for (const proposal of envelope.result.proposals) {
    const span = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
    if (span && preparedText.slice(Number(span[1]), Number(span[2])) === proposal.provenance.excerpt) continue;
    throw Object.assign(
      new Error(
        `Export refused: the excerpt recorded for ${proposal.fieldPath} at ${proposal.provenance.locator} `
        + "is not what the prepared source text contains there. A reviewed claim has to cite text the document "
        + "actually contains; re-run the source rather than editing stored extraction state."
      ),
      { code: "EXPORT_EXCERPT_MISMATCH" }
    );
  }
}

/**
 * Survey leaves a proposal whose excerpt does not verify out of the queue and
 * records it on the review item of its claim slot, as an excluded rival. When
 * every proposal of a slot is excluded there is no item to record it on, so
 * the field would drop out of the export silently and the round would read as
 * complete. Refuse instead, naming the field, as export did before Survey
 * verified excerpts at import.
 */
function assertNoFieldLostToExcludedExcerpts(imported: ExtractionEnvelopeImportResult, envelope: PortableExtractionResultEnvelope): void {
  const recorded = new Set(imported.reviewItems.flatMap((item) => {
    const producer = item.metadata.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { excludedProposals?: { proposalIndex?: unknown }[] } | undefined;
    return (producer?.excludedProposals ?? []).map((entry) => entry.proposalIndex);
  }));
  const lost = imported.record.status.diagnostics.flatMap((diagnostic) => diagnostic.kind === "excerpt-mismatch"
    && !recorded.has(diagnostic.proposalIndex) ? [diagnostic] : []);
  if (lost.length === 0) return;
  const fields = [...new Set(lost.map((diagnostic) => envelope.result.proposals[diagnostic.proposalIndex]?.fieldPath ?? `proposal ${diagnostic.proposalIndex}`))];
  throw Object.assign(
    new Error(
      `Export refused: no proposal for ${fields.join(", ")} cites text the prepared source contains `
      + `(${lost.map((diagnostic) => diagnostic.locator).join(", ")}), so the field has no reviewable value and would drop out of the export unnoticed. `
      + "A reviewed claim has to cite text the document actually contains; re-run the source."
    ),
    { code: "EXPORT_EXCERPT_MISMATCH", fieldPaths: fields },
  );
}

/**
 * Rebuild the one attested Survey-to-Surface projection shared by reviewed
 * export and owner-authorized metadata reads. It accepts the metadata half of
 * a run, so no caller hydrates prepared source bytes just to prove the
 * persisted queue, envelope, candidate, decision, and canonical claim IDs
 * agree. This remains an internal Fieldwork composition seam.
 *
 * The unit of trust is the claim, not the run (fieldwork#149). Checks about
 * the round's integrity — the queue's attestation, a grounded extraction, a
 * valid event history — still refuse the whole round. Checks about one claim
 * — undecided, resolved onto an absence, contested by a differing accepted
 * value, not projectable — exclude that claim and list it in `excluded`, so
 * one contested field no longer blocks every other reviewed claim. Nothing
 * excluded becomes a claim, verified or otherwise. A round with nothing left
 * to export is still refused: a receipt over nothing certifies nothing.
 */
export function projectAttestedReviewedProjection(stored: StoredRunMetadataRead & { readonly preparedText?: string }): {
  readonly imported: ExtractionEnvelopeImportResult;
  readonly items: readonly ReviewItem[];
  readonly results: readonly ReviewWorkbenchResult[];
  readonly canonical: ReturnType<typeof buildCanonicalReviewedTrustInput>;
  readonly enrichment: ReturnType<typeof buildReviewedEvidenceEnrichment>;
  readonly excluded: readonly ReviewedExportExclusion[];
  readonly attribution: readonly (ReviewDecisionAttribution & { readonly claimId: string })[];
} {
  assertPortableOutput(stored.envelope);
  const imported = storedExtractionImport(stored);
  if (imported.record.status.state !== "grounded") throw new Error("Export refused: extraction is not grounded");
  const queue = stored.run.review.snapshot.items as readonly ReviewItem[];
  assertReviewedQueueIsAttested(queue, imported, stored.envelope);
  if (stored.run.extraction === undefined) throw unboundEnvelope();
  assertNoFieldLostToExcludedExcerpts(imported, stored.envelope);
  const record = reviewSessionRecord(stored.run, stored.run.review.events.length);
  const applied = deriveServerReviewSessionApplyResult({ record, events: stored.run.review.events, requiredResolvedItems: "none" });
  if (!applied.ok || !applied.replayedSession) {
    throw new Error(`Export refused: ${applied.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" ")}`);
  }
  const attributed = attributeReviewResults(applied.replayedSession, stored.run.review.events, applied.results);
  const exportable = partitionExportableClaims(stored.run.runResource, queue, attributed.results);
  const { items, results, excluded } = exportable;
  if (items.length === 0) throw nothingExportable(excluded, exportable.errors);
  const canonical = projectCanonicalReview(stored.run.runResource, items, results);
  const claimIdByCandidateId = claimIdsByCandidate(canonical.surveyInput);
  const enrichment = buildReviewedEvidenceEnrichment({
    imported, items, results,
    isRecheckItem: (item) => Boolean(item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER]),
    claimIdForCandidate: (candidateId) => claimIdByCandidateId.get(candidateId),
    claims: canonical.surveyInput.claims.map((claim) => ({ id: claim.id, value: claim.value })),
  });
  const itemsByName = new Map(items.map((item) => [item.metadata.name, item]));
  const attribution = results.map((result) => {
    const entry = attributed.attribution.find((candidate) => candidate.reviewItemName === result.reviewItemName);
    const item = itemsByName.get(result.reviewItemName);
    const claimId = item === undefined ? undefined : claimIdForItem(item, claimIdByCandidateId);
    if (!entry || !claimId) throw new Error(`Cannot attribute the reviewed claim decided by ${result.reviewItemName}`);
    return { ...entry, claimId };
  });
  return { imported, items, results, canonical, enrichment, excluded, attribution };
}

/**
 * Which claim each projected candidate belongs to, through the candidate set
 * the claim names. A decision that selects no candidate (reject-all or
 * could-not-confirm on a conflict set) yields a claim with no `candidateId`,
 * so keying on the selected candidate alone would lose it; every candidate in
 * the claim's set belongs to it whether or not it was selected.
 */
function claimIdsByCandidate(input: ReturnType<typeof buildCanonicalReviewedTrustInput>["surveyInput"]): Map<string, string> {
  const candidateSets = new Map(input.candidateSets.map((set) => [set.id, set]));
  const claimIdByCandidateId = new Map<string, string>();
  for (const claim of input.claims) {
    const set = candidateSets.get(claim.candidateSetId);
    if (!set) throw new Error(`Claim ${claim.id} names candidate set ${claim.candidateSetId}, which the projection does not carry`);
    for (const candidate of set.candidates) {
      if (claimIdByCandidateId.has(candidate.id)) throw new Error(`Two claims reference candidate ${candidate.id}; cannot attribute reviewed evidence`);
      claimIdByCandidateId.set(candidate.id, claim.id);
    }
  }
  return claimIdByCandidateId;
}

/** The one claim every candidate of `item` was projected into, by identity rather than by which one was selected. */
function claimIdForItem(item: ReviewItem, claimIdByCandidateId: ReadonlyMap<string, string>): string | undefined {
  const claimIds = new Set(item.spec.candidates.map((candidate) => claimIdByCandidateId.get(candidate.projection?.candidateId ?? candidate.id)));
  const [claimId] = claimIds;
  return claimIds.size === 1 ? claimId : undefined;
}

/**
 * The candidate a decided result selected, or `undefined` when the decision
 * selects none: Survey's reject-all and could-not-confirm on a conflict set
 * name no candidate and state no value. Survey decides which decisions those
 * are, and a result that names no candidate for any other decision is refused
 * rather than read as the item's first candidate.
 */
function selectedCandidateOf(item: ReviewItem, result: ReviewWorkbenchResult): ReviewItem["spec"]["candidates"][number] | undefined {
  if (result.selectedCandidateId === undefined) {
    if (decisionSelectsNoCandidate(item, result.decision)) return undefined;
    throw unresolvableDecision(result.reviewItemName, undefined);
  }
  const selected = item.spec.candidates.find((candidate) => candidate.id === result.selectedCandidateId);
  if (!selected) throw unresolvableDecision(result.reviewItemName, result.selectedCandidateId);
  return selected;
}

/**
 * Why one reviewed claim was left out of an export. `fieldPath` is the claim
 * target's field; `itemNames` are the review items that would have stated it.
 */
export interface ReviewedExportExclusion {
  readonly fieldPath: string;
  readonly itemNames: readonly string[];
  readonly code:
    | "EXPORT_UNDECIDED" | "EXPORT_FIELD_UNSETTLED" | "EXPORT_UNGROUNDED_SELECTION"
    | "EXPORT_CONFLICTING_DECISIONS" | "EXPORT_NOT_PROJECTABLE";
}

/**
 * Split a decided round into the claims that can be exported and the ones
 * that cannot, per claim target rather than per round. The checks and their
 * messages are the ones that used to refuse the whole round.
 */
export function partitionExportableClaims(
  runResource: string,
  queue: readonly ReviewItem[],
  decided: readonly ReviewWorkbenchResult[],
): {
  readonly items: ReviewItem[];
  readonly results: ReviewWorkbenchResult[];
  readonly excluded: ReviewedExportExclusion[];
  readonly errors: Error[];
} {
  const resultsByName = new Map(decided.map((result) => [result.reviewItemName, result]));
  const itemsByName = new Map(queue.map((item) => [item.metadata.name, item]));
  const excluded: ReviewedExportExclusion[] = [];
  const errors: Error[] = [];
  const out = new Set<string>();
  const exclude = (entry: ReviewedExportExclusion, error: Error): void => {
    excluded.push(entry);
    errors.push(error);
    for (const name of entry.itemNames) out.add(name);
  };
  for (const item of queue) {
    if (resultsByName.has(item.metadata.name)) continue;
    exclude({ fieldPath: fieldPathOf(item), itemNames: [item.metadata.name], code: "EXPORT_UNDECIDED" }, undecided(item));
  }
  for (const result of decided) {
    const item = itemsByName.get(result.reviewItemName);
    // Skipping what cannot be resolved is how a check stops noticing removals.
    if (!item) throw unresolvableDecision(result.reviewItemName, result.selectedCandidateId);
    const selected = selectedCandidateOf(item, result);
    // A decision that selects no candidate states no value, so there is no
    // span for it to cite; its claim carries no value (see conflictingClaimTargets).
    if (selected === undefined) continue;
    const ungrounded = ungroundedSelection(item, selected, result);
    if (ungrounded) exclude({ fieldPath: fieldPathOf(item), itemNames: [item.metadata.name], code: "EXPORT_UNGROUNDED_SELECTION" }, ungrounded);
  }
  for (const conflict of conflictingClaimTargets(queue, decided)) {
    exclude({ fieldPath: conflict.fieldPath, itemNames: conflict.itemNames, code: "EXPORT_CONFLICTING_DECISIONS" }, conflict.error);
  }
  // A field is settled only when every item that states it is decided. An
  // undecided sibling may carry a different value, so exporting the decided
  // one would state as reviewed what the review left open.
  for (const unsettled of unsettledClaimTargets(queue, resultsByName)) {
    exclude({ fieldPath: unsettled.fieldPath, itemNames: unsettled.itemNames, code: "EXPORT_FIELD_UNSETTLED" }, unsettled.error);
  }
  const items: ReviewItem[] = [];
  const results: ReviewWorkbenchResult[] = [];
  for (const item of queue) {
    const result = resultsByName.get(item.metadata.name);
    if (!result || out.has(item.metadata.name)) continue;
    try {
      projectCanonicalReview(runResource, [item], [result]);
    } catch (error) {
      exclude({ fieldPath: fieldPathOf(item), itemNames: [item.metadata.name], code: "EXPORT_NOT_PROJECTABLE" }, error as Error);
      continue;
    }
    items.push(item);
    results.push(result);
  }
  return { items, results, excluded, errors };
}

function unsettledClaimTargets(
  queue: readonly ReviewItem[],
  resultsByName: ReadonlyMap<string, ReviewWorkbenchResult>,
): { readonly fieldPath: string; readonly itemNames: string[]; readonly error: Error }[] {
  const byTarget = new Map<string, { fieldPath: string; decided: string[]; undecided: string[] }>();
  for (const item of queue) {
    const target = item.spec.candidates[0]?.claimTarget;
    if (!target) continue;
    const { claimId: _claimId, ...identity } = target;
    const key = canonicalJson(identity);
    const entry = byTarget.get(key) ?? { fieldPath: target.fieldOrBehavior, decided: [], undecided: [] };
    byTarget.set(key, entry);
    (resultsByName.has(item.metadata.name) ? entry.decided : entry.undecided).push(item.metadata.name);
  }
  return [...byTarget.values()]
    .filter((entry) => entry.decided.length > 0 && entry.undecided.length > 0)
    .map((entry) => ({
      fieldPath: entry.fieldPath,
      itemNames: entry.decided,
      error: Object.assign(
        new Error(
          `Export refused: ${entry.fieldPath} is not settled. Items ${entry.decided.join(", ")} are decided but `
          + `${entry.undecided.join(", ")} on the same field is not; decide every item on ${entry.fieldPath} before it can be exported.`
        ),
        { code: "EXPORT_FIELD_UNSETTLED" }
      ),
    }));
}

function fieldPathOf(item: ReviewItem): string {
  return item.spec.candidates[0]?.claimTarget.fieldOrBehavior ?? item.spec.target;
}

function undecided(item: ReviewItem): Error {
  return Object.assign(
    new Error(`Export refused: review item ${item.metadata.name} (${fieldPathOf(item)}) has no resolved review decision.`),
    { code: "EXPORT_UNDECIDED" }
  );
}

/**
 * Every claim in the round was excluded. Refuse with the first exclusion's own
 * typed error, which carries the advice for that claim, and say how many other
 * claims were excluded and why.
 */
function nothingExportable(excluded: readonly ReviewedExportExclusion[], errors: readonly Error[]): Error {
  const [first] = errors;
  if (!first) {
    return Object.assign(new Error("Export refused: this review round has no claims to export."), { code: "EXPORT_NOT_PROJECTABLE", excluded });
  }
  const others = excluded.slice(1);
  if (others.length > 0) {
    first.message += ` No claim in this round is exportable; ${others.length} other exclusion(s): `
      + `${others.map((entry) => `${entry.code} ${entry.fieldPath}`).join(", ")}.`;
  }
  return Object.assign(first, { excluded });
}

/**
 * Enrich a validated trust bundle with surface's reviewed-extraction-evidence
 * projection (kontourai/fieldwork#88, first consumer of the surface 2.13
 * contract). New evidence is prepended
 * ahead of the bundle's own evidence so a caller reading "the" evidence per
 * claim by last-write-wins (as Survey's own citation evidence has always been
 * read) keeps seeing Survey's original entry; the new profile-tagged entry is
 * additive and is found by its own `metadata.reviewedExtraction` marker.
 * Re-running `validateTrustBundle` over the enriched bundle proves surface
 * still accepts it as a well-formed TrustBundle.
 *
 * The grounding evaluation is not added to the bundle: `reviewedExport`
 * carries it beside the bundle (kontourai/fieldwork#155), so the bundle stays
 * valid under a Surface that rejects unknown top-level keys.
 */
function withReviewedGroundingEvidence(
  bundle: ReturnType<typeof validateTrustBundle>,
  enrichment: ReturnType<typeof buildReviewedEvidenceEnrichment>,
): ReturnType<typeof validateTrustBundle> {
  return enrichment.additionalEvidence.length === 0
    ? bundle
    : validateTrustBundle({ ...bundle, evidence: [...enrichment.additionalEvidence, ...bundle.evidence] });
}

/**
 * Check the decided queue against an artifact it was not derived from.
 *
 * Before fieldwork#59, Survey received envelope-derived items while the results
 * came from the persisted queue, so `assertCanonicalResult` compared two
 * independent origins and a queue edited after the decision disagreed with the
 * envelope. Projecting the decided queue is the right authority but removes
 * that second origin, so it is restored here explicitly.
 *
 * The whole-extraction rule is Survey's now (survey#213, adopted for
 * fieldwork#79): `assertReviewQueueAgainstExtractionImport` re-derives the
 * canonical items through the public import boundary and requires the stored
 * queue to be the same set, byte-identical per item, in both directions — an
 * emptied queue is refused outright, because a receipt over nothing certifies
 * nothing. What Survey deliberately does not own stays here: which attestation
 * applies to a recheck round's items, whose evidence is a snapshot this run
 * never extracted. That dispatch never trusts a single mutable label — which
 * observation a recheck candidate came from is derived from agreement between
 * its Lookout observation id, its role, and the round identity, so relabelling
 * one field contradicts the others instead of changing the answer.
 *
 * Survey's cross-check attests queue-to-record consistency only; keeping the
 * stored record equal to the record originally imported is the caller's
 * storage obligation, met here by `readRun`'s prepared-bytes/digest and envelope-digest bindings
 * and, for what no artifact in this run can attest — a recheck item's
 * *prior*-observation candidates and the recheck item set itself — accepted
 * and disclosed as a gap (docs/decisions/local-run-artifacts.md, fieldwork#65).
 */
function assertReviewedQueueIsAttested(
  items: readonly ReviewItem[],
  imported: ExtractionEnvelopeImportResult,
  envelope: PortableExtractionResultEnvelope
): void {
  const recheckItems = items.filter((item) => item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER]);
  if (recheckItems.length > 0 && recheckItems.length !== items.length) {
    throw unattested("the queue mixes imported extraction items with recheck-round items, so neither set can attest it");
  }
  if (recheckItems.length === 0) {
    if (reviewQueueFromOlderFieldwork(items)) throw runFromOlderFieldwork();
    try {
      assertReviewQueueAgainstExtractionImport(items, imported);
    } catch (cause) {
      if (cause instanceof UnattestedExtractionQueueError) {
        throw unattested(cause.issues.map((issue) => issue.message).join(" "), cause);
      }
      throw cause;
    }
    return;
  }
  const proposalsByField = new Map<string, ExtractionProposal[]>();
  for (const proposal of envelope.result.proposals) {
    proposalsByField.set(proposal.fieldPath, [...proposalsByField.get(proposal.fieldPath) ?? [], proposal]);
  }
  for (const item of recheckItems) assertRecheckItemIsAttested(item, proposalsByField);
}

const SURVEY_EXTRACTION_ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";

/**
 * Whether a first round's queue was built by an earlier Fieldwork release.
 * Every earlier release used Survey 3 or older (none used Survey 4 or 5), which raised
 * one item per proposal. Survey 5 introduced one item per claim slot: it names each envelope item
 * after its claim slot and records the proposals it stands for as
 * `proposalIndices`; earlier items carry neither, so their names can never
 * match what Survey derives now and the run cannot be exported. Read off the
 * items Survey itself wrote, not off a stored label. A recheck round's items are
 * Lookout's and are attested separately, so they are never "older".
 */
export function reviewQueueFromOlderFieldwork(items: readonly ReviewItem[]): boolean {
  const imported = items.filter((item) => !item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER]);
  return imported.length > 0 && imported.every((item) => {
    const producer = item.metadata.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { proposalIndices?: unknown } | undefined;
    return !Array.isArray(producer?.proposalIndices);
  });
}

/**
 * How many chunks the source was cut into, and how many of them were not read
 * and answered in full. Traverse emits coverage only on a partial outcome, so
 * this is undefined for a run that read everything.
 *
 * Coverage lists the chunks whose text is in the prepared artifact. A chunk
 * cap can also drop chunks whose text the prepared artifact no longer holds:
 * a `--max-chunks 2` run of a seven-chunk page stores two complete coverage
 * entries. Those chunks are counted from `partial.remainingChunks`, Traverse's
 * count of chunks never dispatched, less the never-dispatched chunks coverage
 * already lists. They are reported as `droppedChunkCount` and included in both
 * totals, so the count never reads as "0 of 2" over a run that read two of
 * seven (fieldwork#170).
 */
export function extractionCoverageSummary(envelope: PortableExtractionResultEnvelope): ExtractionCoverageSummary | undefined {
  const { coverage, partial } = envelope.result;
  if (coverage === undefined || coverage.length === 0) return undefined;
  const chunks = new Set(coverage.map((entry) => entry.chunk));
  const incomplete = new Set(coverage.filter((entry) => entry.status !== "complete").map((entry) => entry.chunk));
  const listedUndispatched = new Set(coverage
    .filter((entry) => entry.status === "unread" && entry.reason === "not-dispatched").map((entry) => entry.chunk));
  const dropped = Math.max(0, (partial?.remainingChunks ?? 0) - listedUndispatched.size);
  return {
    chunkCount: chunks.size + dropped,
    incompleteChunkCount: incomplete.size + dropped,
    ...(dropped === 0 ? {} : { droppedChunkCount: dropped }),
  };
}

export interface ExtractionCoverageSummary {
  readonly chunkCount: number;
  readonly incompleteChunkCount: number;
  /** Chunks a chunk cap dropped whose text is not in the prepared artifact; counted in both totals. */
  readonly droppedChunkCount?: number;
}

export const UNBOUND_ENVELOPE_MESSAGE = "This run was created before Fieldwork bound each run to its stored extraction, "
  + "so an edit to that extraction cannot be detected. Its review is closed and cannot be exported; "
  + "remove this run and re-run the source to review it again.";

function unboundEnvelope(): Error {
  return Object.assign(new Error(`Export refused: ${UNBOUND_ENVELOPE_MESSAGE}`), { code: "EXPORT_UNBOUND_ENVELOPE" });
}

/**
 * Why a run opens but can never be exported, if it cannot. A run from before
 * the extraction binding is served so its source and extraction can still be
 * inspected, but its review queue is not shown and review is closed:
 * its envelope could have been edited undetected, and decisions recorded
 * against it could never be exported.
 */
export function reviewBlockedFor(run: StoredRun): Pick<FieldworkRunViewV1, "reviewBlocked"> {
  if (reviewQueueFromOlderFieldwork(run.review.snapshot.items)) {
    return { reviewBlocked: { reason: "created-by-older-fieldwork", message: RUN_FROM_OLDER_FIELDWORK_MESSAGE } };
  }
  if (run.extraction === undefined) return { reviewBlocked: { reason: "unbound-envelope", message: UNBOUND_ENVELOPE_MESSAGE } };
  return {};
}

export const RUN_FROM_OLDER_FIELDWORK_MESSAGE = "This run was created by an older Fieldwork, whose review queue the current "
  + "release cannot export. Its decisions cannot become a reviewed export; re-run the source to review it again.";

function runFromOlderFieldwork(): Error {
  return Object.assign(new Error(`Export refused: ${RUN_FROM_OLDER_FIELDWORK_MESSAGE}`), { code: "EXPORT_RUN_FROM_OLDER_FIELDWORK" });
}

/**
 * A recheck item is a transition between two observations. Which side a
 * candidate belongs to is not read off `evidenceObservation` — that is one
 * mutable field, and trusting it let a current-observation candidate be
 * relabelled `"prior"` to skip attestation entirely. It is derived from
 * agreement between the item's transition metadata, the candidate's Lookout
 * observation id, the round block, and the candidate's role, which Lookout
 * assigns as `current`→prior observation and `proposed`→current observation.
 * The role is load-bearing for the decision itself, so it cannot be moved
 * quietly to change the answer.
 */
function assertRecheckItemIsAttested(item: ReviewItem, proposalsByField: ReadonlyMap<string, ExtractionProposal[]>): void {
  const name = item.metadata.name;
  const transition = item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER] as Record<string, unknown> | undefined;
  const priorObservationId = transition?.priorObservationId;
  const currentObservationId = transition?.currentObservationId;
  if (typeof priorObservationId !== "string" || typeof currentObservationId !== "string"
    || typeof transition?.transitionId !== "string" || priorObservationId === currentObservationId) {
    throw unattested(`review item ${name} does not identify the two observations it is a transition between`);
  }
  const roles = item.spec.candidates.map((candidate) => candidate.role);
  if (item.spec.candidates.length !== 2 || !roles.includes("current") || !roles.includes("proposed")) {
    throw unattested(`review item ${name} is not the current/proposed candidate pair a transition projects`);
  }
  for (const candidate of item.spec.candidates) {
    const observed = candidate.producer?.[SEMANTIC_TRANSITION_PRODUCER] as Record<string, unknown> | undefined;
    const round = candidate.producer?.[RECHECK_ROUND_PRODUCER] as Record<string, unknown> | undefined;
    const observationId = observed?.observationId;
    // Every way of saying which observation this candidate came from has to say
    // the same thing before any of them is believed.
    const side = observationId === priorObservationId ? "prior"
      : observationId === currentObservationId ? "current"
        : undefined;
    if (!side
      || round?.transitionId !== transition.transitionId
      || round.semanticKind !== transition.semanticKind
      || round.priorObservationId !== priorObservationId
      || round.currentObservationId !== currentObservationId
      || round.evidenceObservation !== side
      || (candidate.role === "current" ? side !== "prior" : side !== "current")) {
      throw unattested(`candidate ${candidate.id} disagrees with itself about which observation it came from`);
    }
    if (side === "prior") continue;
    const matches = proposalsByField.get(candidate.extraction.target) ?? [];
    if (observed?.evidenceState !== "present") {
      if (matches.length > 0) {
        throw unattested(`review item ${name} records ${candidate.extraction.target} as absent, but this run extracted it`);
      }
      continue;
    }
    const grounded = matches.some((proposal) => canonicalJson(proposal.candidateValue) === canonicalJson(candidate.value)
      && proposal.provenance.locator === candidate.locator?.locator
      && proposal.provenance.excerpt === candidate.locator?.excerpt
      && proposal.extractor === candidate.extraction.extractor);
    if (!grounded) {
      throw unattested(`review item ${name} states a ${candidate.extraction.target} this run's extraction does not`);
    }
  }
}

/**
 * A recorded decision whose item or candidate is no longer in the queue. Survey
 * derives results from the queue, so production cannot reach this — which is
 * exactly why it must refuse rather than `continue`: a guard that walks past
 * what it cannot resolve stops being a guard the moment that assumption breaks.
 */
function unresolvableDecision(reviewItemName: string, candidateId: string | undefined): Error {
  return Object.assign(
    new Error(candidateId === undefined
      ? `Export refused: decision on ${reviewItemName} selects no candidate, but that decision on this item has to select one.`
      : `Export refused: decision on ${reviewItemName} selects candidate ${candidateId}, which is not in this run's reviewed queue.`
    ),
    { code: "EXPORT_UNRESOLVABLE_DECISION" }
  );
}

function unattested(detail: string, cause?: Error): Error {
  return Object.assign(
    new Error(
      `Export refused: this run's reviewed queue is not attested by its own extraction — ${detail.endsWith(".") ? detail : `${detail}.`} `
      + "The reviewed queue is the authority for what was decided, so it has to agree with the artifact it was built from; "
      + "re-run the source rather than editing stored review state.",
      cause === undefined ? undefined : { cause }
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
 * gap — and an absence has no span. Exclude that claim and say so plainly,
 * instead of letting Survey's terse locator error be the whole story.
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
function ungroundedSelection(item: ReviewItem, selected: ReviewItem["spec"]["candidates"][number], result: ReviewWorkbenchResult): Error | undefined {
  if (selected.locator?.locator) return undefined;
  return Object.assign(
    new Error(
      `Export refused: ${selected.claimTarget.fieldOrBehavior} is resolved onto a candidate that records no source span `
      + `(review item ${item.metadata.name}, decision ${result.decision}). A reviewed claim about a document has to cite `
      + `where in the document it came from, and this candidate is an absence. ${groundedAdvice(item)}`
    ),
    { code: "EXPORT_UNGROUNDED_SELECTION" }
  );
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
 * A trust bundle states one reviewed value per claim target. Two items can
 * propose different values for one field — two chunks state it differently, or
 * a recheck round raises a value change and a provenance change for one drifted
 * field (kontourai/lookout#34) — and accepting two different values would export
 * a receipt that asserts both. Exclude every item on that field instead,
 * naming it (fieldwork#149): which of the two values is right is exactly what
 * the review did not settle.
 *
 * Only `verified` results assert a value. Rejected and could-not-confirm
 * results still carry their candidate's value as `effectiveValue`, but their
 * claim status (`rejected`, `proposed`) keeps them from asserting it, so
 * comparing them would make every multi-value round unexportable whatever the
 * reviewer decided (fieldwork#137). A decision that selects no candidate
 * (reject-all or could-not-confirm on a conflict set) asserts no value at all;
 * its item still counts toward the field, by the claim target every candidate
 * of the item shares.
 */
function conflictingClaimTargets(
  items: readonly ReviewItem[],
  results: readonly ReviewWorkbenchResult[],
): { readonly fieldPath: string; readonly itemNames: string[]; readonly error: Error }[] {
  const itemsByName = new Map(items.map((item) => [item.metadata.name, item]));
  const byTarget = new Map<string, { fieldPath: string; itemNames: string[]; accepted: { itemName: string; value: string }[] }>();
  for (const result of results) {
    const item = itemsByName.get(result.reviewItemName);
    if (!item) throw unresolvableDecision(result.reviewItemName, result.selectedCandidateId);
    // Only the claim target is read from an unselected candidate, never a
    // value: every candidate of one item names the same claim target.
    const claimTarget = (selectedCandidateOf(item, result) ?? item.spec.candidates[0])?.claimTarget;
    if (!claimTarget) throw unresolvableDecision(result.reviewItemName, result.selectedCandidateId);
    const { claimId: _claimId, ...target } = claimTarget;
    const key = canonicalJson(target);
    const entry = byTarget.get(key) ?? { fieldPath: target.fieldOrBehavior, itemNames: [], accepted: [] };
    byTarget.set(key, entry);
    entry.itemNames.push(result.reviewItemName);
    if (result.status === "verified") entry.accepted.push({ itemName: result.reviewItemName, value: canonicalJson(result.effectiveValue) });
  }
  const conflicts: { fieldPath: string; itemNames: string[]; error: Error }[] = [];
  for (const entry of byTarget.values()) {
    const [first] = entry.accepted;
    const differing = entry.accepted.find((candidate) => candidate.value !== first?.value);
    if (!first || !differing) continue;
    conflicts.push({
      fieldPath: entry.fieldPath,
      itemNames: entry.itemNames,
      error: Object.assign(
        new Error(
          `Export refused: this review round accepts two different values for ${entry.fieldPath}. `
          + `Items ${first.itemName} and ${differing.itemName} both resolve to a verified value, and they differ; `
          + `accept at most one value for ${entry.fieldPath} and reject or leave unconfirmed the other.`
        ),
        { code: "EXPORT_CONFLICTING_DECISIONS" }
      ),
    });
  }
  return conflicts;
}

/**
 * Open a review round over `items` and bind it: the digest is taken once, here,
 * from the queue the reviewer is about to be shown, and every later write of
 * this run carries it forward rather than recomputing it. Survey owns the
 * binding derivation (`bindReviewQueue`, survey#213); the run store persists
 * its digest, and `storedReviewQueueBinding` rebuilds the record around that
 * stored digest at every later read.
 *
 * `bindReviewQueue` refuses an empty queue outright, but a recheck round that
 * found nothing to re-decide is a legitimate empty round: it is stored, served,
 * and refused at export. Its digest is taken with the same hash Survey binds
 * with, so the storage rule — written once, never recomputed by a later
 * writer — is identical on both paths.
 *
 * Survey's initial state carries a constant placeholder reviewer and date. The
 * round has no reviewer when it opens — the server stamps one per decision
 * (fieldwork#148) — so the round's default actor says so, and its time is when
 * the round opened.
 */
export function newReviewRound(items: readonly ReviewItem[], openedAt = new Date().toISOString()): StoredRun["review"] {
  const snapshot = { ...initialReviewQueueSessionState(items as ReviewItem[]), actorId: UNATTRIBUTED_ACTOR_ID, reviewedAt: openedAt };
  const snapshotHash = items.length > 0
    ? bindReviewQueue(snapshot, { sessionName: REVIEW_SESSION_NAME }).spec.snapshotHash
    : hashReviewQueueSnapshot(snapshot);
  return { snapshot, events: [], revision: 0, snapshotHash };
}

export function reviewSessionName(_run: StoredRun): string { return REVIEW_SESSION_NAME; }

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
/**
 * The Survey extraction import a run's first review round was built from,
 * re-derived from what the run stores beside its queue: the extraction
 * envelope and the task's claim targets. Survey's reload paths check a stored
 * queue against the import stored with it; this is that record. It is rebuilt
 * rather than kept as a second copy, so it cannot disagree with the stored
 * envelope, and the run store has already checked that envelope against the
 * digest bound when the run was created.
 *
 * With the prepared text in hand, Survey verifies every excerpt again, and the
 * status it records has to equal the one bound at creation. A metadata-only
 * read has no text to verify with, so it takes the bound status; Survey still
 * refuses one its import could not have written for this envelope. A run from
 * before the binding is imported unverified, as it was built, so its queue
 * still attests; it is served blocked and refused at export.
 */
export function storedExtractionImport(
  stored: Pick<StoredRunMetadataRead, "run" | "envelope"> & { readonly preparedText?: string },
): ExtractionEnvelopeImportResult {
  const options = extractionImportOptions(stored.run.task, importNameFor(stored.run));
  const binding = stored.run.extraction;
  if (binding === undefined) return importExtractionEnvelope(stored.envelope, options);
  if (stored.preparedText === undefined) {
    const { record } = importExtractionEnvelope(stored.envelope, options);
    const bound = { ...record, status: structuredClone(binding.importStatus) } as ExtractionEnvelopeImportResult["record"];
    return { record: bound, reviewItems: buildReviewItemsFromExtractionEnvelopeImport(bound) };
  }
  const imported = importExtractionEnvelope(stored.envelope, {
    ...options,
    artifact: { status: "available", text: stored.preparedText, actualDigest: stored.run.preparedArtifact.digest },
  });
  if (canonicalJson(imported.record.status) !== canonicalJson(binding.importStatus)) {
    throw Object.assign(
      new Error("The extraction's excerpts no longer verify against the prepared text the way they did when this run was created, "
        + "so the run cannot be read. Re-run the source rather than editing stored extraction state."),
      { code: "RUN_EXTRACTION_MISMATCH" },
    );
  }
  return imported;
}

function extractionImportOptions(task: FieldworkTask, importName: string): ExtractionEnvelopeImportOptions {
  return {
    importName, producerNamespace: "fieldwork", sourceKind: FIELDWORK_SOURCE_KIND,
    claimTarget: (proposal) => {
      const projection = task.spec.projections.find((candidate) => candidate.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error(`No claim target for ${proposal.fieldPath}`);
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }
  };
}

/**
 * Check a stored round's queue against the artifact it was built from when the
 * round is reloaded, with the same rule `reviewedExport` applies, and return
 * the import to hand to Survey's reload paths. The queue's binding digest can
 * be refreshed by whoever edits the queue, so this is what catches an edit made
 * together with its digest, before anyone reviews the edited queue.
 *
 * A first round is checked against its extraction import, which is returned. A
 * recheck round holds Lookout's transition items, which are checked against
 * the envelope and have no import to return. A queue from an older Fieldwork
 * can never match and is served blocked instead. An empty queue is not checked:
 * a recheck round that found nothing to re-decide is legitimately empty, so an
 * emptied queue cannot be told from one (the disclosed recheck item-set gap),
 * and export refuses an empty round either way.
 */
export function attestStoredReviewQueue(
  stored: Pick<StoredRunMetadataRead, "run" | "envelope">,
  imported: ExtractionEnvelopeImportResult,
): ExtractionEnvelopeImportResult | undefined {
  const items = stored.run.review.snapshot.items as readonly ReviewItem[];
  if (items.length === 0 || reviewQueueFromOlderFieldwork(items)) return undefined;
  try {
    assertReviewedQueueIsAttested(items, imported, stored.envelope);
  } catch (cause) {
    throw unattestedStoredQueue(cause as Error);
  }
  return items.some((item) => item.metadata.producer?.[SEMANTIC_TRANSITION_PRODUCER]) ? undefined : imported;
}

/**
 * A stored queue that does not match the extraction import it was built from.
 * Its binding digest can be refreshed by whoever edits the queue, so this is
 * the check that catches an edit made together with the digest.
 */
function unattestedStoredQueue(cause: Error): Error {
  return Object.assign(
    new Error(
      "Stored review queue does not match the extraction it was imported from, so it cannot be reviewed. "
      + "Re-run the source rather than editing stored review state.",
      { cause },
    ),
    { code: "REVIEW_QUEUE_UNATTESTED" },
  );
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
 * narrow composition adapter.
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
