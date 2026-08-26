import { z } from "zod";

const apiVersion = "fieldwork.kontourai.io/v1";
const exactRef = z.string().regex(/^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/);
const identity = z.string().min(1).max(512);
const locator = z.string().min(1).max(8_192);
const closed = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export type ReviewedWebSourceResult =
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceDescriptor"; readonly status: "available"; readonly exactRef: string; readonly runResource: string; readonly captureRef: string; readonly preparedArtifact: { readonly ref: string; readonly digest: string; readonly contentLength: number }; readonly review: { readonly revision: number; readonly state: "reviewed" }; readonly evidence: { readonly id: string; readonly claimId: string; readonly proposalIndex: number; readonly import: { readonly name: string }; readonly candidate: { readonly id: string }; readonly reviewItem: { readonly name: string }; readonly reviewDecision: { readonly name: string }; readonly locator: { readonly scheme: string; readonly locator: string; readonly occurrence: { readonly index: number; readonly count: number; readonly start: number; readonly end: number } } }; readonly integrity: { readonly state: "unchecked" }; readonly inspection: { readonly pageChars: number; readonly maxPages: number } }
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceDescriptor"; readonly status: "restricted" | "missing" | "corrupt" | "unsupported" };
export type ReviewedWebSourceInspection =
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceInspection"; readonly status: "available"; readonly exactRef: string; readonly integrity: "verified"; readonly pages: readonly { readonly index: number; readonly start: number; readonly end: number; readonly text: string }[]; readonly totalPages: number; readonly nextCursor?: string; readonly truncated: boolean }
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceInspection"; readonly status: "restricted" | "missing" | "corrupt" | "digest-mismatch" | "storage-unavailable" | "unsupported" };
export type ReviewedWebSourceRefs =
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceRefs"; readonly status: "available"; readonly refs: readonly string[]; readonly truncated: boolean; readonly nextCursor?: string }
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceRefs"; readonly status: "restricted" | "corrupt" | "unsupported" };

const unavailableDescriptor = closed({ apiVersion: z.literal(apiVersion), kind: z.literal("ReviewedWebSourceDescriptor"), status: z.enum(["restricted", "missing", "corrupt", "unsupported"]) });
const availableDescriptor = closed({
  apiVersion: z.literal(apiVersion), kind: z.literal("ReviewedWebSourceDescriptor"), status: z.literal("available"), exactRef,
  runResource: identity, captureRef: identity,
  preparedArtifact: closed({ ref: identity, digest: z.string().regex(/^[a-f0-9]{64}$/), contentLength: z.number().int().nonnegative().max(16 * 1024 * 1024) }),
  review: closed({ revision: z.number().int().nonnegative(), state: z.literal("reviewed") }),
  evidence: closed({ id: identity, claimId: identity, proposalIndex: z.number().int().nonnegative(), import: closed({ name: identity }), candidate: closed({ id: identity }), reviewItem: closed({ name: identity }), reviewDecision: closed({ name: identity }), locator: closed({ scheme: identity, locator, occurrence: closed({ index: z.number().int().nonnegative(), count: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }) }) }),
  integrity: closed({ state: z.literal("unchecked") }), inspection: closed({ pageChars: z.number().int().positive().max(65_536), maxPages: z.number().int().positive().max(128) }),
}).superRefine((value, context) => {
  if (value.evidence.locator.occurrence.end < value.evidence.locator.occurrence.start) context.addIssue({ code: "custom", message: "Occurrence end precedes start" });
  if (value.evidence.locator.occurrence.index >= value.evidence.locator.occurrence.count) context.addIssue({ code: "custom", message: "Occurrence index is outside count" });
});

export const reviewedWebSourceDescriptorSchema: z.ZodType<ReviewedWebSourceResult> = z.union([availableDescriptor, unavailableDescriptor]);
export function parseReviewedWebSourceDescriptor(value: unknown): ReviewedWebSourceResult { return reviewedWebSourceDescriptorSchema.parse(value); }

export const reviewedWebSourceInspectionSchema: z.ZodType<ReviewedWebSourceInspection> = z.union([
  closed({ apiVersion: z.literal(apiVersion), kind: z.literal("ReviewedWebSourceInspection"), status: z.literal("available"), exactRef, integrity: z.literal("verified"), pages: z.array(closed({ index: z.number().int().nonnegative(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), text: z.string().max(65_536) })).max(128), totalPages: z.number().int().nonnegative(), nextCursor: z.string().regex(/^(?:0|[1-9][0-9]{0,5})$/).optional(), truncated: z.boolean() }),
  closed({ apiVersion: z.literal(apiVersion), kind: z.literal("ReviewedWebSourceInspection"), status: z.enum(["restricted", "missing", "corrupt", "digest-mismatch", "storage-unavailable", "unsupported"]) }),
]);
export function parseReviewedWebSourceInspection(value: unknown): ReviewedWebSourceInspection { return reviewedWebSourceInspectionSchema.parse(value); }

export const reviewedWebSourceRefsSchema: z.ZodType<ReviewedWebSourceRefs> = z.union([
  closed({ apiVersion: z.literal(apiVersion), kind: z.literal("ReviewedWebSourceRefs"), status: z.literal("available"), refs: z.array(exactRef).max(128), truncated: z.boolean(), nextCursor: z.string().regex(/^(?:0|[1-9][0-9]{0,5})$/).optional() }),
  closed({ apiVersion: z.literal(apiVersion), kind: z.literal("ReviewedWebSourceRefs"), status: z.enum(["restricted", "corrupt", "unsupported"]) }),
]);
export function parseReviewedWebSourceRefs(value: unknown): ReviewedWebSourceRefs { return reviewedWebSourceRefsSchema.parse(value); }
