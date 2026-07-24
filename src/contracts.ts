import { z } from "zod";
import { createExtractionTaskSpec, validateExtractionTaskSpec, type ExtractionTaskSpec } from "@kontourai/traverse";

export const FIELDWORK_LIMITS = {
  taskBytes: 256 * 1024,
  sourceBytes: 2 * 1024 * 1024,
  requestBodyBytes: 16 * 1024 * 1024,
  artifactBytes: 32 * 1024 * 1024,
  projections: 128,
  reviewItems: 10_000,
  events: 10_000,
  string: 4_096,
  pattern: 512
} as const;

const bounded = z.string().min(1).max(FIELDWORK_LIMITS.string);

export const fieldworkTaskSchema = z.object({
  apiVersion: z.literal("fieldwork.kontourai.io/v1alpha1"),
  kind: z.literal("FieldworkTask"),
  metadata: z.object({ name: z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*$/) }).strict(),
  spec: z.object({
    traverse: z.object({ version: bounded, targetSchema: z.array(z.object({
      path: bounded, type: z.enum(["string", "number", "boolean", "date", "enum", "array", "object"]),
      enumValues: z.array(bounded).max(256).optional(), description: bounded.optional(), required: z.boolean().optional(),
      inferenceType: z.enum(["explicit", "inferred"]).optional()
    }).strict()).min(1).max(FIELDWORK_LIMITS.projections), guidance: bounded.optional() }).strict(),
    projections: z.array(z.object({
      fieldPath: bounded, pattern: z.string().min(1).max(FIELDWORK_LIMITS.pattern), claim: z.object({
        subjectType: bounded, subjectId: bounded, facet: bounded,
        claimType: bounded, impactLevel: z.enum(["low", "medium", "high", "critical"])
      }).strict()
    }).strict()).min(1).max(FIELDWORK_LIMITS.projections)
  }).strict()
}).strict();

export type FieldworkTask = z.infer<typeof fieldworkTaskSchema>;

export function parseFieldworkTask(value: unknown): FieldworkTask {
  const task = fieldworkTaskSchema.parse(value);
  const extractionTask = createExtractionTaskSpec(task.spec.traverse);
  const issue = validateExtractionTaskSpec(extractionTask, extractionTask.targetSchema);
  if (issue) throw new Error(`Invalid Traverse task: ${issue}`);
  const projectionFieldPaths = new Set<string>();
  for (const projection of task.spec.projections) {
    if (projectionFieldPaths.has(projection.fieldPath)) {
      throw new Error(`Projection ${projection.fieldPath} is declared more than once`);
    }
    projectionFieldPaths.add(projection.fieldPath);
    if (!extractionTask.targetSchema.some((field) => field.path === projection.fieldPath)) {
      throw new Error(`Projection ${projection.fieldPath} is not declared by the Traverse task`);
    }
    deterministicPattern(projection.pattern, projection.fieldPath);
  }
  return task;
}

export function deterministicPattern(pattern: string, fieldPath = "projection"): RegExp {
  // Deterministic Fieldwork fixtures support literal labels followed by exactly
  // one line-bounded capture. This excludes nested/repeated groups, lookarounds,
  // backreferences, dot-stars, and other catastrophic-backtracking surfaces.
  const match = /^([A-Za-z0-9 _./-]+): \(\[\^\\n\]\+\)$/.exec(pattern);
  if (!match) {
    throw new Error(`Projection ${fieldPath} uses an unsupported deterministic pattern`);
  }
  const literalLabel = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${literalLabel}: ([^\\n]+)`, "m");
}

export function traverseTask(task: FieldworkTask): ExtractionTaskSpec {
  return createExtractionTaskSpec(task.spec.traverse);
}

export interface FieldworkFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export function failure(code: string, message: string): FieldworkFailure {
  return { ok: false, error: { code, message } };
}
