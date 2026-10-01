import {
  buildExtractionInspectorModel,
  exportExtractionInspector,
} from "@kontourai/survey";
import { canonicalJson } from "./contracts.js";
import { extractionCoverageSummary, reviewBlockedFor, storedExtractionImport } from "./fieldwork.js";
import { assertPortableOutput, readRun } from "./run-store.js";

export interface FieldworkInspectionExportOptions {
  readonly includePreparedText?: boolean;
  readonly includeExcerpts?: boolean;
}

/**
 * Creates a canonical, read-only inspection artifact for a stored run.
 *
 * Survey remains the inspector/export contract owner. Fieldwork only resolves
 * and rebinds its local prepared artifact before applying the portable
 * disclosure guard.
 */
export async function inspectionExport(
  runDirectory: string,
  options: FieldworkInspectionExportOptions = {},
): Promise<string> {
  const stored = await readRun(runDirectory);
  const imported = storedExtractionImport(stored);
  const model = buildExtractionInspectorModel({
    importResult: imported,
    artifact: {
      status: "available",
      text: stored.preparedText,
      actualDigest: stored.run.preparedArtifact.digest,
    },
  });
  const coverageSummary = extractionCoverageSummary(stored.envelope);
  const artifact = JSON.parse(exportExtractionInspector(model, options)) as { spec: Record<string, unknown> };
  // Survey's inspector export is per-candidate/per-source; the run-level
  // truncation outcome and its warning classifications are Traverse's, and
  // Survey has no field for them (fieldwork#50) — merge them in here rather
  // than let `fieldwork inspect` stay silent about a silently-truncated run.
  const withExtractionOutcome = {
    ...artifact,
    spec: {
      ...artifact.spec,
      extraction: {
        outcome: stored.envelope.result.outcome,
        warningClassifications: stored.envelope.result.warningClassifications ?? [],
        // Which prepared-text ranges were read, and why any were not. Traverse
        // emits it only on a partial outcome; it holds offsets, never text.
        ...(stored.envelope.result.coverage === undefined ? {} : { coverage: stored.envelope.result.coverage }),
        // Coverage lists only chunks whose text is in the prepared artifact.
        // Chunks a chunk cap dropped are not among them, so carry Traverse's
        // own progress record and the count that includes them.
        ...(stored.envelope.result.partial === undefined ? {} : { partial: stored.envelope.result.partial }),
        ...(coverageSummary === undefined ? {} : { coverageSummary }),
      },
      // The extraction still inspects, but its review can never be exported.
      ...reviewBlockedFor(stored.run),
    },
  };
  assertPortableOutput(withExtractionOutcome);
  return canonicalJson(withExtractionOutcome);
}
