import { z } from "zod";
import type { ReviewItem, ReviewSessionEvent } from "@kontourai/survey";
import type { ReviewQueueBinding, ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { hashReviewQueueSnapshot, UnattestedReviewQueueError } from "@kontourai/survey/review-workbench";
import {
  assertServerReviewSessionEvents,
  deriveServerReviewSessionApplyResult
} from "@kontourai/survey/review-workbench/server-review-session";
import { FIELDWORK_LIMITS } from "./contracts.js";

const text = z.string().max(FIELDWORK_LIMITS.string);
const nonempty = text.min(1);
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), text,
  z.array(jsonValueSchema).max(FIELDWORK_LIMITS.events),
  z.record(text, jsonValueSchema)
]));
const stringRecord = z.record(text, text);
const metadataSchema = z.object({
  name: nonempty,
  uid: text.optional(),
  labels: stringRecord.optional(),
  annotations: stringRecord.optional(),
  producer: z.record(text, jsonValueSchema).optional()
}).strict();
const actorSchema = z.object({ id: nonempty, displayName: text.optional() }).strict();
const sourceSchema = z.object({
  sourceRef: nonempty,
  sourceId: text.optional(),
  kind: text.optional(),
  observedAt: text.optional(),
  fetchedAt: text.optional(),
  checksum: text.optional(),
  locatorScheme: text.optional()
}).strict();
const locatorSchema = z.object({ scheme: nonempty, locator: text.optional(), excerpt: text.optional() }).strict();
const extractionSchema = z.object({
  extractionId: text.optional(),
  target: nonempty,
  confidence: z.number().finite().optional(),
  extractor: text.optional(),
  model: text.optional(),
  extractedAt: text.optional()
}).strict();
const claimTargetSchema = z.object({
  claimId: text.optional(),
  subjectType: nonempty,
  subjectId: nonempty,
  facet: nonempty,
  claimType: nonempty,
  fieldOrBehavior: nonempty,
  impactLevel: z.enum(["low", "medium", "high", "critical"]),
  evidenceType: text.optional(),
  evidenceMethod: text.optional(),
  collectedBy: text.optional(),
  derivedFrom: z.array(text).max(FIELDWORK_LIMITS.events).optional()
}).strict();
const projectionSchema = z.object({
  rawSourceId: text.optional(),
  extractionId: text.optional(),
  candidateSetId: text.optional(),
  candidateId: text.optional(),
  reviewOutcomeId: text.optional(),
  claimId: text.optional()
}).strict();
const candidateSchema = z.object({
  id: nonempty,
  role: z.enum(["current", "proposed", "alternative", "source-version", "computed"]).optional(),
  value: jsonValueSchema,
  confidence: z.number().finite().optional(),
  sourceRank: z.number().finite().optional(),
  rejectionReason: text.optional(),
  source: sourceSchema,
  locator: locatorSchema.optional(),
  extraction: extractionSchema,
  claimTarget: claimTargetSchema,
  projection: projectionSchema.optional(),
  producer: z.record(text, jsonValueSchema).optional()
}).strict();
const reviewItemSchema = z.object({
  apiVersion: z.literal("survey.kontourai.io/v1alpha1"),
  kind: z.literal("ReviewItem"),
  metadata: metadataSchema,
  spec: z.object({
    target: nonempty,
    candidates: z.array(candidateSchema).min(1).max(FIELDWORK_LIMITS.projections),
    candidateSetStatus: text.optional(),
    selectedCandidateId: text.optional(),
    rationale: text.optional(),
    producerPolicy: z.record(text, jsonValueSchema).optional(),
    projection: projectionSchema.optional(),
    valueDescriptor: z.object({
      type: z.enum(["string", "number", "boolean", "date", "enum", "array", "object"]),
      enumValues: z.array(text).max(256).optional()
    }).strict().optional(),
    editable: z.boolean().optional()
  }).strict(),
  status: z.object({
    observedCandidateCount: z.number().int().nonnegative().optional(),
    selectedCandidateId: text.optional(),
    reviewDecisionName: text.optional()
  }).strict().optional()
}).strict();
const decisionSchema = z.enum(["accept-proposed", "keep-current", "reject-proposed", "could-not-confirm"]);

export const persistedReviewSnapshotSchema = z.object({
  items: z.array(reviewItemSchema).max(FIELDWORK_LIMITS.reviewItems),
  activeItemName: text,
  notesByItemName: z.record(text, text),
  decisionsByItemName: z.record(text, decisionSchema),
  reviewedAt: nonempty,
  actorId: nonempty,
  editedValuesByItemName: z.record(text, jsonValueSchema).optional(),
  attemptEvidenceIdsByItemName: z.record(text, z.array(text).max(FIELDWORK_LIMITS.events)).optional()
}).strict();

export const persistedReviewEventSchema = z.object({
  apiVersion: z.literal("survey.kontourai.io/v1alpha1"),
  kind: z.literal("ReviewSessionEvent"),
  metadata: metadataSchema,
  spec: z.object({
    sessionName: nonempty,
    sequence: z.number().int().positive(),
    eventType: z.enum(["session-started", "item-selected", "decision-changed", "note-changed", "decision-submitted", "session-completed"]),
    occurredAt: nonempty,
    actor: actorSchema.optional(),
    reviewItemName: text.optional(),
    activeItemName: text.optional(),
    reviewDecisionName: text.optional(),
    candidateId: text.optional(),
    status: text.optional(),
    resolution: text.optional(),
    resolutionReason: text.optional(),
    attemptEvidenceIds: z.array(text).max(FIELDWORK_LIMITS.events).optional(),
    rationale: text.optional(),
    data: z.record(text, jsonValueSchema).optional()
  }).strict(),
  status: z.object({ replayed: z.boolean().optional() }).strict().optional()
}).strict();

export const REVIEW_SESSION_NAME = "review-workbench-session";

/**
 * Reconstruct the Survey `ReviewQueueBinding` for a stored round from the
 * digest persisted when the round opened (survey#213, adopted for
 * fieldwork#79).
 *
 * The stored digest is the binding's authority: it was written once, at queue
 * construction, and carried forward unchanged by every event append — never
 * recomputed here from the snapshot being checked (`hashReviewQueueSnapshot`
 * of mutated bytes would agree with them by construction). Fieldwork's run
 * schema predates the binding record and persists only the digest;
 * `hashReviewQueueSnapshot` is byte-identical to the hash those runs already
 * store, so the record is rebuilt around the stored digest instead of
 * migrating storage. `itemNames` is derived from the presented queue, which
 * makes the binding's set-membership diagnostics non-load-bearing — Survey
 * documents them as deliberately redundant with the hash, and any membership
 * edit changes the snapshot bytes the stored digest refuses.
 *
 * Returns undefined for an empty queue: Survey refuses to bind one (a binding
 * over nothing attests nothing), while an empty round — a recheck that found
 * nothing to re-decide — is still storable here. Its digest is checked
 * directly by `parsePersistedReview`, and `reviewedExport` refuses to emit a
 * receipt from it.
 */
export function storedReviewQueueBinding(
  snapshotHash: string,
  snapshot: ReviewQueueSessionState
): ReviewQueueBinding | undefined {
  if (snapshot.items.length === 0) return undefined;
  return {
    apiVersion: "survey.kontourai.io/v1alpha1",
    kind: "ReviewQueueBinding",
    spec: {
      sessionName: REVIEW_SESSION_NAME,
      snapshotHash,
      itemNames: [...new Set(snapshot.items.map((item) => item.metadata.name))].sort(),
      boundAt: new Date(0).toISOString(),
    },
  };
}

/** Temporary transport validator pending Survey issue #188. Survey remains semantic authority. */
export function parsePersistedReview(input: {
  snapshot: unknown;
  events: unknown;
  snapshotHash: string;
}): { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[]; snapshotHash: string } {
  const snapshot = persistedReviewSnapshotSchema.parse(input.snapshot) as ReviewQueueSessionState;
  const events = z.array(persistedReviewEventSchema).max(FIELDWORK_LIMITS.events).parse(input.events) as ReviewSessionEvent[];
  const names = new Set(snapshot.items.map((item) => item.metadata.name));
  if (names.size !== snapshot.items.length || (snapshot.items.length === 0 ? snapshot.activeItemName !== "" : !names.has(snapshot.activeItemName))) {
    throw new Error("Persisted Survey snapshot has invalid item identity");
  }
  for (const map of [snapshot.notesByItemName, snapshot.decisionsByItemName, snapshot.editedValuesByItemName ?? {}, snapshot.attemptEvidenceIdsByItemName ?? {}]) {
    if (Object.keys(map).some((name) => !names.has(name))) throw new Error("Persisted Survey snapshot map references an unknown item");
  }
  for (const item of snapshot.items as readonly ReviewItem[]) {
    if (new Set(item.spec.candidates.map((candidate) => candidate.id)).size !== item.spec.candidates.length) {
      throw new Error("Persisted Survey snapshot has duplicate candidate identity");
    }
  }
  /* The queue a decision was recorded against is persisted beside the decision,
     and the stored digest is the authority — not one recomputed from the same
     bytes being checked. Rebuilding the session record from the snapshot alone
     would agree with itself; Survey's queue binding only has teeth because the
     hash it compares against was written earlier, at queue construction, and
     carried forward untouched through every event append. */
  const record = {
    sessionName: REVIEW_SESSION_NAME,
    snapshot,
    snapshotHash: input.snapshotHash,
    eventCount: events.length,
    updatedAt: new Date(0).toISOString(),
  };
  const binding = storedReviewQueueBinding(input.snapshotHash, snapshot);
  if (binding === undefined && hashReviewQueueSnapshot(snapshot) !== input.snapshotHash) {
    // Survey refuses to bind an empty queue, so an empty round's digest is
    // held to the same rule directly.
    throw brokenBinding(new Error("Stored empty review round does not match its recorded digest"));
  }
  assertServerReviewSessionEvents(record, events);
  try {
    deriveServerReviewSessionApplyResult({
      record, events, requiredResolvedItems: "none",
      ...(binding === undefined ? {} : { binding }),
    });
  } catch (cause) {
    if (cause instanceof UnattestedReviewQueueError) throw brokenBinding(cause);
    throw cause;
  }
  return { snapshot, events, snapshotHash: input.snapshotHash };
}

function brokenBinding(cause: Error): Error {
  return Object.assign(
    new Error(
      "Stored review queue does not match the decisions recorded against it. The queue is bound to its round when the "
      + "round opens, so a queue that changed after a decision no longer describes what the reviewer decided; "
      + "re-run the source rather than editing stored review state.",
      { cause },
    ),
    { code: "REVIEW_BINDING_BROKEN" },
  );
}
