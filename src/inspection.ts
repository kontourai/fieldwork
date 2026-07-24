import {
  buildExtractionInspectorModel,
  exportExtractionInspector,
  importExtractionEnvelope,
} from "@kontourai/survey";
import { importNameFor } from "./fieldwork.js";
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
  const imported = importExtractionEnvelope(stored.envelope, {
    importName: importNameFor(stored.run),
    producerNamespace: "fieldwork",
    sourceKind: "uploaded-document",
    claimTarget: (proposal) => {
      const projection = stored.run.task.spec.projections.find(
        (entry) => entry.fieldPath === proposal.fieldPath,
      );
      if (!projection) throw new Error("Unknown projection");
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    },
  });
  const model = buildExtractionInspectorModel({
    importResult: imported,
    artifact: {
      status: "available",
      text: stored.preparedText,
      actualDigest: stored.run.preparedArtifact.digest,
    },
  });
  const artifact = exportExtractionInspector(
    model,
    options,
  );
  assertPortableOutput(JSON.parse(artifact));
  return artifact;
}
