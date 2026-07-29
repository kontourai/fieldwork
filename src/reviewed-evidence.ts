import {
  evaluateReviewedGroundingPolicy,
  projectReviewedExtractionEvidence,
  type Evidence,
  type ReviewedExtractionEvidenceInput,
  type ReviewedGroundingPolicy,
  type ReviewedGroundingPolicyDecision,
} from "@kontourai/surface";
import {
  toSurfaceReviewedExtractionDecision,
  toSurfaceReviewedExtractionImport,
  toSurfaceReviewedExtractionItem,
  type ExtractionEnvelopeImportResult,
  type ReviewItem,
} from "@kontourai/survey";
import type { ReviewWorkbenchResult } from "@kontourai/survey/review-workbench";

/**
 * Stable identity fieldwork asserts as the collector of the reviewed-extraction
 * evidence it projects at export time (surface#reviewed-extraction-evidence
 * `collectedBy`: "the system that ingested/projected the record"). The reviewer
 * who actually made the decision remains recorded on the carried
 * `reviewDecision`, never overwritten by this identity.
 */
export const REVIEWED_EVIDENCE_COLLECTED_BY = "fieldwork.kontourai.io/reviewed-export";
export const REVIEWED_GROUNDING_POLICY_ID = "fieldwork.kontourai.io/reviewed-export-grounding/v1";
export const REVIEWED_GROUNDING_ACTION = "fieldwork.kontourai.io/reviewed-export";

export type FieldworkReviewedGroundingReceipt =
  | (Omit<ReviewedGroundingPolicyDecision, "outcome"> & {
      readonly apiVersion: "fieldwork.kontourai.io/v1";
      readonly kind: "ReviewedGroundingEvaluation";
      readonly outcome: "allowed" | "refused";
    })
  | {
      readonly apiVersion: "fieldwork.kontourai.io/v1";
      readonly kind: "ReviewedGroundingEvaluation";
      readonly outcome: "not-evaluated";
      readonly reason: "unsupported-review-shape";
      readonly message: string;
    };

export interface ReviewedEvidenceEnrichment {
  readonly additionalEvidence: readonly Evidence[];
  readonly grounding: FieldworkReviewedGroundingReceipt;
}

export interface BuildReviewedEvidenceEnrichmentOptions {
  /** Freshly rebuilt from the run's own extraction envelope, at export time. */
  readonly imported: ExtractionEnvelopeImportResult;
  /** The decided round's persisted queue (see `reviewedExport`'s own docstring). */
  readonly items: readonly ReviewItem[];
  readonly results: readonly ReviewWorkbenchResult[];
  /** True for a recheck round's Lookout semantic-transition items. */
  readonly isRecheckItem: (item: ReviewItem) => boolean;
  /** The already-computed canonical claim id a candidate's decision resolved onto. */
  readonly claimIdForCandidate: (candidateId: string) => string | undefined;
}

/**
 * Project surface's reviewed-extraction-evidence profile over a decided,
 * attested review round and evaluate surface's reviewed-grounding policy over
 * the projection (kontourai/fieldwork#88).
 *
 * A recheck round's items review a *pair* of candidates (prior vs proposed,
 * `canonicalSemanticReviewItems`) rather than surface's assumed shape — exactly
 * one non-editable candidate per item. That shape genuinely does not fit
 * `projectReviewedExtractionEvidence`'s contract (it throws on more than one
 * candidate), so a recheck round's grounding is reported `"not-evaluated"`
 * rather than fabricated as a pass or silently dropped. A round is either
 * entirely recheck items or entirely first-round extraction items — never
 * mixed (`assertReviewedQueueIsAttested` refuses a mixed queue upstream) — so
 * this is a whole-round decision, not a per-item one.
 */
export function buildReviewedEvidenceEnrichment(options: BuildReviewedEvidenceEnrichmentOptions): ReviewedEvidenceEnrichment {
  const { imported, items, results, isRecheckItem, claimIdForCandidate } = options;
  if (items.some(isRecheckItem)) {
    return {
      additionalEvidence: [],
      grounding: {
        apiVersion: "fieldwork.kontourai.io/v1",
        kind: "ReviewedGroundingEvaluation",
        outcome: "not-evaluated",
        reason: "unsupported-review-shape",
        message: "This round's review items are a Lookout semantic-transition pair per item (prior vs proposed "
          + "candidate), and surface's reviewed-extraction-evidence profile requires exactly one non-editable "
          + "candidate per review item. A recheck round's grounding cannot be projected under the current contract; "
          + "see kontourai/fieldwork#88.",
      },
    };
  }

  const proposalIndexByReviewItemName = new Map(
    imported.reviewItems.map((reviewItem, index) => [reviewItem.metadata.name, index] as const),
  );
  const resultsByItemName = new Map(results.map((result) => [result.reviewItemName, result] as const));

  const additionalEvidence: Evidence[] = [];
  for (const item of items) {
    const result = resultsByItemName.get(item.metadata.name);
    if (!result) throw new Error(`Reviewed grounding projection has no decided result for ${item.metadata.name}`);
    const proposalIndex = proposalIndexByReviewItemName.get(item.metadata.name);
    if (proposalIndex === undefined) {
      throw new Error(`Reviewed grounding projection cannot locate the extraction proposal for ${item.metadata.name}`);
    }
    if (item.spec.candidates.length !== 1) {
      throw new Error(`Reviewed grounding projection expects exactly one candidate on ${item.metadata.name}`);
    }
    const candidate = item.spec.candidates[0]!;
    const claimId = claimIdForCandidate(candidate.id);
    if (!claimId) throw new Error(`Reviewed grounding projection cannot resolve the claim decided by ${item.metadata.name}`);

    // Survey owns the shapes surface's contract redeclares, and since 2.5.0 it
    // exports these adapters with a compile-time field-assignability guard —
    // drift between the two declarations now fails survey's own build
    // (surface#194) instead of surfacing here as a runtime validation error.
    const input: ReviewedExtractionEvidenceInput = {
      evidenceId: `${item.metadata.name}.reviewed-extraction-evidence`,
      claimId,
      proposalIndex,
      importRecord: toSurfaceReviewedExtractionImport(imported.record),
      reviewItem: toSurfaceReviewedExtractionItem(item),
      reviewDecision: toSurfaceReviewedExtractionDecision(result.reviewDecision),
      collectedBy: REVIEWED_EVIDENCE_COLLECTED_BY,
      // By the time a review round reaches export, `assertReviewedQueueIsAttested`
      // has already cross-checked the decided queue against the extraction
      // envelope Survey imported it from; there is no further structural
      // validation fieldwork withholds.
      structuralTrust: "validated",
    };
    additionalEvidence.push(projectReviewedExtractionEvidence(input).evidence);
  }

  // requireCurrentSource is deliberately unset and no sourceStates are
  // supplied: this receipt attests the reviewed extraction against the run's
  // own attested artifacts, and fieldwork holds no independent observation of
  // the live source at export time (that is Lookout's recheck job). Surface
  // defaults unchecked source states to "unknown", so "allowed" here means
  // locator/artifact/review/structure requirements passed — it says nothing
  // about whether the source has drifted since extraction.
  const policy: ReviewedGroundingPolicy = {
    id: REVIEWED_GROUNDING_POLICY_ID,
    action: REVIEWED_GROUNDING_ACTION,
    requiredClaimIds: [...new Set(additionalEvidence.map((evidence) => evidence.claimId))],
    requireExactLocator: true,
    requirePreparedArtifact: true,
    requireAcceptedReview: true,
    requireValidatedStructure: true,
  };
  const decision = evaluateReviewedGroundingPolicy({ policy, evidence: additionalEvidence });

  return {
    additionalEvidence,
    grounding: {
      ...decision,
      apiVersion: "fieldwork.kontourai.io/v1",
      kind: "ReviewedGroundingEvaluation",
      outcome: decision.outcome,
    },
  };
}
