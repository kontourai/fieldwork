import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createInMemoryPreparedArtifactStore, extract, resolvePreparedArtifact, serializePortableExtractionResult, type PortableExtractionResultEnvelope
} from "@kontourai/traverse";
import { importExtractionEnvelope, buildCanonicalReviewedTrustInput, buildSurveyTrustBundle, type ReviewItem } from "@kontourai/survey";
import { initialReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { createServerReviewSessionRecord, deriveServerReviewSessionApplyResult } from "@kontourai/survey/review-workbench/server-review-session";
import { validateTrustBundle } from "@kontourai/surface";
import { FIELDWORK_LIMITS, parseFieldworkTask, traverseTask, type FieldworkTask } from "./contracts.js";
import { parseReviewedExport, type FieldworkRunResult, type ReviewedExportV1, type RunOptions } from "./api-contracts.js";
import { createDeterministicProvider } from "./deterministic-provider.js";
import { assertPortableOutput, defaultRunRoot, readRun, writeRun, type StoredRun } from "./run-store.js";
import type { FieldworkStoredExecution } from "./runtime-contracts.js";
import { createFieldworkRuntimeSession } from "./runtime-session.js";

export async function runFieldwork(options: RunOptions): Promise<FieldworkRunResult> {
  const taskText = await boundedInput(options.taskPath, FIELDWORK_LIMITS.taskBytes, "task");
  const source = await boundedInput(options.sourcePath, FIELDWORK_LIMITS.sourceBytes, "source");
  const task = parseFieldworkTask(JSON.parse(taskText));
  const sourceDigest = createHash("sha256").update(source).digest("hex");
  const runtimeSession = options.runtime ? createFieldworkRuntimeSession(options.runtime) : undefined;
  if (runtimeSession) assertPortableOutput(runtimeSession.execution);
  const executionIdentity = runtimeSession?.execution.identity;
  const identityInput = `${sourceDigest}:${canonicalJson(task)}${executionIdentity ? `:${canonicalJson(executionIdentity)}` : ""}`;
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
  const taskSpec = traverseTask(task);
  const sourceRef = `fieldwork-source:v1:${task.metadata.name}:${sourceDigest}`;
  const store = createInMemoryPreparedArtifactStore();
  const result = await extract({
    content: source, contentType: options.sourcePath.endsWith(".html") ? "html" : "text", sourceRef,
    targetSchema: taskSpec.targetSchema, taskSpec, provider: runtimeSession?.provider ?? createDeterministicProvider(task),
    preparedArtifact: { store, sourceSnapshotRef: sourceRef }
  });
  if (result.error || !result.preparedArtifact) throw new Error(result.error ?? "Traverse did not produce a prepared artifact");
  const resolution = await resolvePreparedArtifact(result.preparedArtifact, store);
  if (resolution.status !== "available") throw new Error(`Prepared artifact is ${resolution.status}`);
  const envelope = JSON.parse(serializePortableExtractionResult(result, { preparedArtifactResolution: resolution })) as PortableExtractionResultEnvelope;
  assertPortableOutput(envelope);
  const imported = importExtractionEnvelope(envelope, {
    importName: `fieldwork-import:${task.metadata.name}:${runIdentity}`,
    producerNamespace: "fieldwork", sourceKind: "uploaded-document",
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
    envelopeFile: "extraction-envelope.json", review: { snapshot: initialReviewQueueSessionState(canonicalReviewItems(imported.reviewItems, envelope)), events: [], revision: 0 }
  };
  const persistedDirectory = await writeRun(root, run, envelope, resolution.text);
  return {
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkRunResult",
    runDirectory: persistedDirectory, runResource, proposalCount: result.proposals.length
  };
}

function fixtureExecution(): FieldworkStoredExecution {
  return { identity: { mode: "fixture-v1" }, receipts: [] };
}

export async function reviewedExport(runDirectory: string): Promise<ReviewedExportV1> {
  const stored = await readRun(runDirectory);
  assertPortableOutput(stored.envelope);
  const imported = importExtractionEnvelope(stored.envelope, {
    importName: importNameFor(stored.run), producerNamespace: "fieldwork", sourceKind: "uploaded-document",
    claimTarget: (proposal) => {
      const projection = stored.run.task.spec.projections.find((candidate) => candidate.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error(`No claim target for ${proposal.fieldPath}`);
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }
  });
  if (imported.record.status.state !== "grounded") throw new Error("Export refused: extraction is not grounded");
  const record = createServerReviewSessionRecord({ sessionName: reviewSessionName(stored.run), snapshot: stored.run.review.snapshot, eventCount: stored.run.review.events.length });
  const applied = deriveServerReviewSessionApplyResult({ record, events: stored.run.review.events, requiredResolvedItems: "all" });
  if (!applied.ok) throw new Error(`Export refused: ${applied.issues.map((issue) => issue.code).join(", ")}`);
  const canonical = buildCanonicalReviewedTrustInput({
    source: stored.run.runResource, generatedAt: new Date().toISOString(), projectionContextId: stored.run.runResource,
    items: canonicalReviewItems(imported.reviewItems, stored.envelope), results: applied.results
  });
  const bundle = validateTrustBundle(buildSurveyTrustBundle(canonical.surveyInput, { projectionContextId: canonical.projectionContextId }));
  assertPortableOutput(bundle);
  return parseReviewedExport(bundle);
}

export function reviewSessionName(_run: StoredRun): string { return "review-workbench-session"; }
export function importNameFor(run: StoredRun): string { return `fieldwork-import:${run.taskName}:${run.runResource.split(":").at(-1)}`; }

/** Temporary Survey #187 compatibility adapter; remove once the envelope importer supplies extraction.extractedAt. */
export function canonicalReviewItems(items: readonly ReviewItem[], envelope: PortableExtractionResultEnvelope): ReviewItem[] {
  return items.map((item) => ({ ...item, spec: { ...item.spec, candidates: item.spec.candidates.map((candidate) => ({ ...candidate, extraction: { ...candidate.extraction, extractedAt: envelope.result.extractedAt } })) } }));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
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
