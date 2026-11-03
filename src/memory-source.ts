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
  commit: "100fadb45e54d664eed92cc44fa98a4dc542bad7",
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
  /** The bundle claim's own status. `verified` arrives `reviewed` unless something carried casts doubt on its grounding; `disputed` arrives `proposed`. */
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
 * - A `verified` bundle claim arrives `reviewed`, unless anything the export
 *   carries casts doubt on its grounding, in which case it arrives `proposed`.
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
  // Fieldwork 0.9 and 0.10 exported a bare trust bundle: the Survey records ride in its evidence, but there is no round
  // scope beside it (no attribution, no list of undecided items, no completeness), so an unreviewed item cannot be
  // listed and a decision cannot be attributed. 0.11 introduced the envelope this reads.
  if (exported !== null && typeof exported === "object" && !("kind" in exported) && "schemaVersion" in exported && "claims" in exported) {
    throw Object.assign(new Error("This is a bare trust bundle, the format Fieldwork wrote before 0.11. It has no round scope (no attribution, undecided items or completeness) beside it, which this reads; export it again with Fieldwork 0.11 or later."), { code: "EXPORT_UNSUPPORTED_FORMAT" });
  }
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
  const rebuiltItems = importRecord === undefined ? new Map<string, ReturnType<typeof buildReviewItemsFromExtractionEnvelopeImport>[number]>() : new Map(buildReviewItemsFromExtractionEnvelopeImport(importRecord as unknown as SurveyImportRecord).map((item) => [item.metadata.name, item]));

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
  // states) have to be the ones recomputed or the export is refused; any other key the dimension states that the policy
  // does not yield is doubt (below). A key only the policy yields is not stated, so a later Surface can add to a dimension.
  const bound = (dimension: Readonly<Record<string, unknown>>) => canonicalJson([dimension.claimId, dimension.evidenceId, dimension.reviewDisposition, dimension.exactLocator, dimension.candidateValueDigest]);
  const recomputedDimensionFor = new Map((recomputed?.dimensions ?? []).map((dimension) => [bound(dimension as unknown as Record<string, unknown>), dimension] as const));
  const recomputedDimensions = new Set(recomputedDimensionFor.keys());
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
  const claimOfEvidence = new Map(bundle.evidence.map((entry) => [entry.id, entry.claimId]));
  /**
   * The claims a gap names, by its claim id and by the evidence it names. A name that resolves to nothing the export
   * has is `undefined`, and a gap that names nothing at all has no names: both are about every claim, so a gap
   * cannot be made to point elsewhere by editing one of its addresses.
   */
  const gapNames = (gap: { readonly claimId?: unknown; readonly evidenceId?: unknown }): (string | undefined)[] => [
    ...(typeof gap.claimId === "string" ? [claimIds.has(gap.claimId) ? gap.claimId : undefined] : []),
    ...(typeof gap.evidenceId === "string" ? [claimOfEvidence.get(gap.evidenceId)] : []),
  ];
  /** Whether a gap names the claim (for reconciling a refusal list, where only a named claim counts). */
  const namesClaim = (gap: { readonly claimId?: unknown; readonly evidenceId?: unknown }, claimId: string): boolean => gapNames(gap).includes(claimId);
  /** Whether a gap is about the claim: it names it, or names nothing that resolves, or names nothing. */
  const gapIsAbout = (gap: { readonly claimId?: unknown; readonly evidenceId?: unknown }, claimId: string): boolean => {
    const names = gapNames(gap);
    return names.length === 0 || names.includes(undefined) || names.includes(claimId);
  };
  const statusOf = new Map(bundle.claims.map((claim) => [claim.id, claim.status]));
  // The receipt and the list derived from it have to say the same thing: a refusal lists exactly the gaps the receipt
  // records for its claim, and a disputed claim with no
  // reviewed evidence (a conflict nobody could confirm) is not a refusal and may carry gaps.
  const receiptKinds = (claimId: string) => new Set(groundingGaps.filter((gap) => namesClaim(gap, claimId)).map((gap) => gap.kind));
  for (const entry of round.groundingRefused) {
    if (statusOf.get(entry.claimId) !== "disputed") throw new Error(`Reviewed export lists a grounding refusal for ${entry.claimId}, which is not a disputed claim of its bundle.`);
    const recorded = receiptKinds(entry.claimId);
    if (recorded.size !== new Set(entry.gaps).size || entry.gaps.some((kind) => !recorded.has(kind))) {
      throw new Error(`Reviewed export refuses ${entry.claimId} for ${[...new Set(entry.gaps)].join(", ")}, but its grounding receipt records ${[...recorded].join(", ") || "nothing"} for it.`);
    }
  }

  // Fieldwork 0.11 and 0.12 never recorded whether excerpts were checked against the prepared text: their review items
  // have no `excerptVerification` and their imports say `provenance: "unverified"`. The check recomputed today is not
  // one those writers made, so for that shape (and only that shape) the gap is not doubt. The evidence says so, not
  // the receipt, which can be thinned out. An item that records `unverified`, or a missing record under an import
  // that says `verified`, is doubt. An export rewritten into exactly the 0.11/0.12 shape is the same data as one they
  // wrote and is read as theirs; the docs list that under what the projection cannot tell.
  const legacyEvidence = (claimId: string): boolean => {
    const restored = restoredByClaim.get(claimId);
    const producer = restored?.reviewItem?.metadata.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { excerptVerification?: unknown } | undefined;
    return restored !== undefined && producer?.excerptVerification === undefined && restored.importRecord.status.provenance === "unverified";
  };
  /** What a receipt dimension records against its claim, as the policy would read it (src: Surface reviewed-grounding-policy). */
  const dimensionDoubts = (dimension: Readonly<Record<string, unknown>>): string[] => {
    const kinds: string[] = [];
    const artifact = dimension.preparedArtifact as { status?: unknown } | undefined;
    if (artifact !== undefined && artifact.status !== "available") kinds.push("missing-prepared-artifact");
    if (dimension.structuralTrust === "invalid") kinds.push("structure-invalid");
    if (dimension.excerptVerification === "unverified") kinds.push("excerpt-not-verified");
    if (dimension.excludedRivals !== undefined) kinds.push("excluded-rival-unresolved");
    if (dimension.hiddenConflict !== undefined) kinds.push("hidden-conflict");
    return kinds;
  };

  /** The kinds of doubt anything the export carries casts on a claim's grounding. */
  const doubtsAbout = (claimId: string, schema: unknown): string[] => {
    const kinds = new Set<string>();
    for (const gap of recomputedGaps) {
      if (gapIsAbout(gap as { claimId?: unknown; evidenceId?: unknown }, claimId) && !(legacyEvidence(claimId) && gap.kind === "excerpt-not-verified")
        && disputes({ kind: gap.kind, structuralTrust: "structuralTrust" in gap ? String(gap.structuralTrust) : undefined, gap: "gap" in gap ? (gap.gap as { kind?: unknown; status?: unknown }) : undefined })) kinds.add(gap.kind);
    }
    for (const gap of groundingGaps) if (gapIsAbout(gap, claimId) && disputes(gap)) kinds.add(gap.kind);
    for (const dimension of receipt.dimensions) {
      if (!(dimension.claimId === claimId || claimOfEvidence.get(String(dimension.evidenceId)) === claimId)) continue;
      for (const kind of dimensionDoubts(dimension)) kinds.add(kind);
      // The dimension is what the policy derives from the evidence. Any key on which the carried one differs (the
      // choice, the source state, a field a later Surface adds) is a receipt that no longer says what the evidence does.
      // Every key the carried dimension states has to be what the policy yields; a key only a later Surface yields is not
      // stated, so it is not in dispute.
      const yielded = recomputedDimensionFor.get(bound(dimension)) as Record<string, unknown> | undefined;
      const plain = yielded === undefined ? undefined : JSON.parse(JSON.stringify(yielded)) as Record<string, unknown>;
      if (plain !== undefined && Object.keys(dimension).some((key) => !(key in plain) || canonicalJson(plain[key]) !== canonicalJson(dimension[key]))) kinds.add("receipt-differs");
    }
    if (typeof schema === "string" && schema !== "ok") kinds.add("schema-mismatch");
    // The carried candidate's provenance (the extraction outcome, the evidence match, the occurrence) is what Survey derives
    // from the import record. Every key it states has to be the one Survey yields again.
    const restored = restoredByClaim.get(claimId);
    const fresh = restored === undefined ? undefined : rebuiltItems.get(restored.reviewItem?.metadata.name ?? "");
    for (const candidate of restored?.reviewItem?.spec.candidates ?? []) {
      const stated = candidate.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as Record<string, unknown> | undefined;
      const rebuilt = fresh?.spec.candidates.find((entry) => entry.id === candidate.id)?.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as Record<string, unknown> | undefined;
      if (stated !== undefined && Object.keys(stated).some((key) => rebuilt === undefined || !(key in rebuilt) || canonicalJson(stated[key]) !== canonicalJson(rebuilt[key]))) kinds.add("candidate-differs");
    }
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
  const items = importRecord === undefined ? undefined : rebuiltItems;
  const seenExclusions = new Set<string>();
  for (const exclusion of round.excluded) {
    // The same exclusion listed twice is one exclusion.
    const exclusionKey = canonicalJson([exclusion.code, exclusion.fieldPath, [...exclusion.itemNames].sort()]);
    if (exclusion.code !== "EXPORT_UNDECIDED" && seenExclusions.has(exclusionKey)) continue;
    seenExclusions.add(exclusionKey);
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
   * claim and the second is reported. If their arrivals differ the weaker stands, whichever came first: a twin
   * the export doubts, or never decided, is not made `reviewed` by the other.
   */
  function addClaim(entry: MemorySourceClaim): void {
    const index = claims.findIndex((existing) => existing.claim.id === entry.claim.id);
    if (index === -1) { claims.push(entry); return; }
    withheld.push({ reason: "duplicate-claim", fieldPath: entry.claim.property, detail: entry.claim.id });
    if (claims[index]!.arrival === "reviewed" && entry.arrival === "proposed") claims[index] = entry;
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
  gaps: z.array(z.object({ kind: z.string(), claimId: z.string().optional(), evidenceId: z.string().optional(), structuralTrust: z.string().optional(), gap: z.object({ kind: z.unknown().optional(), status: z.unknown().optional() }).passthrough().optional() }).passthrough()).default([]),
  dimensions: z.array(z.record(z.string(), z.unknown())).default([]),
}).passthrough();

/** Gaps that mean Surface could not check a verified claim's structure; they leave it verified (see classifyGroundingRefusals). */
const STRUCTURAL_GAPS = new Set(["evidence-not-entailing", "structure-not-validated", "profile-gap"]);

/**
 * Whether a receipt gap disputes its claim. As in classifyGroundingRefusals, a structural gap leaves a claim verified
 * unless Surface checked the value and found it invalid, which is a schema mismatch.
 */
const disputes = (gap: { readonly kind: string; readonly structuralTrust?: string; readonly gap?: { readonly kind?: unknown; readonly status?: unknown } }): boolean => {
  if (gap.kind === "structure-not-validated") return gap.structuralTrust === "invalid";
  // The only profile gap that leaves a claim verified is the one saying its structure was left unvalidated; one that
  // says provenance was dropped, an artifact was unavailable or a different candidate was chosen is doubt.
  if (gap.kind === "profile-gap") return !(gap.gap?.kind === "structural-trust" && gap.gap.status === "unvalidated");
  return !STRUCTURAL_GAPS.has(gap.kind);
};

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
