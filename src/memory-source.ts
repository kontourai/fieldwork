import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { buildReviewItemsFromExtractionEnvelopeImport } from "@kontourai/survey";
import { evaluateReviewedGroundingPolicy, resolverFromBundle, restoreReviewedExtractionEvidence, reviewedExtractionImportRecordDigest, validateTrustBundle } from "@kontourai/surface";
import { z } from "zod";
import { parseReviewedExport, type JsonValue, type ReviewedExportV1 } from "./api-contracts.js";
import { reviewedGroundingPolicy } from "./reviewed-evidence.js";
import { candidateSchemaMismatch } from "./schema-match.js";

/**
 * A reviewed export as a memory source (kontourai/fieldwork#205).
 *
 * This is a projection of the reviewed export, not a new truth. The claims it
 * returns conform to the Knowledge Kit memory claim schema, which the Kit owns
 * and Fieldwork does not copy; {@link MEMORY_CLAIM_SCHEMA_PIN} says which
 * version this mapping targets. The review facts (Surface claim status, Survey
 * decision, Fieldwork's attribution) are carried verbatim beside each claim in
 * `origin`; Fieldwork introduces no review disposition or trust status of its
 * own. Accumulation and storage belong to Surface and Corpus Store.
 *
 * The mapping is documented in docs/memory-source.md.
 */
export const MEMORY_CLAIM_SCHEMA_PIN = Object.freeze({
  repo: "kontourai/flow-agents",
  /** Head of kontourai/flow-agents#1574 (branch feat/1571-memory-claims-routing) when this mapping was written. */
  commit: "c107d1253d582d65bcb6aaa8c33e7c081f949751",
  schema: "kits/knowledge/schemas/knowledge/memory-claim.schema.json",
  schemaVersion: "1.0",
});

/**
 * The only Kit `posture` this mapping emits: a field a document states is
 * asserted as true now. The Kit has three more (`proposed`, `hypothetical`,
 * `retracted`) that no export fact supports. Review state is never written
 * into `posture`: the Kit keeps the two apart, and its conflict routing skips
 * `proposed` claims, so an unreviewed assertion marked that way would escape it.
 */
export type FieldworkMemoryPosture = "stated";

/**
 * How the export vouches for a claim, derived from the export's own facts and
 * nothing else (see docs/memory-source.md): `reviewed` when a reviewer's
 * accepted decision is verified by the export, `proposed` otherwise. It is the
 * store's arrival state in the Kit's contract (a `proposed` claim is stored as
 * a pending create proposal), not a Fieldwork trust status, and it is not part
 * of the claim, so a claim keeps its id when a reviewer decides it.
 */
export type MemoryArrival = "reviewed" | "proposed";

/**
 * A memory claim as the pinned schema defines it, restricted to the fields
 * this mapping fills. `validTime`, `qualifiers`, `supersedes` and `visibility`
 * are never emitted: nothing in a reviewed export asserts them. An absent
 * `visibility` reads as sealed, the narrowest, so omission never widens; a host
 * that wants wider visibility stamps it.
 */
export interface FieldworkMemoryClaim {
  readonly schema_version: "1.0";
  readonly id: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly claimType: string;
  readonly property: string;
  readonly value: JsonValue;
  readonly speaker: string;
  readonly source: {
    readonly ref: string;
    readonly locator: string;
    readonly excerpt: string;
    readonly observedAt: string;
    readonly extractor?: string;
  };
  readonly posture: FieldworkMemoryPosture;
}

/** What the export said about a claim that was reviewed, verbatim. */
export interface ReviewedClaimOrigin {
  readonly kind: "reviewed-claim";
  /** The Surface bundle claim this memory claim projects. */
  readonly surfaceClaimId: string;
  /** The bundle claim's own status. `verified` arrives `reviewed`; `disputed` arrives `proposed`. */
  readonly surfaceStatus: "verified" | "disputed";
  readonly reviewItemName: string;
  /** The Survey ReviewDecision the export carries for the claim. */
  readonly reviewDecision: {
    readonly name: string;
    readonly status: string;
    readonly resolution?: string;
    readonly actorId?: string;
    readonly reviewedAt?: string;
  };
  /** Fieldwork's `reviewRound.decisions` entry for the claim: who decided, how, and when the server accepted it. */
  readonly attribution: JsonValue;
  /** With `disputed`: the grounding gaps `reviewRound.groundingRefused` records for the claim. */
  readonly groundingGaps?: readonly string[];
}

/** What the export said about an item no one decided. */
export interface UnreviewedItemOrigin {
  readonly kind: "unreviewed-item";
  /** The export's own exclusion entry for the item, verbatim. */
  readonly exclusion: { readonly code: "EXPORT_UNDECIDED"; readonly fieldPath: string; readonly itemNames: readonly string[] };
}

export interface MemorySourceClaim {
  readonly arrival: MemoryArrival;
  readonly claim: FieldworkMemoryClaim;
  readonly origin: ReviewedClaimOrigin | UnreviewedItemOrigin;
}

/** Something the export holds that this projection does not turn into a claim, and why. Nothing is dropped silently. */
export interface WithheldMemoryItem {
  readonly reason:
    | "rejected-in-review"
    | "unsupported-status"
    | "no-reviewed-evidence"
    | "excluded-after-review"
    | "no-import-record"
    | "excerpt-not-verified"
    | "duplicate-claim";
  readonly surfaceClaimId?: string;
  readonly fieldPath?: string;
  /** The export's own code or status that explains the reason. */
  readonly detail?: string;
}

export interface MemorySourceProjection {
  readonly apiVersion: "fieldwork.kontourai.io/v1";
  readonly kind: "MemorySourceProjection";
  readonly mapping: typeof MEMORY_CLAIM_SCHEMA_PIN;
  /** The export's own scope: the review revision it was taken at, and whether it left anything out. */
  readonly reviewRound: { readonly revision: number; readonly complete: boolean };
  readonly claims: readonly MemorySourceClaim[];
  readonly withheld: readonly WithheldMemoryItem[];
}

/**
 * Project one reviewed export into memory claims.
 *
 * - A `verified` bundle claim arrives `reviewed`.
 * - A `disputed` bundle claim (reviewed, but its grounding was refused) and
 *   every proposal of an item the export lists as `EXPORT_UNDECIDED` arrive
 *   `proposed`.
 * - A `rejected` claim, and any item the export excluded for another reason,
 *   becomes no claim and is listed in `withheld`.
 *
 * Every claim is posture `stated`; the arrival is carried beside it.
 *
 * The export must agree with itself. Surface's digest binding stops evidence
 * being edited, but not the bundle claim being edited away from it, so a claim
 * whose value or status disagrees with the Survey decision its evidence carries
 * is refused, not mapped.
 *
 * One export covers one run's review authority, and so does one projection:
 * `source.ref` and `speaker` are the run's source snapshot, so claims from
 * different snapshots never share an identity. An export that carries more
 * than one source's import record is refused rather than attributed to one.
 */
export function memoryClaimsFromReviewedExport(exported: ReviewedExportV1): MemorySourceProjection {
  const output = parseReviewedExport(exported);
  const bundle = validateTrustBundle(output.bundle);
  const resolveImportRecord = resolverFromBundle(bundle);
  const round = reviewRoundView.parse(output.reviewRound);
  const receipt = reviewedGroundingView.parse(output.reviewedGrounding);
  const groundingGaps = receipt.gaps;
  const claims: MemorySourceClaim[] = [];
  const withheld: WithheldMemoryItem[] = [];

  // Every reviewed-extraction evidence entry, rejected claims' included: they
  // carry the same import record the undecided items need.
  const restoredByClaim = new Map<string, Restored>();
  const records = new Map<string, ImportRecord>();
  for (const evidence of bundle.evidence) {
    if (evidence.metadata?.reviewedExtraction === undefined) continue;
    const restored = restoreReviewedExtractionEvidence(evidence, { resolveImportRecord });
    if (restoredByClaim.has(evidence.claimId)) throw new Error(`Reviewed export carries more than one reviewed-extraction evidence entry for ${evidence.claimId}.`);
    restoredByClaim.set(evidence.claimId, restored);
    records.set(reviewedExtractionImportRecordDigest(restored.importRecord), restored.importRecord);
  }
  if (records.size > 1) {
    throw new Error(`Reviewed export carries ${records.size} import records; one export covers one source, so project each source's export on its own.`);
  }
  const importRecord = [...records.values()][0];

  // A claim is `reviewed` only when nothing the export carries casts doubt on its grounding. The grounding is
  // recomputed from the digest-bound evidence under the policy Fieldwork evaluated it with, and also read from the
  // receipt beside it (its gaps and its dimensions' structural trust): doubt from either source is doubt. A record
  // someone edited can therefore remove doubt from one place without making the claim `reviewed` while another still
  // holds it, and an export an older Fieldwork wrote, which called a value it could not check verified, arrives
  // `proposed` rather than being refused.
  const reviewedEvidence = bundle.evidence.filter((entry) => entry.metadata?.reviewedExtraction !== undefined);
  const recomputed = reviewedEvidence.length === 0 ? undefined : evaluateReviewedGroundingPolicy({
    policy: reviewedGroundingPolicy(bundle.claims.map((claim) => claim.id)),
    evidence: reviewedEvidence,
    claims: bundle.claims.map((claim) => ({ id: claim.id, value: claim.value })),
    resolveImportRecord,
  });
  const recomputedGaps = recomputed?.outcome === "refused" ? recomputed.gaps : [];
  // The receipt's per-claim dimensions say what the policy derived from the same evidence. The fields that bind the
  // receipt to a claim (its evidence, the reviewer's disposition, the exact locator and the digest of the value it
  // states) have to be the ones recomputed; other fields are not compared, so a later Surface can add to a dimension.
  const bound = (dimension: Readonly<Record<string, unknown>>) => canonicalJson([dimension.claimId, dimension.evidenceId, dimension.reviewDisposition, dimension.exactLocator, dimension.candidateValueDigest]);
  const recomputedDimensions = new Set((recomputed?.dimensions ?? []).map((dimension) => bound(dimension as unknown as Record<string, unknown>)));
  for (const dimension of receipt.dimensions) {
    if (!recomputedDimensions.has(bound(dimension))) throw new Error(`Reviewed export's grounding receipt records a dimension for ${String(dimension.claimId)} that its own evidence does not yield.`);
  }

  // The round scope has to agree with the bundle it travels with.
  const claimIds = new Set(bundle.claims.map((claim) => claim.id));
  if (round.complete !== (round.excluded.length === 0)) throw new Error("Reviewed export says it is complete but lists exclusions, or lists none but says it is partial.");
  const attributedClaims = new Set<string>();
  const attributedItems = new Set<string>();
  for (const entry of round.decisions) {
    if (!claimIds.has(entry.claimId)) throw new Error(`Reviewed export attributes a decision to ${entry.claimId}, which is not one of its claims.`);
    if (attributedClaims.has(entry.claimId) || attributedItems.has(entry.reviewItemName)) throw new Error(`Reviewed export attributes more than one decision to ${entry.claimId} or ${entry.reviewItemName}.`);
    attributedClaims.add(entry.claimId);
    attributedItems.add(entry.reviewItemName);
  }
  const statusOf = new Map(bundle.claims.map((claim) => [claim.id, claim.status]));
  // The receipt and the list derived from it have to say the same thing: a refusal lists exactly the gaps the receipt
  // records for its claim, and and a disputed claim with no
  // reviewed evidence (a conflict nobody could confirm) is not a refusal and may carry gaps.
  const receiptKinds = (claimId: string) => new Set(groundingGaps.filter((gap) => gap.claimId === claimId).map((gap) => gap.kind));
  for (const entry of round.groundingRefused) {
    if (statusOf.get(entry.claimId) !== "disputed") throw new Error(`Reviewed export lists a grounding refusal for ${entry.claimId}, which is not a disputed claim of its bundle.`);
    const recorded = receiptKinds(entry.claimId);
    if (recorded.size !== new Set(entry.gaps).size || entry.gaps.some((kind) => !recorded.has(kind))) {
      throw new Error(`Reviewed export refuses ${entry.claimId} for ${[...new Set(entry.gaps)].join(", ")}, but its grounding receipt records ${[...recorded].join(", ") || "nothing"} for it.`);
    }
  }

  /** The kinds of doubt anything the export carries casts on a claim's grounding. */
  const doubtsAbout = (claimId: string, schema: unknown): string[] => {
    const kinds = new Set<string>();
    for (const gap of recomputedGaps) {
      if ("claimId" in gap && gap.claimId === claimId && disputes({ kind: gap.kind, structuralTrust: "structuralTrust" in gap ? String(gap.structuralTrust) : undefined })) kinds.add(gap.kind);
    }
    for (const gap of groundingGaps) if (gap.claimId === claimId && disputes(gap)) kinds.add(gap.kind);
    if (receipt.dimensions.some((dimension) => dimension.claimId === claimId && dimension.structuralTrust === "invalid")) kinds.add("structure-invalid");
    if (typeof schema === "string" && schema !== "ok") kinds.add("schema-mismatch");
    return [...kinds].sort();
  };

  for (const surfaceClaim of bundle.claims) {
    const restored = restoredByClaim.get(surfaceClaim.id);
    const decision = restored?.reviewDecision;
    if (surfaceClaim.status === "verified" || surfaceClaim.status === "disputed" || surfaceClaim.status === "rejected") {
      // Surface derives a claim's status from its latest event, taking the first of equal times (`deriveTrustStatus`);
      // the `status` field beside the events is a copy.
      const latest = [...bundle.events].filter((event) => event.claimId === surfaceClaim.id)
        .reduce<{ status: string; at: number } | undefined>((last, event) => last === undefined || Date.parse(event.createdAt) > last.at ? { status: event.status, at: Date.parse(event.createdAt) } : last, undefined);
      if (latest?.status !== surfaceClaim.status) {
        throw new Error(`Reviewed export claim ${surfaceClaim.id} is ${surfaceClaim.status}, but its latest event says ${latest?.status ?? "nothing"}.`);
      }
      // Fieldwork attributes every claim it exports, rejected ones included, to the item, actor and time of its decision.
      const attributed = round.decisions.find((entry) => entry.claimId === surfaceClaim.id);
      if (attributed === undefined || (decision !== undefined && (attributed.reviewItemName !== decision.spec.reviewItemName || attributed.actor.id !== decision.spec.actor?.id || attributed.decidedAt !== decision.spec.reviewedAt))) {
        throw new Error(`Reviewed export claim ${surfaceClaim.id} has no round attribution that names the review item, actor and time of its Survey decision.`);
      }
      if (decision !== undefined) {
        // The review events speak to the same decision.
        const reviewed = bundle.events.filter((event) => event.claimId === surfaceClaim.id && event.status === decision.spec.status);
        if (reviewed.some((event) => event.actor !== decision.spec.actor?.id)) {
          throw new Error(`Reviewed export claim ${surfaceClaim.id} has a review event by another actor than its Survey decision names.`);
        }
        assertSameTarget(surfaceClaim, restored!);
      }
    }
    if (surfaceClaim.status === "rejected") {
      if (decision !== undefined && decision.spec.status !== "rejected") {
        throw new Error(`Reviewed export claim ${surfaceClaim.id} is rejected but its Survey decision is ${decision.spec.status}.`);
      }
      // A rejection of one proposal states that proposal's value; a rejection of a whole conflict states none.
      const rejectedCandidate = restored?.reviewItem?.spec.candidates.find((candidate) => candidate.id === decision?.spec.candidateId);
      if (rejectedCandidate !== undefined && canonicalJson(rejectedCandidate.value) !== canonicalJson(surfaceClaim.value)) {
        throw new Error(`Reviewed export claim ${surfaceClaim.id} states a value that is not the one its Survey decision rejected.`);
      }
      withheld.push({ reason: "rejected-in-review", surfaceClaimId: surfaceClaim.id, fieldPath: surfaceClaim.fieldOrBehavior });
      continue;
    }
    if (surfaceClaim.status !== "verified" && surfaceClaim.status !== "disputed") {
      withheld.push({ reason: "unsupported-status", surfaceClaimId: surfaceClaim.id, fieldPath: surfaceClaim.fieldOrBehavior, detail: surfaceClaim.status });
      continue;
    }
    const proposal = restored?.importRecord.spec.envelope.result.proposals[restored.proposalIndex];
    if (restored === undefined || proposal === undefined || decision === undefined) {
      withheld.push({ reason: "no-reviewed-evidence", surfaceClaimId: surfaceClaim.id, fieldPath: surfaceClaim.fieldOrBehavior });
      continue;
    }
    assertAgreesWithDecision(surfaceClaim, restored);
    // Traverse's schema match is carried twice, on the proposal and on the candidate Fieldwork reads it from.
    const schema = (proposal as { evidenceMatch?: { schema?: unknown } }).evidenceMatch?.schema;
    const selectedCandidate = restored.reviewItem?.spec.candidates.find((candidate) => candidate.id === decision.spec.candidateId);
    if ((candidateSchemaMismatch(selectedCandidate ?? { producer: undefined })?.schema ?? "ok") !== (typeof schema === "string" ? schema : "ok")) {
      throw new Error(`Reviewed export claim ${surfaceClaim.id} carries one schema match on its proposal and another on the candidate its Survey decision selected.`);
    }
    // The declared type is carried twice as well, and a schema match against the wrong type means nothing.
    const declaredType = (selectedCandidate?.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { valueType?: { type?: unknown } } | undefined)?.valueType?.type;
    if ((declaredType ?? null) !== ((proposal as { valueType?: unknown }).valueType ?? null)) {
      throw new Error(`Reviewed export claim ${surfaceClaim.id} carries one value type on its proposal and another on the candidate its Survey decision selected.`);
    }
    const doubts = doubtsAbout(surfaceClaim.id, schema);
    if (surfaceClaim.status === "disputed" && doubts.length === 0) {
      throw new Error(`Reviewed export claim ${surfaceClaim.id} is disputed, but nothing it carries casts doubt on its grounding.`);
    }
    const attribution = round.decisions.find((entry) => entry.claimId === surfaceClaim.id)!;
    const gaps = round.groundingRefused.find((entry) => entry.claimId === surfaceClaim.id)?.gaps;
    // Fieldwork disputes exactly the accepted claims whose grounding it refused and lists them in
    // `groundingRefused`, so the status and the list must say the same thing.
    if ((surfaceClaim.status === "disputed") !== (gaps !== undefined)) {
      throw new Error(`Reviewed export claim ${surfaceClaim.id} is ${surfaceClaim.status}, which disagrees with the export's grounding refusals.`);
    }
    addClaim({
      arrival: surfaceClaim.status === "verified" && doubts.length === 0 ? "reviewed" : "proposed",
      claim: memoryClaim({
        subject: { type: surfaceClaim.subjectType, id: surfaceClaim.subjectId },
        claimType: surfaceClaim.claimType,
        property: surfaceClaim.fieldOrBehavior,
        value: surfaceClaim.value as JsonValue,
      }, sourceOf(restored.importRecord, proposal)),
      origin: {
        kind: "reviewed-claim",
        surfaceClaimId: surfaceClaim.id,
        surfaceStatus: surfaceClaim.status,
        reviewItemName: decision.spec.reviewItemName,
        reviewDecision: {
          name: decision.metadata.name,
          status: decision.spec.status,
          ...(decision.spec.resolution === undefined ? {} : { resolution: decision.spec.resolution }),
          ...(decision.spec.actor === undefined ? {} : { actorId: decision.spec.actor.id }),
          ...(decision.spec.reviewedAt === undefined ? {} : { reviewedAt: decision.spec.reviewedAt }),
        },
        attribution: attribution as unknown as JsonValue,
        ...(surfaceClaim.status === "disputed" && gaps !== undefined ? { groundingGaps: gaps } : surfaceClaim.status === "verified" && doubts.length > 0 ? { groundingGaps: doubts } : {}),
      },
    });
  }

  // Survey owns which proposals an item holds: rebuild the items from the
  // import record, as Fieldwork does when it reads a run, and take exactly the
  // candidates of the items the export names as undecided.
  const decidedItems = new Set([
    ...[...restoredByClaim.values()].flatMap((restored) => restored.reviewDecision ? [restored.reviewDecision.spec.reviewItemName] : []),
    ...round.decisions.map((entry) => entry.reviewItemName),
  ]);
  const undecidedItems = new Set<string>();
  const items = importRecord === undefined ? undefined : new Map(buildReviewItemsFromExtractionEnvelopeImport(importRecord as unknown as SurveyImportRecord).map((item) => [item.metadata.name, item]));
  for (const exclusion of round.excluded) {
    // Every exclusion names items the import record holds, under the field it lists them for.
    for (const itemName of exclusion.itemNames) {
      const item = items?.get(itemName);
      if (items !== undefined && item === undefined) throw new Error(`Reviewed export lists ${itemName} as excluded (${exclusion.code}), but its import record holds no such review item.`);
      if (item !== undefined && item.spec.candidates[0]?.claimTarget?.fieldOrBehavior !== exclusion.fieldPath) {
        throw new Error(`Reviewed export lists ${itemName} as excluded (${exclusion.code}) under ${exclusion.fieldPath}, which is not its field.`);
      }
    }
    if (exclusion.code !== "EXPORT_UNDECIDED") {
      // Fieldwork leaves these items out of the export, so none of them has a claim, evidence or attribution in it.
      for (const itemName of exclusion.itemNames) {
        if (decidedItems.has(itemName)) throw new Error(`Reviewed export excludes ${itemName} (${exclusion.code}) but also exports a decision for it.`);
      }
      withheld.push({ reason: "excluded-after-review", fieldPath: exclusion.fieldPath, detail: exclusion.code });
      continue;
    }
    if (importRecord === undefined || items === undefined) {
      withheld.push({ reason: "no-import-record", fieldPath: exclusion.fieldPath, detail: exclusion.code });
      continue;
    }
    for (const itemName of exclusion.itemNames) {
      const item = items.get(itemName)!;
      // An undecided item is one the export holds no decision for, listed once, under its own field.
      if (decidedItems.has(itemName)) throw new Error(`Reviewed export lists ${itemName} as undecided, but it carries a decision for it.`);
      if (undecidedItems.has(itemName)) throw new Error(`Reviewed export lists ${itemName} as undecided more than once.`);
      undecidedItems.add(itemName);
      for (const candidate of item.spec.candidates) {
        const index = (candidate.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { proposalIndex?: unknown } | undefined)?.proposalIndex;
        const proposal = typeof index === "number" ? importRecord.spec.envelope.result.proposals[index] : undefined;
        if (proposal === undefined || candidate.claimTarget === undefined) throw new Error(`Review item ${itemName} has a candidate that names no proposal or claim target.`);
        addClaim({
          arrival: "proposed",
          claim: memoryClaim({
            subject: { type: candidate.claimTarget.subjectType, id: candidate.claimTarget.subjectId },
            claimType: candidate.claimTarget.claimType,
            property: candidate.claimTarget.fieldOrBehavior,
            value: proposal.candidateValue as JsonValue,
          }, sourceOf(importRecord, proposal)),
          origin: { kind: "unreviewed-item", exclusion: { code: "EXPORT_UNDECIDED", fieldPath: exclusion.fieldPath, itemNames: exclusion.itemNames } },
        });
      }
    }
    // A proposal Survey could not match to the prepared text was never a review
    // candidate and is not grounded, so there is nothing to remember: say so.
    for (const diagnostic of importRecord.status.diagnostics) {
      const unverified = diagnostic.kind === "excerpt-mismatch" ? importRecord.spec.envelope.result.proposals[diagnostic.proposalIndex as number] : undefined;
      if (unverified?.fieldPath === exclusion.fieldPath) withheld.push({ reason: "excerpt-not-verified", fieldPath: exclusion.fieldPath, detail: exclusion.code });
    }
  }

  if (items !== undefined) {
    const accounted = new Set([...decidedItems, ...round.excluded.flatMap((entry) => entry.itemNames)]);
    const missing = [...items.keys()].filter((name) => !accounted.has(name));
    if (missing.length > 0) throw new Error(`Reviewed export neither decides nor excludes ${missing.length} of its review items (${missing[0]}${missing.length > 1 ? ", ..." : ""}); it has lost something.`);
  }
  /**
   * The Kit gives identical content one id, so two items that state the same value from the same span are one
   * claim and the second is reported. Reviewed claims are added before undecided ones, and Fieldwork excludes a
   * decided item while a sibling on its field is undecided, so the claim kept is never a weaker twin of a stronger one.
   */
  function addClaim(entry: MemorySourceClaim): void {
    if (claims.some((existing) => existing.claim.id === entry.claim.id)) {
      withheld.push({ reason: "duplicate-claim", fieldPath: entry.claim.property, detail: entry.claim.id });
      return;
    }
    claims.push(entry);
  }

  return {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "MemorySourceProjection",
    mapping: MEMORY_CLAIM_SCHEMA_PIN,
    reviewRound: { revision: round.revision, complete: round.complete },
    claims,
    withheld,
  };
}

const SURVEY_EXTRACTION_ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";

/**
 * A bundle claim is only as good as the decision its evidence carries. Accepting
 * means the decision is `verified` and accepted (not held), and selects the
 * candidate whose claim target and value the bundle claim states; anything else
 * is an export that disagrees with itself. Surface refuses an edited value on a
 * non-editable review, so the selected candidate's value is the decided one.
 */
function assertAgreesWithDecision(
  claim: { readonly id: string; readonly value: unknown; readonly subjectType: string; readonly subjectId: string; readonly claimType: string; readonly fieldOrBehavior: string },
  restored: Restored,
): void {
  const { reviewDecision, reviewItem } = restored;
  if (reviewDecision === undefined || reviewItem === undefined) throw new Error(`Reviewed export claim ${claim.id} carries no review item or decision.`);
  if (reviewDecision.spec.status !== "verified" || (reviewDecision.spec.resolution !== undefined && reviewDecision.spec.resolution !== "accepted")) {
    throw new Error(`Reviewed export claim ${claim.id} is stated as accepted but its Survey decision is ${reviewDecision.spec.resolution ?? reviewDecision.spec.status}.`);
  }
  const selected = reviewItem.spec.candidates.find((candidate) => candidate.id === reviewDecision.spec.candidateId);
  if (selected === undefined) throw new Error(`Reviewed export claim ${claim.id}: its Survey decision selects no candidate of its review item.`);
  // The evidence cites one proposal and the decision selects one candidate; they have to be the same.
  const cited = (selected.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { proposalIndex?: unknown } | undefined)?.proposalIndex;
  if (cited !== restored.proposalIndex) throw new Error(`Reviewed export claim ${claim.id} cites a proposal other than the candidate its Survey decision selected.`);
  if (canonicalJson(selected.value) !== canonicalJson(claim.value)) {
    throw new Error(`Reviewed export claim ${claim.id} states a value that is not the one its Survey decision accepted.`);
  }
  assertSameTarget(claim, restored);
}

/** The claim target is part of what the reviewer decided on, for rejected claims as for accepted ones. */
function assertSameTarget(
  claim: { readonly id: string; readonly subjectType: string; readonly subjectId: string; readonly claimType: string; readonly fieldOrBehavior: string },
  restored: Restored,
): void {
  // Survey groups proposals by claim slot, so every candidate of an item (the selected one included) states the item's target.
  const candidates = restored.reviewItem?.spec.candidates ?? [];
  const states = (target: { subjectType?: unknown; subjectId?: unknown; claimType?: unknown; fieldOrBehavior?: unknown } | undefined) =>
    target?.subjectType === claim.subjectType && target.subjectId === claim.subjectId && target.claimType === claim.claimType && target.fieldOrBehavior === claim.fieldOrBehavior;
  // The import record Survey built the item from names the targets the task declared; the claim has to be one of them.
  if (!restored.importRecord.spec.claimTargets.some(states)) {
    throw new Error(`Reviewed export claim ${claim.id} states a claim target its import record does not declare.`);
  }
  if (candidates.length === 0 || candidates.some((candidate) => {
    const target = candidate.claimTarget;
    return target?.subjectType !== claim.subjectType || target.subjectId !== claim.subjectId || target.claimType !== claim.claimType || target.fieldOrBehavior !== claim.fieldOrBehavior;
  })) {
    throw new Error(`Reviewed export claim ${claim.id} states a claim target other than the one its Survey decision accepted.`);
  }
}

/**
 * Surface restores the record under its own declaration of Survey's shape. The two are the same
 * record (Survey exports adapters one way, to Surface, with a field-assignability guard; see src/reviewed-evidence.ts), and
 * Surface declares the looser shapes, so the reverse direction needs this cast until Survey exports an adapter for it.
 */
type SurveyImportRecord = Parameters<typeof buildReviewItemsFromExtractionEnvelopeImport>[0];
type Restored = ReturnType<typeof restoreReviewedExtractionEvidence>;
type ImportRecord = Restored["importRecord"];
type Proposal = ImportRecord["spec"]["envelope"]["result"]["proposals"][number];

/** The codes Fieldwork lists exclusions under (`ReviewedExportExclusion` in src/fieldwork.ts). */
const EXCLUSION_CODES = ["EXPORT_UNDECIDED", "EXPORT_FIELD_UNSETTLED", "EXPORT_UNGROUNDED_SELECTION", "EXPORT_CONFLICTING_DECISIONS", "EXPORT_NOT_PROJECTABLE"] as const;

/** What this projection reads of `reviewedGrounding`: the claim-specific gaps and per-claim dispositions of the receipt Fieldwork's `groundingRefused` is derived from. */
const reviewedGroundingView = z.object({
  gaps: z.array(z.object({ kind: z.string(), claimId: z.string().optional(), structuralTrust: z.string().optional() }).passthrough()).default([]),
  dimensions: z.array(z.record(z.string(), z.unknown())).default([]),
}).passthrough();

/** Gaps that mean Surface could not check a verified claim's structure; they leave it verified (see classifyGroundingRefusals). */
const STRUCTURAL_GAPS = new Set(["evidence-not-entailing", "structure-not-validated", "profile-gap"]);

/**
 * Whether a receipt gap disputes its claim. As in classifyGroundingRefusals, a structural gap leaves a claim verified
 * unless Surface checked the value and found it invalid, which is a schema mismatch.
 */
const disputes = (gap: { readonly kind: string; readonly structuralTrust?: string }): boolean =>
  !STRUCTURAL_GAPS.has(gap.kind) || (gap.kind === "structure-not-validated" && gap.structuralTrust === "invalid");

/** The parts of `reviewRound` this projection reads; other fields are ignored. */
const reviewRoundView = z.object({
  revision: z.number().int().nonnegative(),
  complete: z.boolean(),
  // Fieldwork writes `excluded` and `decisions` on every export, empty or not; an export without them has lost something.
  excluded: z.array(z.object({ fieldPath: z.string(), itemNames: z.array(z.string()).min(1), code: z.enum(EXCLUSION_CODES) })),
  decisions: z.array(z.object({ claimId: z.string(), reviewItemName: z.string(), decidedAt: z.string(), actor: z.object({ id: z.string() }).passthrough() }).passthrough()),
  groundingRefused: z.array(z.object({ claimId: z.string(), gaps: z.array(z.string()) }).passthrough()).default([]),
}).passthrough();

/**
 * The source fields, from the proposal as Traverse recorded it. The source is
 * also the speaker: Fieldwork knows no author, and naming the snapshot keeps
 * each snapshot's authority its own.
 */
function sourceOf(record: ImportRecord, proposal: Proposal): { readonly source: FieldworkMemoryClaim["source"]; readonly speaker: string } {
  const { source, result } = record.spec.envelope;
  // Fieldwork writes the same snapshot ref to both fields of the envelope source.
  const ref = source.ref;
  return {
    speaker: ref,
    source: {
      ref,
      locator: proposal.provenance.locator,
      excerpt: proposal.provenance.excerpt,
      observedAt: result.extractedAt,
      extractor: proposal.extractor,
    },
  };
}

/**
 * The Kit's identity rule, pinned at {@link MEMORY_CLAIM_SCHEMA_PIN}: `id` is the
 * sha256 of the canonical JSON of every other field of the claim, provenance
 * included. The Kit recomputes it on read and refuses a claim whose id differs,
 * so this must match it exactly. Every field this mapping fills is in the
 * digest; the Kit's ordering of `supersedes` and `visibility` does not apply
 * because neither is emitted. test/memory-source.test.ts pins ids the Kit's own
 * builder produced.
 */
export function memoryClaimId(claim: Omit<FieldworkMemoryClaim, "id">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(claim)).digest("hex")}`;
}

function memoryClaim(
  fields: Pick<FieldworkMemoryClaim, "subject" | "claimType" | "property" | "value">,
  from: { readonly source: FieldworkMemoryClaim["source"]; readonly speaker: string },
): FieldworkMemoryClaim {
  const content = { schema_version: "1.0" as const, ...fields, speaker: from.speaker, source: from.source, posture: "stated" as const };
  return { id: memoryClaimId(content), ...content };
}
