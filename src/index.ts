import type { z } from "zod";
import {
  FIELDWORK_LIMITS as internalLimits,
  fieldworkTaskSchema as internalTaskSchema,
  parseFieldworkTask as internalParseTask
} from "./contracts.js";
import { runFieldwork as internalRun, reviewedExport as internalExport } from "./fieldwork.js";
import { openRun as internalOpen } from "./server.js";
import {
  fieldworkRunViewSchema as internalRunViewSchema,
  preparedArtifactViewSchema as internalPreparedViewSchema,
  reviewedExportSchema as internalReviewedExportSchema,
  reviewMutationResponseSchema as internalMutationSchema,
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

export const FIELDWORK_LIMITS = internalLimits;
export const fieldworkTaskSchema: z.ZodType<FieldworkTask> = internalTaskSchema;
export const fieldworkRunViewSchema: z.ZodType<FieldworkRunViewV1> = internalRunViewSchema;
export const reviewMutationResponseSchema: z.ZodType<ReviewMutationResponseV1> = internalMutationSchema;
export const preparedArtifactViewSchema: z.ZodType<PreparedArtifactViewV1> = internalPreparedViewSchema;
export const reviewedExportSchema: z.ZodType<ReviewedExportV1> = internalReviewedExportSchema;
export { fieldworkHostDescriptor };

export function parseFieldworkTask(value: unknown): FieldworkTask {
  return internalParseTask(value);
}
export function runFieldwork(options: RunOptions): Promise<FieldworkRunResult> {
  return internalRun(options);
}
export function reviewedExport(runDirectory: string): Promise<ReviewedExportV1> {
  return internalExport(runDirectory);
}
export function openRun(runDirectory: string, port?: number): Promise<OpenRunService> {
  return internalOpen(runDirectory, port);
}
export type {
  FieldworkFailure, FieldworkRunResult, FieldworkRunViewV1, FieldworkTask,
  JsonObject, JsonPrimitive, JsonValue, OpenRunService, PreparedArtifactViewV1,
  ReviewedExportV1, ReviewMutationResponseV1, ReviewMutationSuccessV1, RunOptions
} from "./api-contracts.js";
