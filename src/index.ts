import type { z } from "zod";
import {
  FIELDWORK_LIMITS as internalLimits,
  fieldworkTaskSchema as internalTaskSchema,
  parseFieldworkTask as internalParseTask
} from "./contracts.js";
import {
  runFieldwork as internalRun,
  runFieldworkBatch as internalRunBatch,
  reviewedExport as internalExport,
} from "./fieldwork.js";
import { acquireFieldwork as internalAcquire } from "./acquisition.js";
import { openRun as internalOpen } from "./server.js";
import {
  fieldworkRunViewSchema as internalRunViewSchema,
  fieldworkRunResultSchema as internalRunResultSchema,
  fieldworkAcquisitionResultSchema as internalAcquisitionResultSchema,
  fieldworkBatchRunResultSchema as internalBatchRunResultSchema,
  preparedArtifactViewSchema as internalPreparedViewSchema,
  reviewedExportSchema as internalReviewedExportSchema,
  reviewMutationResponseSchema as internalMutationSchema,
  type FieldworkAcquisitionOptions,
  type FieldworkAcquisitionResult,
  type FieldworkBatchOptions,
  type FieldworkBatchRunResult,
  type FieldworkRunResult,
  type FieldworkRunViewV1,
  type FieldworkTask,
  type OpenRunService,
  type PreparedArtifactViewV1,
  type ReviewedExportV1,
  type ReviewMutationResponseV1,
  type RunOptions
} from "./api-contracts.js";
import { fieldworkHostDescriptor } from "./host-descriptor.js";
import { recheckFieldwork as internalRecheck } from "./recheck.js";

export const FIELDWORK_LIMITS = internalLimits;
export const fieldworkTaskSchema: z.ZodType<FieldworkTask> = internalTaskSchema;
export const fieldworkRunViewSchema: z.ZodType<FieldworkRunViewV1> = internalRunViewSchema;
export const fieldworkRunResultSchema: z.ZodType<FieldworkRunResult> = internalRunResultSchema;
export const fieldworkAcquisitionResultSchema: z.ZodType<FieldworkAcquisitionResult> = internalAcquisitionResultSchema;
export const fieldworkBatchRunResultSchema: z.ZodType<FieldworkBatchRunResult> = internalBatchRunResultSchema;
export const reviewMutationResponseSchema: z.ZodType<ReviewMutationResponseV1> = internalMutationSchema;
export const preparedArtifactViewSchema: z.ZodType<PreparedArtifactViewV1> = internalPreparedViewSchema;
export const reviewedExportSchema: z.ZodType<ReviewedExportV1> = internalReviewedExportSchema;
export { fieldworkHostDescriptor };
export {
  createDatumRuntimeBinding,
  createProfileRuntimeBinding,
  fieldworkStoredExecutionSchema
} from "./runtime-contracts.js";

export function parseFieldworkTask(value: unknown): FieldworkTask {
  return internalParseTask(value);
}
export function runFieldwork(options: RunOptions): Promise<FieldworkRunResult> {
  return internalRun(options);
}
export function runFieldworkBatch(options: FieldworkBatchOptions): Promise<FieldworkBatchRunResult> {
  return internalRunBatch(options);
}
export function acquireFieldwork(options: FieldworkAcquisitionOptions): Promise<FieldworkAcquisitionResult> {
  return internalAcquire(options);
}
export function reviewedExport(runDirectory: string): Promise<ReviewedExportV1> {
  return internalExport(runDirectory);
}
export function openRun(runDirectory: string, port?: number): Promise<OpenRunService> {
  return internalOpen(runDirectory, port);
}
export function recheckFieldwork(
  options: import("./recheck.js").FieldworkRecheckOptions
): Promise<import("./recheck.js").FieldworkRecheckResult> {
  return internalRecheck(options);
}
export type {
  FieldworkAcquisitionOptions, FieldworkAcquisitionResult, FieldworkBatchOptions,
  FieldworkBatchRunResult, FieldworkBatchSource, FieldworkFailure, FieldworkRunResult,
  FieldworkImageExtractedText, FieldworkPdfBoundingBox, FieldworkPdfExtractedText,
  FieldworkPdfLayout, FieldworkPdfPageGeometry, FieldworkPdfTable,
  FieldworkPdfTableCell, FieldworkPdfTextElement, FieldworkPdfTextRange,
  FieldworkRunViewV1, FieldworkSourceAdapters, FieldworkTask,
  JsonObject, JsonPrimitive, JsonValue, OpenRunService, PreparedArtifactViewV1,
  ReviewedExportV1, ReviewMutationResponseV1, ReviewMutationSuccessV1, RunOptions
} from "./api-contracts.js";
export type {
  DatumRuntimeBindingOptions, FieldworkExecutionIdentity, FieldworkRuntimeBinding,
  FieldworkRuntimeBudget, FieldworkRuntimeCandidate,
  FieldworkStoredExecution, ProfileRuntimeBindingOptions
} from "./runtime-contracts.js";
export type {
  FieldworkEvidenceObservation,
  FieldworkCheckResult,
  FieldworkLookoutSource,
  FieldworkRecheckAcquisition,
  FieldworkRecheckClassification,
  FieldworkRecheckOptions,
  FieldworkRecheckResult,
} from "./recheck.js";
