import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { buildReviewItemsFromExtractionEnvelopeImport } from "@kontourai/survey";
import { resolverFromBundle, restoreReviewedExtractionEvidence, reviewedExtractionImportRecordDigest, validateTrustBundle } from "@kontourai/surface";
import { z } from "zod";
import { parseReviewedExport, type JsonValue, type ReviewedExportV1 } from "./api-contracts.js";

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
  commit: "ad11082a7b9364fd114680018a1a7e011868c550",
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
  readonly attribution?: JsonValue;
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
    | "excerpt-not-verified";
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
  const claims: MemorySourceClaim[] = [];
  const withheld: WithheldMemoryItem[] = [];

  // Every reviewed-extraction evidence entry, rejected claims' included: they
  // carry the same import record the undecided items need.
  const restoredByClaim = new Map<string, Restored>();
  const records = new Map<string, ImportRecord>();
  for (const evidence of bundle.evidence) {
    if (evidence.metadata?.reviewedExtraction === undefined) continue;
    const restored = restoreReviewedExtractionEvidence(evidence, { resolveImportRecord });
    restoredByClaim.set(evidence.claimId, restored);
    records.set(reviewedExtractionImportRecordDigest(restored.importRecord), restored.importRecord);
  }
  if (records.size > 1) {
    throw new Error(`Reviewed export carries ${records.size} import records; one export covers one source, so project each source's export on its own.`);
  }
  const importRecord = [...records.values()][0];

  for (const surfaceClaim of bundle.claims) {
    const restored = restoredByClaim.get(surfaceClaim.id);
    const decision = restored?.reviewDecision;
    if (surfaceClaim.status === "rejected") {
      if (decision !== undefined && decision.spec.status !== "rejected") {
        throw new Error(`Reviewed export claim ${surfaceClaim.id} is rejected but its Survey decision is ${decision.spec.status}.`);
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
    const attribution = round.decisions.find((entry) => entry.claimId === surfaceClaim.id);
    const gaps = round.groundingRefused.find((entry) => entry.claimId === surfaceClaim.id)?.gaps;
    // Fieldwork disputes exactly the accepted claims whose grounding it refused and lists them in
    // `groundingRefused`, so the status and the list must say the same thing.
    if ((surfaceClaim.status === "disputed") !== (gaps !== undefined)) {
      throw new Error(`Reviewed export claim ${surfaceClaim.id} is ${surfaceClaim.status}, which disagrees with the export's grounding refusals.`);
    }
    claims.push({
      arrival: surfaceClaim.status === "verified" ? "reviewed" : "proposed",
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
        ...(attribution === undefined ? {} : { attribution: attribution as unknown as JsonValue }),
        ...(surfaceClaim.status === "disputed" && gaps !== undefined ? { groundingGaps: gaps } : {}),
      },
    });
  }

  // Survey owns which proposals an item holds: rebuild the items from the
  // import record, as Fieldwork does when it reads a run, and take exactly the
  // candidates of the items the export names as undecided.
  const decidedItems = new Set([...restoredByClaim.values()].flatMap((restored) => restored.reviewDecision ? [restored.reviewDecision.spec.reviewItemName] : []));
  const undecidedItems = new Set<string>();
  const items = importRecord === undefined ? undefined : new Map(buildReviewItemsFromExtractionEnvelopeImport(importRecord as unknown as SurveyImportRecord).map((item) => [item.metadata.name, item]));
  for (const exclusion of round.excluded) {
    if (exclusion.code !== "EXPORT_UNDECIDED") {
      withheld.push({ reason: "excluded-after-review", fieldPath: exclusion.fieldPath, detail: exclusion.code });
      continue;
    }
    if (importRecord === undefined || items === undefined) {
      withheld.push({ reason: "no-import-record", fieldPath: exclusion.fieldPath, detail: exclusion.code });
      continue;
    }
    for (const itemName of exclusion.itemNames) {
      const item = items.get(itemName);
      if (item === undefined) throw new Error(`Reviewed export lists ${itemName} as undecided, but its import record holds no such review item.`);
      // An undecided item is one the export holds no decision for, listed once, under its own field.
      if (decidedItems.has(itemName)) throw new Error(`Reviewed export lists ${itemName} as undecided, but it carries a decision for it.`);
      if (undecidedItems.has(itemName)) throw new Error(`Reviewed export lists ${itemName} as undecided more than once.`);
      undecidedItems.add(itemName);
      if (item.spec.candidates[0]?.claimTarget?.fieldOrBehavior !== exclusion.fieldPath) {
        throw new Error(`Reviewed export lists ${itemName} as undecided under ${exclusion.fieldPath}, which is not its field.`);
      }
      for (const candidate of item.spec.candidates) {
        const index = (candidate.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as { proposalIndex?: unknown } | undefined)?.proposalIndex;
        const proposal = typeof index === "number" ? importRecord.spec.envelope.result.proposals[index] : undefined;
        if (proposal === undefined || candidate.claimTarget === undefined) throw new Error(`Review item ${itemName} has a candidate that names no proposal or claim target.`);
        claims.push({
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
  // Surface refuses a decision whose candidate is not in its item, so the selected candidate is present.
  const selected = reviewItem.spec.candidates.find((candidate) => candidate.id === reviewDecision.spec.candidateId)!;
  if (canonicalJson(selected.value) !== canonicalJson(claim.value)) {
    throw new Error(`Reviewed export claim ${claim.id} states a value that is not the one its Survey decision accepted.`);
  }
  const target = selected.claimTarget;
  if (target?.subjectType !== claim.subjectType || target.subjectId !== claim.subjectId || target.claimType !== claim.claimType || target.fieldOrBehavior !== claim.fieldOrBehavior) {
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

/** The parts of `reviewRound` this projection reads; the rest of the scope passes through untouched. */
const reviewRoundView = z.object({
  revision: z.number().int().nonnegative(),
  complete: z.boolean(),
  // Fieldwork writes `excluded` and `decisions` on every export, empty or not; an export without them has lost something.
  excluded: z.array(z.object({ fieldPath: z.string(), itemNames: z.array(z.string()), code: z.string() })),
  decisions: z.array(z.object({ claimId: z.string() }).passthrough()),
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
