import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { resolverFromBundle, restoreReviewedExtractionEvidence, validateTrustBundle } from "@kontourai/surface";
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
  commit: "441d894074775ad0ecb3b8d1594a176fb334a28e",
  schema: "kits/knowledge/schemas/knowledge/memory-claim.schema.json",
  schemaVersion: "1.0",
});

/** The Kit's `posture` values this mapping emits. The Kit has two more (`hypothetical`, `retracted`) that no export fact supports. */
export type FieldworkMemoryPosture = "stated" | "proposed";

/**
 * A memory claim as the pinned schema defines it, restricted to the fields
 * this mapping fills. `validTime`, `qualifiers`, `supersedes` and `audience`
 * are never emitted: nothing in a reviewed export asserts them, and an absent
 * audience inherits the source's, so omission never widens.
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
  /** The bundle claim's own status. `verified` maps to `stated`; `disputed` maps to `proposed`. */
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
 * - A `verified` bundle claim arrives with posture `stated`.
 * - A `disputed` bundle claim (reviewed, but its grounding was refused) and an
 *   item the export lists as `EXPORT_UNDECIDED` arrive with posture `proposed`.
 * - A `rejected` claim, and any item the export excluded for another reason,
 *   becomes no claim and is listed in `withheld`.
 *
 * One export covers one run's review authority, and so does one projection:
 * `source.ref` and `speaker` are the run's source snapshot, so claims from
 * different snapshots never share an identity and this function has no way to
 * merge two exports.
 */
export function memoryClaimsFromReviewedExport(exported: ReviewedExportV1): MemorySourceProjection {
  const output = parseReviewedExport(exported);
  const bundle = validateTrustBundle(output.bundle);
  const resolveImportRecord = resolverFromBundle(bundle);
  const round = reviewRoundView.parse(output.reviewRound);
  const claims: MemorySourceClaim[] = [];
  const withheld: WithheldMemoryItem[] = [];
  let importRecord: ImportRecord | undefined;

  for (const surfaceClaim of bundle.claims) {
    if (surfaceClaim.status === "rejected") {
      withheld.push({ reason: "rejected-in-review", surfaceClaimId: surfaceClaim.id, fieldPath: surfaceClaim.fieldOrBehavior });
      continue;
    }
    if (surfaceClaim.status !== "verified" && surfaceClaim.status !== "disputed") {
      withheld.push({ reason: "unsupported-status", surfaceClaimId: surfaceClaim.id, fieldPath: surfaceClaim.fieldOrBehavior, detail: surfaceClaim.status });
      continue;
    }
    const evidence = bundle.evidence.find((entry) => entry.claimId === surfaceClaim.id && entry.metadata?.reviewedExtraction !== undefined);
    const restored = evidence === undefined ? undefined : restoreReviewedExtractionEvidence(evidence, { resolveImportRecord });
    const proposal = restored?.importRecord.spec.envelope.result.proposals[restored.proposalIndex];
    if (restored === undefined || proposal === undefined || restored.reviewDecision === undefined) {
      withheld.push({ reason: "no-reviewed-evidence", surfaceClaimId: surfaceClaim.id, fieldPath: surfaceClaim.fieldOrBehavior });
      continue;
    }
    importRecord ??= restored.importRecord;
    const decision = restored.reviewDecision;
    const attribution = round.decisions.find((entry) => entry.claimId === surfaceClaim.id);
    const gaps = round.groundingRefused.find((entry) => entry.claimId === surfaceClaim.id)?.gaps;
    claims.push({
      claim: memoryClaim({
        subject: { type: surfaceClaim.subjectType, id: surfaceClaim.subjectId },
        claimType: surfaceClaim.claimType,
        property: surfaceClaim.fieldOrBehavior,
        value: surfaceClaim.value as JsonValue,
        posture: surfaceClaim.status === "verified" ? "stated" : "proposed",
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

  for (const exclusion of round.excluded) {
    if (exclusion.code !== "EXPORT_UNDECIDED") {
      withheld.push({ reason: "excluded-after-review", fieldPath: exclusion.fieldPath, detail: exclusion.code });
      continue;
    }
    if (importRecord === undefined) {
      withheld.push({ reason: "no-import-record", fieldPath: exclusion.fieldPath, detail: exclusion.code });
      continue;
    }
    const { proposals } = importRecord.spec.envelope.result;
    // Fieldwork refuses a task that declares a field twice, so the import record
    // names exactly one claim target per field. An export without one is not
    // one Fieldwork wrote, and is refused rather than guessed at.
    const target = importRecord.spec.claimTargets.find((entry) => entry.fieldOrBehavior === exclusion.fieldPath);
    if (!isNonEmptyString(target?.subjectType) || !isNonEmptyString(target.subjectId) || !isNonEmptyString(target.claimType)) {
      throw new Error(`Reviewed export has no claim target for ${exclusion.fieldPath}, so its undecided item cannot be mapped.`);
    }
    // An excerpt Survey could not match to the prepared text was never a review
    // candidate and is not grounded, so it is no proposal worth remembering.
    const unverified = new Set(importRecord.status.diagnostics.flatMap((diagnostic) => diagnostic.kind === "excerpt-mismatch" ? [diagnostic.proposalIndex as number] : []));
    proposals.forEach((proposal, index) => {
      if (proposal.fieldPath !== exclusion.fieldPath) return;
      if (unverified.has(index)) {
        withheld.push({ reason: "excerpt-not-verified", fieldPath: exclusion.fieldPath, detail: exclusion.code });
        return;
      }
      claims.push({
        claim: memoryClaim({
          subject: { type: target.subjectType as string, id: target.subjectId as string },
          claimType: target.claimType as string,
          property: exclusion.fieldPath,
          value: proposal.candidateValue as JsonValue,
          posture: "proposed",
        }, sourceOf(importRecord!, proposal)),
        origin: { kind: "unreviewed-item", exclusion: { code: "EXPORT_UNDECIDED", fieldPath: exclusion.fieldPath, itemNames: exclusion.itemNames } },
      });
    });
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

type ImportRecord = NonNullable<ReturnType<typeof restoreReviewedExtractionEvidence>>["importRecord"];
type Proposal = ImportRecord["spec"]["envelope"]["result"]["proposals"][number];

/** The parts of `reviewRound` this projection reads; the rest of the scope passes through untouched. */
const reviewRoundView = z.object({
  revision: z.number().int().nonnegative(),
  complete: z.boolean(),
  excluded: z.array(z.object({ fieldPath: z.string(), itemNames: z.array(z.string()), code: z.string() })).default([]),
  decisions: z.array(z.object({ claimId: z.string() }).passthrough()).default([]),
  groundingRefused: z.array(z.object({ claimId: z.string(), gaps: z.array(z.string()) }).passthrough()).default([]),
}).passthrough();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * The source fields, from the proposal as Traverse recorded it. The source is
 * also the speaker: Fieldwork knows no author, and naming the snapshot keeps
 * each snapshot's authority its own.
 */
function sourceOf(record: ImportRecord, proposal: Proposal): { readonly source: FieldworkMemoryClaim["source"]; readonly speaker: string } {
  const { source, result } = record.spec.envelope;
  const ref = source.snapshotRef ?? source.ref;
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
 * digest; the Kit's ordering of `supersedes` and `audience` does not apply
 * because neither is emitted. test/memory-source.test.ts pins ids the Kit's own
 * builder produced.
 */
export function memoryClaimId(claim: Omit<FieldworkMemoryClaim, "id">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(claim)).digest("hex")}`;
}

function memoryClaim(
  fields: Pick<FieldworkMemoryClaim, "subject" | "claimType" | "property" | "value" | "posture">,
  from: { readonly source: FieldworkMemoryClaim["source"]; readonly speaker: string },
): FieldworkMemoryClaim {
  const content = { schema_version: "1.0" as const, ...fields, speaker: from.speaker, source: from.source };
  return { id: memoryClaimId(content), ...content };
}
