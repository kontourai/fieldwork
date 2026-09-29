import {
  evaluateReviewedGroundingPolicy,
  projectReviewedExtractionEvidence,
  resolverFromBundle,
  reviewedExtractionEvidenceChoiceProfile,
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
const SURVEY_EXTRACTION_ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";

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
  /**
   * The claims this export states, from the canonical review projection. They
   * set which claims the grounding policy requires and bind each claim's value
   * to its reviewed candidate.
   */
  readonly claims: readonly { readonly id: string; readonly value: unknown }[];
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
  const { imported, items, results, isRecheckItem, claimIdForCandidate, claims } = options;
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

  const importedItemNames = new Set(imported.reviewItems.map((reviewItem) => reviewItem.metadata.name));
  const resultsByItemName = new Map(results.map((result) => [result.reviewItemName, result] as const));

  const additionalEvidence: Evidence[] = [];
  for (const item of items) {
    const result = resultsByItemName.get(item.metadata.name);
    if (!result) throw new Error(`Reviewed grounding projection has no decided result for ${item.metadata.name}`);
    if (!importedItemNames.has(item.metadata.name)) {
      throw new Error(`Reviewed grounding projection cannot locate the extraction proposal for ${item.metadata.name}`);
    }
    // A decision that selects no candidate (reject-all or could-not-confirm on
    // a conflict set) states no value, so there is no reviewed value to ground.
    // Its claim stays in `requiredClaimIds` below, so the evaluation reports it
    // as missing reviewed evidence instead of reading as allowed.
    if (result.selectedCandidateId === undefined) continue;
    const candidate = reviewedCandidate(item, result);
    // Survey groups proposals by claim slot (Survey 5), so an item's position
    // in the import no longer equals its proposal's index; the candidate
    // records the index of the proposal it stands for. On a chosen conflict
    // this is the chosen candidate's own proposal, so the evidence cites the
    // chosen value's span and never a rival's.
    const proposalIndex = (candidate.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { proposalIndex?: unknown } | undefined)?.proposalIndex;
    if (typeof proposalIndex !== "number" || !Number.isSafeInteger(proposalIndex)) {
      throw new Error(`Reviewed grounding projection cannot locate the extraction proposal for ${item.metadata.name}`);
    }
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
    // A single-candidate item keeps the v1 profile. A chosen conflict uses v3,
    // which binds every candidate of the item and records the rivals the chosen
    // value was chosen over, so the evidence never reads as an uncontested
    // value. v3 references the import record by digest; the sidecar keeps each
    // entry restorable on its own, as a v1 entry is.
    const chosen = item.spec.candidates.length > 1;
    additionalEvidence.push(projectReviewedExtractionEvidence(input, chosen
      ? { profile: reviewedExtractionEvidenceChoiceProfile, includeImportRecord: true }
      : {}).evidence);
  }

  // requireCurrentSource is deliberately unset and no sourceStates are
  // supplied: this receipt attests the reviewed extraction against the run's
  // own attested artifacts, and fieldwork holds no independent observation of
  // the live source at export time (that is Lookout's recheck job). Surface
  // defaults unchecked source states to "unknown", so "allowed" here means
  // locator/artifact/review/structure requirements passed — it says nothing
  // about whether the source has drifted since extraction.
  //
  // The required claims are the claims this export states, taken from the
  // canonical projection rather than from the evidence just built: a claim
  // whose reviewed evidence went missing then fails as
  // `missing-reviewed-evidence` instead of silently dropping out of the policy.
  const requiredClaimIds = [...new Set(claims.map((claim) => claim.id))];
  // An empty requirement set certifies nothing. Surface 4 refuses it with a
  // `no-required-claims` gap and earlier releases allowed it vacuously, so
  // refuse the export here instead of depending on which Surface is installed.
  // `projectAttestedReviewedProjection` already refuses a round with nothing
  // exportable, so this is a guard, not a reachable export outcome.
  if (requiredClaimIds.length === 0) {
    throw Object.assign(
      new Error("Export refused: this review round states no claims, so there is nothing to evaluate reviewed grounding over."),
      { code: "EXPORT_NOT_PROJECTABLE" },
    );
  }
  const policy: ReviewedGroundingPolicy = {
    id: REVIEWED_GROUNDING_POLICY_ID,
    action: REVIEWED_GROUNDING_ACTION,
    requiredClaimIds,
    requireExactLocator: true,
    requirePreparedArtifact: true,
    requireAcceptedReview: true,
    requireValidatedStructure: true,
    // Survey verifies every excerpt against the prepared text when a run is
    // created, so evidence that does not record that check is not this run's.
    requireVerifiedExcerpts: true,
    // A rival the import left out because its excerpt did not verify is
    // unverifiable, not disproven, and the reviewer could not choose it: it was
    // never a candidate. Nothing resolves it, so a claim it contests is not
    // allowed as grounded. A rival the reviewer saw and chose against is a
    // different case, below.
    refuseExcludedRivals: true,
  };
  // Surface 4 binds each claim's value to its reviewed candidate and refuses a
  // call without `claims`. v3 evidence names its import record by digest, and
  // the resolver reads the record from the sidecar that evidence carries.
  // `refuseChosenOverRivals` stays off: a value the reviewer chose over rivals
  // is allowed on its own evidence, and the evaluation records the choice.
  const input = { policy, evidence: additionalEvidence, claims, resolveImportRecord: resolverFromBundle({ evidence: additionalEvidence }) };
  const decision = evaluateReviewedGroundingPolicy(input);

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

/**
 * The one candidate a decided item's reviewed evidence cites. A single-candidate
 * item cites its candidate. An item with several candidates is a conflict, and
 * only Survey's `select-proposed` names one of them: the cited candidate is the
 * one it chose. Any other decision that names a candidate on a conflict is
 * refused rather than read as the item's first candidate.
 */
function reviewedCandidate(item: ReviewItem, result: ReviewWorkbenchResult): ReviewItem["spec"]["candidates"][number] {
  const { candidates } = item.spec;
  if (candidates.length === 1) return candidates[0]!;
  const chosen = result.decision === "select-proposed"
    ? candidates.find((candidate) => candidate.id === result.selectedCandidateId && candidate.role === "proposed")
    : undefined;
  if (!chosen) {
    throw new Error(`Reviewed grounding projection cannot tell which of ${candidates.length} candidates on ${item.metadata.name} was chosen`);
  }
  return chosen;
}
