import { z } from "zod";
import type { ReviewItem, ReviewSessionEvent } from "@kontourai/survey";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import {
  assertServerReviewSessionEvents,
  createServerReviewSessionRecord,
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

/** Temporary transport validator pending Survey issue #188. Survey remains semantic authority. */
export function parsePersistedReview(input: {
  snapshot: unknown;
  events: unknown;
}): { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[] } {
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
  const record = createServerReviewSessionRecord({ sessionName: "review-workbench-session", snapshot, eventCount: events.length });
  assertServerReviewSessionEvents(record, events);
  deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "none" });
  return { snapshot, events };
}
