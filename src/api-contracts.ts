import { z } from "zod";
import type { FieldworkRuntimeBinding } from "./runtime-contracts.js";

const TRANSPORT_LIMITS = { sourceBytes: 2 * 1024 * 1024, projections: 128, events: 10_000 } as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export interface FieldworkPdfTextRange {
  readonly start: number;
  readonly end: number;
}
export interface FieldworkPdfBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface FieldworkPdfPageGeometry {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly unit: "points" | "pixels" | "normalized";
  readonly rotation?: 0 | 90 | 180 | 270;
}
export interface FieldworkPdfTextElement {
  readonly kind: "heading" | "paragraph" | "list" | "table" | "table-cell" | "figure" | "other";
  readonly providerType?: string;
  readonly pageNumber: number;
  readonly range: FieldworkPdfTextRange;
  readonly bounds?: FieldworkPdfBoundingBox;
}
export interface FieldworkPdfTableCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowSpan?: number;
  readonly columnSpan?: number;
  readonly range: FieldworkPdfTextRange;
  readonly bounds?: FieldworkPdfBoundingBox;
}
export interface FieldworkPdfTable {
  readonly pageNumber: number;
  readonly bounds?: FieldworkPdfBoundingBox;
  readonly cells: FieldworkPdfTableCell[];
}
export interface FieldworkPdfLayout {
  readonly pages?: FieldworkPdfPageGeometry[];
  readonly elements: FieldworkPdfTextElement[];
  readonly tables?: FieldworkPdfTable[];
}
export interface FieldworkPdfExtractedText {
  readonly text: string;
  readonly pageOffsets?: number[];
  readonly layout?: FieldworkPdfLayout;
  readonly warnings?: string[];
}
export interface FieldworkImageExtractedText {
  readonly text: string;
  readonly warnings?: string[];
}
export interface FieldworkSourceAdapters {
  readonly pdf?: {
    readonly id: string;
    readonly extract: {
      extract(bytes: Uint8Array): FieldworkPdfExtractedText | Promise<FieldworkPdfExtractedText>;
    };
  };
  readonly image?: {
    readonly id: string;
    readonly extract: {
      extract(bytes: Uint8Array): Promise<FieldworkImageExtractedText>;
    };
  };
}

export interface RunOptions {
  readonly taskPath: string;
  readonly sourcePath?: string;
  readonly snapshotRef?: string;
  readonly snapshotRoot?: string;
  readonly sourceAdapters?: FieldworkSourceAdapters;
  readonly root?: string;
  readonly runtime?: FieldworkRuntimeBinding;
  readonly signal?: AbortSignal;
}
export interface FieldworkRunResult {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "FieldworkRunResult";
  readonly runDirectory: string;
  readonly runResource: string;
  readonly proposalCount: number;
}
export interface FieldworkAcquisitionOptions {
  readonly url: string;
  readonly snapshotRoot?: string;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly discovery?: "links" | "sitemap" | "both";
  readonly render?: "never" | "on-shell" | "always";
}
export interface FieldworkAcquisitionResult {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "FieldworkAcquisitionResult";
  readonly pages: readonly {
    readonly sourceRef: string;
    readonly status: number;
    readonly depth: number;
    readonly rendered: boolean;
    readonly warningCount: number;
  }[];
  readonly truncated: boolean;
  readonly warningCount: number;
}
export interface FieldworkBatchSource {
  readonly id: string;
  readonly sourcePath?: string;
  readonly snapshotRef?: string;
  readonly snapshotRoot?: string;
}
export interface FieldworkBatchOptions {
  readonly taskPath: string;
  readonly sources: readonly FieldworkBatchSource[];
  readonly root?: string;
  readonly runtime?: FieldworkRuntimeBinding;
  readonly sourceAdapters?: FieldworkSourceAdapters;
  readonly signal?: AbortSignal;
}
export interface FieldworkBatchRunResult {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "FieldworkBatchRunResult";
  readonly items: readonly ({
    readonly id: string;
    readonly ok: true;
    readonly run: FieldworkRunResult;
  } | {
    readonly id: string;
    readonly ok: false;
    readonly error: { readonly code: string; readonly message: string };
  })[];
  readonly succeeded: number;
  readonly failed: number;
}
export interface FieldworkFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}
export interface OpenRunService {
  readonly url: string;
  readonly baseUrl: string;
  readonly capabilityToken: string;
  close(): Promise<void>;
}
export interface FieldworkRunViewV1 {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "FieldworkRunView";
  readonly ok: true;
  readonly run: { readonly resource: string; readonly revision: number };
  /** Survey-owned inspector payload, transported as validated JSON. */
  readonly inspector: JsonObject;
  readonly review: {
    /** Survey-owned snapshot, transported as validated JSON and validated semantically before serving. */
    readonly snapshot: JsonObject;
    readonly items: readonly JsonObject[];
    readonly events: readonly JsonObject[];
    readonly apply: JsonObject;
  };
}
export interface ReviewMutationSuccessV1 {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "ReviewMutationResult";
  readonly ok: true;
  readonly events: readonly JsonObject[];
  readonly eventCount: number;
  readonly revision: number;
  readonly apply: JsonObject;
}
export type ReviewMutationResponseV1 = ReviewMutationSuccessV1 | (FieldworkFailure & { readonly eventCount?: number });
export interface PreparedArtifactViewV1 {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "PreparedArtifactView";
  readonly ok: true;
  readonly text: string;
  readonly artifact: {
    readonly ref: string;
    readonly digest: string;
    readonly contentLength: number;
    readonly file: "prepared.txt";
  };
}
export type ReviewedExportV1 = JsonObject;

export interface FieldworkTask {
  readonly apiVersion: "fieldwork.kontourai.io/v1alpha1";
  readonly kind: "FieldworkTask";
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly traverse: {
      readonly version: string;
      readonly targetSchema: readonly {
        readonly path: string;
        readonly type: "string" | "number" | "boolean" | "date" | "enum" | "array" | "object";
        readonly enumValues?: readonly string[];
        readonly description?: string;
        readonly required?: boolean;
        readonly inferenceType?: "explicit" | "inferred";
      }[];
      readonly guidance?: string;
    };
    readonly projections: readonly {
      readonly fieldPath: string;
      readonly pattern: string;
      readonly claim: {
        readonly subjectType: string;
        readonly subjectId: string;
        readonly facet: string;
        readonly claimType: string;
        readonly impactLevel: "low" | "medium" | "high" | "critical";
      };
    }[];
  };
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema)
]));
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(jsonValueSchema);
const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }).strict()
}).strict();
export const fieldworkRunResultSchema: z.ZodType<FieldworkRunResult> = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1"),
  kind: z.literal("FieldworkRunResult"),
  runDirectory: z.string(),
  runResource: z.string(),
  proposalCount: z.number().int().nonnegative(),
}).strict();
export const fieldworkAcquisitionResultSchema: z.ZodType<FieldworkAcquisitionResult> = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1"),
  kind: z.literal("FieldworkAcquisitionResult"),
  pages: z.array(z.object({
    sourceRef: z.string(),
    status: z.number().int().min(100).max(599),
    depth: z.number().int().nonnegative(),
    rendered: z.boolean(),
    warningCount: z.number().int().nonnegative(),
  }).strict()).max(500),
  truncated: z.boolean(),
  warningCount: z.number().int().nonnegative(),
}).strict();
export const fieldworkBatchRunResultSchema: z.ZodType<FieldworkBatchRunResult> = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1"),
  kind: z.literal("FieldworkBatchRunResult"),
  items: z.array(z.discriminatedUnion("ok", [
    z.object({ id: z.string(), ok: z.literal(true), run: fieldworkRunResultSchema }).strict(),
    z.object({ id: z.string(), ok: z.literal(false), error: z.object({
      code: z.string(),
      message: z.string(),
    }).strict() }).strict(),
  ])).min(1).max(128),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.succeeded + value.failed !== value.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "batch counts do not match item count" });
  }
});

export const fieldworkRunViewSchema: z.ZodType<FieldworkRunViewV1> = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1"),
  kind: z.literal("FieldworkRunView"),
  ok: z.literal(true),
  run: z.object({ resource: z.string(), revision: z.number().int().nonnegative() }).strict(),
  inspector: jsonObjectSchema,
  review: z.object({
    snapshot: jsonObjectSchema,
    items: z.array(jsonObjectSchema).max(TRANSPORT_LIMITS.projections),
    events: z.array(jsonObjectSchema).max(TRANSPORT_LIMITS.events),
    apply: jsonObjectSchema
  }).strict()
}).strict();
const reviewMutationSuccessSchema: z.ZodType<ReviewMutationSuccessV1> = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1"),
  kind: z.literal("ReviewMutationResult"),
  ok: z.literal(true),
  events: z.array(jsonObjectSchema).max(TRANSPORT_LIMITS.events),
  eventCount: z.number().int().nonnegative().max(TRANSPORT_LIMITS.events),
  revision: z.number().int().nonnegative(),
  apply: jsonObjectSchema
}).strict();
export const reviewMutationResponseSchema: z.ZodType<ReviewMutationResponseV1> = z.union([
  reviewMutationSuccessSchema,
  failureSchema.extend({ eventCount: z.number().int().nonnegative().optional() }).strict()
]);
export const preparedArtifactViewSchema: z.ZodType<PreparedArtifactViewV1> = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1"),
  kind: z.literal("PreparedArtifactView"),
  ok: z.literal(true),
  text: z.string().max(TRANSPORT_LIMITS.sourceBytes),
  artifact: z.object({
    ref: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    contentLength: z.number().int().nonnegative().max(TRANSPORT_LIMITS.sourceBytes),
    file: z.literal("prepared.txt")
  }).strict()
}).strict();
export const reviewedExportSchema: z.ZodType<ReviewedExportV1> = jsonObjectSchema;

export function parseReviewMutationSuccess(value: unknown): ReviewMutationSuccessV1 {
  return reviewMutationSuccessSchema.parse(toWireJson(value));
}
export function parseFieldworkRunView(value: unknown): FieldworkRunViewV1 {
  return fieldworkRunViewSchema.parse(toWireJson(value));
}
export function parsePreparedArtifactView(value: unknown): PreparedArtifactViewV1 {
  return preparedArtifactViewSchema.parse(toWireJson(value));
}
export function parseReviewedExport(value: unknown): ReviewedExportV1 {
  return reviewedExportSchema.parse(toWireJson(value));
}

function toWireJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
