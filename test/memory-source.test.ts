import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { evaluateReviewedGroundingPolicy, projectReviewedExtractionEvidence, resolverFromBundle, restoreReviewedExtractionEvidence, reviewedExtractionEvidenceChoiceProfile } from "@kontourai/surface";
import { reviewedGroundingPolicy } from "../src/reviewed-evidence.js";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1, ReviewedExportV1 } from "../src/api-contracts.js";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { MEMORY_CLAIM_SCHEMA_PIN, memoryClaimId, memoryClaimsFromReviewedExport, type MemorySourceProjection } from "../src/memory-source.js";
import { openRun } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";
import { conflictRun } from "./helpers/conflict-run.js";
import { buildReviewSessionEvents } from "@kontourai/survey/review-workbench";
import { decide, decidedMixedRun, forgedUnverifiedConflictRun, indexedItemsRun, mixedRun, queueOf, snapshotRun } from "./helpers/memory-source-run.js";
import { typedFieldRun } from "./helpers/real-run.js";

/*
 * kontourai/fieldwork#205: a reviewed export as a memory source. Every export
 * here is written by the real run -> Survey events -> `reviewedExport` path.
 *
 * The memory claims follow the Knowledge Kit schema pinned in
 * MEMORY_CLAIM_SCHEMA_PIN, which Fieldwork does not copy. The ids below are the
 * ones the Kit's own `memoryClaim` builder produced for these claims at that
 * commit, and the Kit's `assertMemoryClaim` accepted every claim. Reproduce
 * with the procedure in docs/memory-source.md.
 */

const FIXED_OBSERVED_AT = "2026-01-01T00:00:00.000Z";
/** The Kit's own `memoryClaim(...).id` for each claim below, with `source.observedAt` fixed (a run's extraction time differs per run). */
const KIT_IDS = {
  alpha: "sha256:4d18d10d307357ae7d72099d789e677084fe68b3c36addd209721d510cdf4205",
  charlie: "sha256:64bec28e1013ac8c9e325108b53dc8daf2dfd52b16f86f214d10e239609fdb8d",
  delta: "sha256:7929bb0a0f5c60412f30c43e6148573dc71832e2fcd4226c82be965804828450",
  statusActive: "sha256:2a742a3427851ab684f62dadcd1881662d2292b65e3c79b15543d73a3ce420cc",
  statusPaused: "sha256:cd97eff803912b8eeaf40ecb0b08bb025d2d45b536c46991e8f748aee072ded0",
};

/** Every top-level key of the pinned schema this mapping may fill; the schema forbids any other. */
const SCHEMA_KEYS = ["schema_version", "id", "subject", "claimType", "property", "value", "speaker", "source", "posture"];
const SOURCE_KEYS = ["ref", "locator", "excerpt", "observedAt", "extractor"];

interface Bundle {
  claims: { id: string; fieldOrBehavior: string; value: unknown; status: string; subjectType: string; subjectId: string; claimType: string }[];
  evidence: { claimId: string; evidenceType: string; observedAt: string; sourceRef: string; sourceLocator: string; excerptOrSummary: string; metadata?: Record<string, unknown> }[];
}
interface Scope { revision: number; complete: boolean; excluded: { fieldPath: string; itemNames: string[]; code: string }[]; decisions: { claimId: string; reviewItemName: string; actor: { id: string } }[] }

const byProperty = (projection: MemorySourceProjection, property: string) => projection.claims.filter((entry) => entry.claim.property === property);
const one = (projection: MemorySourceProjection, property: string) => {
  const found = byProperty(projection, property);
  assert.equal(found.length, 1, `${property}: ${found.length} claims`);
  return found[0]!;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("a mixed round maps reviewed claims as reviewed and unreviewed items as proposed, and the round trips back to the export", async () => {
  const exported = await reviewedExport(await decidedMixedRun("round-trip"));
  const projection = memoryClaimsFromReviewedExport(exported);
  const bundle = exported.bundle as unknown as Bundle;
  const scope = exported.reviewRound as unknown as Scope;

  // The arrival each property gets, and the id the Kit gives the same claim. Every claim is posture `stated`.
  const kitIdOf = (entry: MemorySourceProjection["claims"][number]) => {
    const { id: _id, ...content } = entry.claim;
    assert.equal(entry.claim.id, memoryClaimId(content), "the id is the digest of the claim as emitted");
    return memoryClaimId({ ...content, source: { ...content.source, observedAt: FIXED_OBSERVED_AT } });
  };
  assert.deepEqual(
    projection.claims.map((entry) => [entry.claim.property, entry.claim.value, entry.arrival, entry.claim.posture, kitIdOf(entry)]),
    [
      ["record.alpha", "alpha-value", "reviewed", "stated", KIT_IDS.alpha],
      ["record.charlie", "charlie-value", "reviewed", "stated", KIT_IDS.charlie],
      ["record.delta", "delta-value", "proposed", "stated", KIT_IDS.delta],
      ["record.status", "Active", "proposed", "stated", KIT_IDS.statusActive],
      ["record.status", "Paused", "proposed", "stated", KIT_IDS.statusPaused],
    ],
  );

  // Round trip: what the export said about each field is what the claims say, derived from the export
  // itself and not from the constants above. Verified claims arrive reviewed, undecided items proposed,
  // and a rejected claim is not remembered at all.
  const fromExport = new Map<string, string>();
  for (const claim of bundle.claims) if (claim.status === "verified") fromExport.set(claim.fieldOrBehavior, "reviewed");
  for (const exclusion of scope.excluded) {
    assert.equal(exclusion.code, "EXPORT_UNDECIDED");
    fromExport.set(exclusion.fieldPath, "proposed");
  }
  assert.deepEqual(
    new Map(projection.claims.map((entry) => [entry.claim.property, entry.arrival])),
    fromExport,
  );
  assert.deepEqual(
    projection.withheld.map((item) => [item.reason, item.fieldPath, item.surfaceClaimId]),
    [["rejected-in-review", "record.bravo", bundle.claims.find((claim) => claim.status === "rejected")!.id]],
  );
  assert.equal(projection.reviewRound.revision, scope.revision);
  assert.equal(projection.reviewRound.complete, false);

  // The reviewed claim's grounding is the export's own evidence, not a re-derivation.
  const alpha = one(projection, "record.alpha");
  const surfaceAlpha = bundle.claims.find((claim) => claim.fieldOrBehavior === "record.alpha")!;
  const evidence = bundle.evidence.find((entry) => entry.claimId === surfaceAlpha.id && entry.evidenceType === "source_excerpt")!;
  assert.equal(alpha.claim.source.ref, evidence.sourceRef);
  assert.equal(alpha.claim.source.locator, evidence.sourceLocator);
  assert.equal(alpha.claim.source.excerpt, evidence.excerptOrSummary);
  assert.deepEqual(alpha.claim.subject, { type: surfaceAlpha.subjectType, id: surfaceAlpha.subjectId });
  assert.equal(alpha.claim.claimType, surfaceAlpha.claimType);
  assert.equal(alpha.claim.source.observedAt, evidence.observedAt, "the extraction time the export carries, before the golden ids fix it");

  // The review facts travel verbatim beside the claim.
  assert.equal(alpha.origin.kind, "reviewed-claim");
  assert.ok(alpha.origin.kind === "reviewed-claim");
  assert.equal(alpha.origin.surfaceClaimId, surfaceAlpha.id);
  assert.equal(alpha.origin.surfaceStatus, "verified");
  assert.equal(alpha.origin.reviewDecision.status, "verified");
  assert.equal((alpha.origin.attribution as { claimId: string }).claimId, surfaceAlpha.id);
  const delta = one(projection, "record.delta");
  assert.ok(delta.origin.kind === "unreviewed-item");
  assert.equal(delta.origin.exclusion.code, "EXPORT_UNDECIDED");
  assert.deepEqual(delta.origin.exclusion.itemNames, scope.excluded.find((entry) => entry.fieldPath === "record.delta")!.itemNames);

  // Only fields the pinned schema defines; the unreviewed claims are grounded like the reviewed ones.
  for (const { claim } of projection.claims) {
    assert.deepEqual(Object.keys(claim).filter((key) => !SCHEMA_KEYS.includes(key)), []);
    assert.deepEqual(Object.keys(claim.source).filter((key) => !SOURCE_KEYS.includes(key)), []);
    assert.equal(claim.schema_version, "1.0");
    assert.match(claim.source.locator, /^chars:\d+-\d+$/);
    assert.notEqual(claim.source.excerpt, "");
  }
  assert.equal(one(projection, "record.delta").claim.source.excerpt, "delta: delta-value");
  assert.deepEqual(projection.mapping, MEMORY_CLAIM_SCHEMA_PIN);
});

test("the two proposals of an undecided conflict arrive as two proposed claims, never as one value", async () => {
  const projection = memoryClaimsFromReviewedExport(await reviewedExport(await decidedMixedRun("undecided-conflict")));
  const status = byProperty(projection, "record.status");
  assert.deepEqual(status.map((entry) => [entry.claim.value, entry.arrival, entry.claim.source.excerpt]), [
    ["Active", "proposed", "Status: Active"],
    ["Paused", "proposed", "Status: Paused"],
  ]);
  assert.notEqual(status[0]!.claim.source.locator, status[1]!.claim.source.locator);
});

test("a chosen conflict value arrives reviewed on its own span, and the rival is not remembered", async () => {
  const run = await conflictRun("memory-chosen");
  const service = await openRun(run);
  let snapshot: ReviewQueueSessionState;
  try {
    snapshot = (await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1).review.snapshot as unknown as ReviewQueueSessionState;
  } finally { await service.close(); }
  const conflict = snapshot.items.find((item) => item.spec.candidates.length > 1)!;
  const [rival, chosen] = conflict.spec.candidates;
  assert.deepEqual([rival!.value, chosen!.value], ["Active", "Paused"]);
  await decide(run, {
    [conflict.metadata.name]: "select-proposed",
    ...Object.fromEntries(snapshot.items.filter((item) => item !== conflict).map((item) => [item.metadata.name, "accept-proposed"])),
  }, { [conflict.metadata.name]: chosen!.id });

  const projection = memoryClaimsFromReviewedExport(await reviewedExport(run));
  const status = one(projection, "record.status");
  assert.equal(status.claim.value, "Paused");
  assert.equal(status.arrival, "reviewed");
  assert.equal(status.claim.source.excerpt, "Status: Paused");
  assert.equal(projection.claims.some((entry) => entry.claim.value === "Active"), false);
  assert.equal(one(projection, "record.alpha").arrival, "reviewed");
  assert.deepEqual(projection.withheld, []);
});

test("a reviewed claim whose grounding the export refused arrives as proposed, with the export's gaps", async () => {
  const run = await typedFieldRun("memory-date-only", { versionAsNumber: true });
  const items = await queueOf(run);
  await decide(run, Object.fromEntries(items.map((item) => [item.name, "accept-proposed"])));
  const exported = await reviewedExport(run);
  const surfaceDate = (exported.bundle as unknown as Bundle).claims.find((claim) => claim.fieldOrBehavior === "doc.publicationDate")!;
  assert.equal(surfaceDate.status, "disputed");

  const projection = memoryClaimsFromReviewedExport(exported);
  const date = one(projection, "doc.publicationDate");
  assert.equal(date.arrival, "proposed");
  assert.ok(date.origin.kind === "reviewed-claim");
  assert.equal(date.origin.surfaceStatus, "disputed");
  assert.equal(date.origin.reviewDecision.status, "verified", "the reviewer accepted it; the export still disputes it");
  assert.deepEqual(date.origin.groundingGaps, ["schema-mismatch"]);
  assert.equal(projection.claims.filter((entry) => entry.arrival === "reviewed").length, 2);
});

test("source authority stays per source: the same field and value from two snapshots never share an identity", async () => {
  const first = memoryClaimsFromReviewedExport(await reviewedExport(await decidedMixedRun("source-a")));
  const second = memoryClaimsFromReviewedExport(await reviewedExport(await decidedMixedRun("source-b", "trailer: a second snapshot\n")));
  const [a, b] = [one(first, "record.alpha"), one(second, "record.alpha")];
  assert.deepEqual([a.claim.subject, a.claim.claimType, a.claim.property, a.claim.value], [b.claim.subject, b.claim.claimType, b.claim.property, b.claim.value]);
  assert.notEqual(a.claim.source.ref, b.claim.source.ref);
  assert.notEqual(a.claim.speaker, b.claim.speaker);
  assert.notEqual(a.claim.id, b.claim.id);
  for (const projection of [first, second]) {
    assert.equal(new Set(projection.claims.map((entry) => entry.claim.source.ref)).size, 1, "one export covers one source");
    for (const { claim } of projection.claims) assert.equal(claim.speaker, claim.source.ref);
  }
  assert.equal(first.claims.every((entry) => entry.claim.source.ref.startsWith("fieldwork-source:v1:")), true);
});

test("an export edited after the fact is mapped conservatively and every omission is reported", async () => {
  const honest = await reviewedExport(await decidedMixedRun("edited"));
  const edit = (change: (bundle: Bundle, scope: Scope) => void, evidenceRemoved = false): MemorySourceProjection => {
    const copy = clone(honest) as unknown as { bundle: Bundle; reviewRound: Scope; reviewedGrounding: unknown } & ReviewedExportV1;
    change(copy.bundle, copy.reviewRound);
    // Removing evidence while the receipt still carries what it yielded is a partial edit; these cases remove both.
    if (evidenceRemoved) rebindReceipt(copy);
    return memoryClaimsFromReviewedExport(copy);
  };
  const propertiesOf = (projection: MemorySourceProjection) => projection.claims.map((entry) => entry.claim.property);

  // A status Fieldwork never writes is not read as verified.
  const stale = edit((bundle) => { bundle.claims.find((claim) => claim.fieldOrBehavior === "record.alpha")!.status = "stale"; });
  assert.equal(propertiesOf(stale).includes("record.alpha"), false);
  assert.deepEqual(stale.withheld.filter((item) => item.reason === "unsupported-status").map((item) => [item.fieldPath, item.detail]), [["record.alpha", "stale"]]);

  // A claim with no reviewed-extraction evidence has no Survey decision to carry, so it is not stated.
  const bare = edit((bundle) => {
    const charlie = bundle.claims.find((claim) => claim.fieldOrBehavior === "record.charlie")!;
    bundle.evidence = bundle.evidence.filter((entry) => !(entry.claimId === charlie.id && entry.metadata?.reviewedExtraction));
  }, true);
  assert.equal(propertiesOf(bare).includes("record.charlie"), false);
  assert.deepEqual(bare.withheld.filter((item) => item.reason === "no-reviewed-evidence").map((item) => item.fieldPath), ["record.charlie"]);

  // With no evidence at all there is no import record, so no undecided item can be recovered either.
  const none = edit((bundle) => { bundle.evidence = bundle.evidence.filter((entry) => !entry.metadata?.reviewedExtraction); }, true);
  assert.deepEqual(none.claims, []);
  assert.equal(none.withheld.filter((item) => item.reason === "no-import-record").length, 2);

  // Removing a claim's evidence but leaving what the receipt records for it is a partial edit.
  assert.throws(() => edit((bundle) => {
    const charlie = bundle.claims.find((claim) => claim.fieldOrBehavior === "record.charlie")!;
    bundle.evidence = bundle.evidence.filter((entry) => !(entry.claimId === charlie.id && entry.metadata?.reviewedExtraction));
  }), /grounding receipt records a dimension for .* that its own evidence does not yield/);

  // An undecided item the import record does not hold is an export that disagrees with itself.
  assert.throws(() => edit((_bundle, scope) => { scope.excluded.find((entry) => entry.fieldPath === "record.delta")!.itemNames = ["extraction-envelope.not-an-item"]; }), /holds no such review item/);

  // An exclusion for any reason but "no one decided it" is not an unreviewed item.
  const conflicting = edit((_bundle, scope) => { scope.excluded.find((entry) => entry.fieldPath === "record.delta")!.code = "EXPORT_CONFLICTING_DECISIONS"; });
  assert.equal(propertiesOf(conflicting).includes("record.delta"), false);
  assert.deepEqual(conflicting.withheld.filter((item) => item.reason === "excluded-after-review").map((item) => [item.fieldPath, item.detail]), [["record.delta", "EXPORT_CONFLICTING_DECISIONS"]]);
});

test("a proposal Survey excluded for an unverifiable excerpt is not remembered, and the verified one beside it arrives proposed", async () => {
  const run = await forgedUnverifiedConflictRun("memory-unverified");
  const items = await queueOf(run);
  await decide(run, { [items.find((item) => item.fieldPath === "record.alpha")!.name]: "accept-proposed" });
  const exported = await reviewedExport(run);
  assert.deepEqual((exported.reviewRound as unknown as Scope).excluded.map((entry) => [entry.fieldPath, entry.code]), [["record.status", "EXPORT_UNDECIDED"]]);

  const projection = memoryClaimsFromReviewedExport(exported);
  assert.deepEqual(byProperty(projection, "record.status").map((entry) => [entry.claim.value, entry.arrival, entry.claim.source.excerpt]), [["Paused", "proposed", "Status: Paused"]]);
  assert.equal(projection.claims.some((entry) => entry.claim.value === "Actiff"), false);
  assert.deepEqual(projection.withheld.map((item) => [item.reason, item.fieldPath]), [["excerpt-not-verified", "record.status"]]);
  assert.equal(one(projection, "record.alpha").arrival, "reviewed");
});

test("an undecided item brings only its own proposals: a rejected sibling on the same field is not remembered", async () => {
  const run = await indexedItemsRun("memory-indexed-rejected");
  const queue = await queueOf(run);
  const [first, second] = queue.filter((item) => item.fieldPath === "record.items[]");
  assert.equal(first!.fieldPath, second!.fieldPath, "the siblings share a field");
  await decide(run, { [queue.find((item) => item.fieldPath === "record.status")!.name]: "accept-proposed", [first!.name]: "reject-proposed" });
  const exported = await reviewedExport(run);
  const scope = exported.reviewRound as unknown as Scope;
  // The export lists the undecided sibling by item, and the decided one as unsettled because its field is not.
  assert.deepEqual(scope.excluded.map((entry) => [entry.code, entry.itemNames]), [["EXPORT_UNDECIDED", [second!.name]], ["EXPORT_FIELD_UNSETTLED", [first!.name]]]);

  const projection = memoryClaimsFromReviewedExport(exported);
  assert.deepEqual(byProperty(projection, "record.items[]").map((entry) => [entry.claim.value, entry.arrival]), [["two", "proposed"]]);
  assert.deepEqual(projection.withheld.map((item) => [item.reason, item.detail]), [["excluded-after-review", "EXPORT_FIELD_UNSETTLED"]]);
  assert.equal(projection.claims.some((entry) => entry.claim.value === "one"), false, "the rejected sibling is not a proposal");
});

test("two undecided siblings on one field each arrive once, and no two claims share an id", async () => {
  const run = await indexedItemsRun("memory-indexed-undecided");
  const queue = await queueOf(run);
  await decide(run, { [queue.find((item) => item.fieldPath === "record.status")!.name]: "accept-proposed" });
  const projection = memoryClaimsFromReviewedExport(await reviewedExport(run));
  assert.deepEqual(byProperty(projection, "record.items[]").map((entry) => entry.claim.value), ["one", "two"]);
  assert.equal(new Set(projection.claims.map((entry) => entry.claim.id)).size, projection.claims.length);
});

test("undecided items still arrive when the only decided claim is a rejected one", async () => {
  const run = await mixedRun("memory-only-rejected");
  const queue = await queueOf(run);
  await decide(run, { [queue.find((item) => item.fieldPath === "record.alpha")!.name]: "reject-proposed" });
  const projection = memoryClaimsFromReviewedExport(await reviewedExport(run));
  assert.deepEqual(projection.claims.map((entry) => [entry.claim.property, entry.arrival]).sort(), [
    ["record.bravo", "proposed"], ["record.charlie", "proposed"], ["record.delta", "proposed"],
    ["record.status", "proposed"], ["record.status", "proposed"],
  ]);
  assert.deepEqual(projection.withheld.map((item) => item.reason), ["rejected-in-review"]);
});

/** The export a test edits: bundle, receipt and round scope as plain JSON. */
type Editable = ReviewedExportV1 & {
  bundle: Bundle & { events: { id: string; claimId: string; status: string; createdAt: string }[] };
  reviewedGrounding: { gaps: { kind: string; claimId?: string }[] };
  reviewRound: Scope & { groundingRefused: { claimId: string; gaps: string[] }[] };
};
const editable = (honest: ReviewedExportV1): Editable => clone(honest) as unknown as Editable;
const claimNamed = (copy: Editable, field: string) => copy.bundle.claims.find((claim) => claim.fieldOrBehavior === field)!;
/**
 * Set a claim's status where every record that states it agrees (the claim, its latest event, the grounding receipt
 * and the refusal list), so a test can then break exactly one rule.
 */
const settle = (copy: Editable, field: string, status: string) => {
  const claim = claimNamed(copy, field);
  claim.status = status;
  // A dispute is a later event beside the review event: promoting the claim removes it, rewriting the rest.
  if (status === "verified") copy.bundle.events = copy.bundle.events.filter((event) => !(event.claimId === claim.id && event.status === "disputed"));
  copy.bundle.events.filter((event) => event.claimId === claim.id).forEach((event) => { event.status = status; });
  copy.reviewedGrounding.gaps = (copy.reviewedGrounding.gaps ?? []).filter((gap) => gap.claimId !== claim.id);
  copy.reviewRound.groundingRefused = (copy.reviewRound.groundingRefused ?? []).filter((entry) => entry.claimId !== claim.id);
};
const refuses = (copy: Editable, message: RegExp) => assert.throws(() => memoryClaimsFromReviewedExport(copy), message);
/** What a promoted claim arrives as: not refused, and never `reviewed` while anything the export carries casts doubt on it. */
const arrivalOf = (copy: Editable, field: string): string | undefined => memoryClaimsFromReviewedExport(copy).claims.find((entry) => entry.claim.property === field)?.arrival;
/**
 * After a test replaces evidence (re-projected through Surface so its digest binding is valid), carry the receipt
 * dimensions that evidence yields, so only the rule under test can refuse the export.
 */
const rebindReceipt = (copy: { bundle: Bundle; reviewedGrounding: unknown }): void => {
  const evidence = copy.bundle.evidence.filter((entry) => entry.metadata?.reviewedExtraction !== undefined) as never[];
  (copy.reviewedGrounding as { dimensions: unknown }).dimensions = evidence.length === 0 ? [] : JSON.parse(JSON.stringify(evaluateReviewedGroundingPolicy({
    policy: reviewedGroundingPolicy(copy.bundle.claims.map((claim) => claim.id)),
    evidence,
    claims: copy.bundle.claims.map((claim) => ({ id: claim.id, value: claim.value })),
    resolveImportRecord: resolverFromBundle({ evidence }),
  }).dimensions));
};

test("a bundle claim that disagrees with the Survey decision its evidence carries is refused, not mapped", async () => {
  const honest = await reviewedExport(await decidedMixedRun("disagree"));
  // Evidence is digest-bound; the bundle claim beside it is not.
  const value = editable(honest);
  claimNamed(value, "record.alpha").value = "NOT THE ACCEPTED VALUE";
  refuses(value, /not the one its Survey decision accepted/);
  const accepted = editable(honest);
  settle(accepted, "record.bravo", "verified");
  refuses(accepted, /stated as accepted but its Survey decision is rejected/);
  const rejected = editable(honest);
  settle(rejected, "record.alpha", "rejected");
  refuses(rejected, /rejected but its Survey decision is verified/);
});

test("evidence moved onto another claim is refused by Surface's integrity binding", async () => {
  const copy = clone(await reviewedExport(await decidedMixedRun("moved-evidence"))) as unknown as ReviewedExportV1 & { bundle: Bundle };
  const [alpha, charlie] = ["record.alpha", "record.charlie"].map((field) => copy.bundle.claims.find((claim) => claim.fieldOrBehavior === field)!);
  copy.bundle.evidence.find((entry) => entry.claimId === alpha!.id && entry.metadata?.reviewedExtraction)!.claimId = charlie!.id;
  assert.throws(() => memoryClaimsFromReviewedExport(copy), /integrity binding is invalid/);
});

test("a claim that disagrees with its decision, its events or the grounding receipt is refused, whichever record was edited", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("disagree-more"));
  const typedRun = await typedFieldRun("memory-disagree-typed", { versionAsNumber: true });
  await decide(typedRun, Object.fromEntries((await queueOf(typedRun)).map((item) => [item.name, "accept-proposed"])));
  const typed = await reviewedExport(typedRun);
  assert.deepEqual((typed.bundle as unknown as Bundle).claims.filter((claim) => claim.status === "disputed").map((claim) => claim.fieldOrBehavior), ["doc.publicationDate"]);

  // The claim target is part of what the reviewer accepted.
  for (const [key, value] of [["subjectType", "other"], ["subjectId", "someone-else"], ["claimType", "other"], ["fieldOrBehavior", "record.other"]] as const) {
    const copy = editable(mixed);
    (claimNamed(copy, "record.alpha") as unknown as Record<string, unknown>)[key] = value;
    refuses(copy, /claim target (other than the one its Survey decision accepted|its import record does not declare)/);
  }

  // The status has to match the claim's latest event.
  const verifiedToDisputed = editable(typed);
  claimNamed(verifiedToDisputed, "doc.title").status = "disputed";
  refuses(verifiedToDisputed, /latest event says verified/);
  const rejectedToVerified = editable(mixed);
  rejectedToVerified.bundle.events.find((event) => event.claimId === claimNamed(rejectedToVerified, "record.bravo").id)!.status = "verified";
  refuses(rejectedToVerified, /latest event says verified/);
  // Events tie: Surface takes the first of equal times, so an earlier tied dispute wins over the verification.
  const tie = editable(mixed);
  const alphaEvent = tie.bundle.events.find((event) => event.claimId === claimNamed(tie, "record.alpha").id)!;
  tie.bundle.events.unshift({ ...alphaEvent, id: `${alphaEvent.id}.tied`, status: "disputed" });
  refuses(tie, /latest event says disputed/);
  // Editing status, refusal list and receipt together still disagrees with the events.
  const coordinated = editable(typed);
  const date = claimNamed(coordinated, "doc.publicationDate");
  const events = coordinated.bundle.events.filter((event) => event.claimId === date.id);
  date.status = "verified";
  coordinated.reviewedGrounding.gaps = coordinated.reviewedGrounding.gaps.filter((gap) => gap.claimId !== date.id);
  coordinated.reviewRound.groundingRefused = [];
  assert.equal(events.at(-1)!.status, "disputed");
  refuses(coordinated, /latest event says disputed/);

  // The receipt: a promotion that also rewrites the claim, its event and the refusal list is contradicted by it.
  const promoted = editable(typed);
  settle(promoted, "doc.publicationDate", "verified");
  promoted.reviewedGrounding.gaps = clone(typed.reviewedGrounding.gaps) as never;
  assert.equal(arrivalOf(promoted, "doc.publicationDate"), "proposed", "the receipt still records the gap");
  const gapsOf = (copy: Editable) => memoryClaimsFromReviewedExport(copy).claims.find((entry) => entry.claim.property === "doc.publicationDate")!.origin;
  assert.ok(gapsOf(promoted).kind === "reviewed-claim" && (gapsOf(promoted) as { groundingGaps?: string[] }).groundingGaps?.includes("schema-mismatch"), "and says which");
  // A refusal the receipt does not record, or for a claim that is not disputed or does not exist.
  const unrecorded = editable(typed);
  unrecorded.reviewRound.groundingRefused[0]!.gaps.push("hidden-conflict");
  refuses(unrecorded, /but its grounding receipt records schema-mismatch for it/);
  const wrongClaim = editable(typed);
  wrongClaim.reviewRound.groundingRefused.push({ claimId: claimNamed(wrongClaim, "doc.title").id, gaps: ["schema-mismatch"] });
  refuses(wrongClaim, /not a disputed claim of its bundle/);
  const nonexistent = editable(typed);
  nonexistent.reviewRound.groundingRefused.push({ claimId: "extraction-envelope.nothing.claim", gaps: ["schema-mismatch"] });
  refuses(nonexistent, /not a disputed claim of its bundle/);
  // A disputed claim with no refusal at all (receipt cleared too) is not one Fieldwork disputed.
  const unlisted = editable(typed);
  unlisted.reviewedGrounding.gaps = [];
  unlisted.reviewRound.groundingRefused = [];
  refuses(unlisted, /disagrees with the export's grounding refusals/);

  // A decision that was held is not an accepted one, whatever its status says. The evidence is re-projected
  // through Surface so its digest binding is valid: only Fieldwork's own check can refuse it.
  const held = editable(mixed);
  const heldIndex = held.bundle.evidence.findIndex((item) => item.claimId === claimNamed(held, "record.alpha").id && item.metadata?.reviewedExtraction);
  const heldInput = restoreReviewedExtractionEvidence(held.bundle.evidence[heldIndex] as never);
  (heldInput.reviewDecision!.spec as { resolution?: string }).resolution = "held";
  held.bundle.evidence[heldIndex] = projectReviewedExtractionEvidence(heldInput).evidence as never;
  rebindReceipt(held);
  refuses(held, /stated as accepted but its Survey decision is held/);

  // Two evidence entries for one claim are two decisions: neither may silently win.
  const doubled = editable(mixed);
  const alpha = claimNamed(doubled, "record.alpha");
  const original = doubled.bundle.evidence.find((item) => item.claimId === alpha.id && item.metadata?.reviewedExtraction)!;
  const second = restoreReviewedExtractionEvidence(original as never);
  second.evidenceId = `${second.evidenceId}.second`;
  (second.reviewDecision!.spec as { status: string }).status = "rejected";
  doubled.bundle.evidence.unshift(projectReviewedExtractionEvidence(second).evidence as never);
  rebindReceipt(doubled);
  refuses(doubled, /more than one reviewed-extraction evidence entry/);
});

test("the receipt's dispositions and invalid structure, the review events and the attribution time all have to agree with the decision", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("provenance"));
  const typedRun = await typedFieldRun("memory-invalid-structure");
  await decide(typedRun, Object.fromEntries((await queueOf(typedRun)).map((item) => [item.name, "accept-proposed"])));
  const typed = await reviewedExport(typedRun);

  // Structure Surface checked and found invalid is a mismatch, not an unchecked value: promoting the claim by
  // removing only the synthetic schema-mismatch gap leaves the receipt's own invalid-structure gap against it.
  const version = (typed.bundle as unknown as Bundle).claims.find((claim) => claim.fieldOrBehavior === "doc.versionNumber")!;
  assert.equal(version.status, "disputed");
  const invalid = editable(typed);
  assert.ok(invalid.reviewedGrounding.gaps.some((gap) => gap.claimId === version.id && gap.kind === "structure-not-validated"), "the receipt carries the invalid-structure gap");
  settle(invalid, "doc.versionNumber", "verified");
  invalid.reviewedGrounding.gaps = typed.reviewedGrounding.gaps.filter((gap) => !(gap.claimId === version.id && gap.kind === "schema-mismatch")) as never;
  invalid.reviewRound.groundingRefused = invalid.reviewRound.groundingRefused.filter((entry) => entry.claimId !== version.id);
  assert.equal(arrivalOf(invalid, "doc.versionNumber"), "proposed", "the receipt still records invalid structure");
  // A refusal has to list exactly the gaps the receipt records for its claim, no fewer.
  const fewer = editable(typed);
  fewer.reviewRound.groundingRefused.find((entry) => entry.claimId === version.id)!.gaps = ["schema-mismatch"];
  refuses(fewer, /but its grounding receipt records .* for it/);

  // The receipt's per-claim review disposition is the decision's.
  const accepted = editable(mixed);
  (accepted.reviewedGrounding as unknown as { dimensions: { claimId: string; reviewDisposition: string }[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(accepted, "record.alpha").id)!.reviewDisposition = "rejected";
  refuses(accepted, /grounding receipt records a dimension for .* that its own evidence does not yield/);
  const rejected = editable(mixed);
  (rejected.reviewedGrounding as unknown as { dimensions: { claimId: string; reviewDisposition: string }[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(rejected, "record.bravo").id)!.reviewDisposition = "verified";
  refuses(rejected, /grounding receipt records a dimension for .* that its own evidence does not yield/);

  // The review event is by the actor the decision names, and the attribution carries the decision's time.
  const actor = editable(mixed);
  (actor.bundle.events.find((event) => event.claimId === claimNamed(actor, "record.alpha").id) as unknown as { actor: string }).actor = "someone-else";
  refuses(actor, /review event by another actor/);
  const time = editable(mixed);
  (time.reviewRound.decisions.find((entry) => entry.claimId === claimNamed(time, "record.alpha").id) as unknown as { decidedAt: string }).decidedAt = "2000-01-01T00:00:00.000Z";
  refuses(time, /no round attribution that names the review item, actor and time/);

  // A rejected claim states the target and value of the proposal it rejected.
  const retargeted = editable(mixed);
  claimNamed(retargeted, "record.bravo").fieldOrBehavior = "record.alpha";
  refuses(retargeted, /claim target (other than the one its Survey decision accepted|its import record does not declare)/);
  const revalued = editable(mixed);
  claimNamed(revalued, "record.bravo").value = "NOT THE REJECTED VALUE";
  refuses(revalued, /not the one its Survey decision rejected/);

  // Equal event times are equal however they are written; Surface takes the first listed.
  const spelled = editable(mixed);
  const event = spelled.bundle.events.find((entry) => entry.claimId === claimNamed(spelled, "record.alpha").id)!;
  spelled.bundle.events.unshift({ ...event, id: `${event.id}.spelled`, status: "disputed", createdAt: event.createdAt.replace(/Z$/, "+00:00") });
  refuses(spelled, /latest event says disputed/);

  // One review item is decided once, whichever claim the attribution names.
  const twice = editable(mixed);
  const alphaAttribution = twice.reviewRound.decisions.find((entry) => entry.claimId === claimNamed(twice, "record.alpha").id)!;
  twice.reviewRound.decisions.find((entry) => entry.claimId === claimNamed(twice, "record.charlie").id)!.reviewItemName = alphaAttribution.reviewItemName;
  refuses(twice, /more than one decision/);
  // A receipt gap with two addresses is about both claims: moving its claim id onto another claim leaves the evidence
  // address on the first, so both are doubted rather than one being cleared.
  const moved = editable(typed);
  const date = claimNamed(moved, "doc.publicationDate");
  moved.reviewedGrounding.gaps.forEach((gap) => { if (gap.claimId === date.id) gap.claimId = claimNamed(moved, "doc.title").id; });
  assert.equal(arrivalOf(moved, "doc.publicationDate"), "proposed");
  assert.equal(arrivalOf(moved, "doc.title"), "proposed");
});

test("whether a claim is grounded is recomputed from its evidence, so editing the records beside it cannot promote or demote it", async () => {
  const typedRun = await typedFieldRun("memory-recompute");
  await decide(typedRun, Object.fromEntries((await queueOf(typedRun)).map((item) => [item.name, "accept-proposed"])));
  const typed = await reviewedExport(typedRun);
  const mixed = await reviewedExport(await decidedMixedRun("recompute"));
  const forgedRun = await forgedUnverifiedConflictRun("memory-recompute-rival");
  await decide(forgedRun, Object.fromEntries((await queueOf(forgedRun)).map((item) => [item.name, "accept-proposed"])));
  const rival = await reviewedExport(forgedRun);

  // Promotion: claim, event, receipt gaps and refusal all say verified; only the evidence still says otherwise.
  for (const [honest, field] of [[typed, "doc.versionNumber"], [typed, "doc.publicationDate"], [rival, "record.status"]] as const) {
    assert.equal(claimNamed(editable(honest), field).status, "disputed", field);
    const promoted = editable(honest);
    settle(promoted, field, "verified");
    assert.equal(arrivalOf(promoted, field), "proposed", field);
  }
  // Structure Surface found invalid disputes a claim even when Traverse's schema match for the proposal says ok. The
  // evidence is re-projected through Surface so its digest binding is valid: only the recomputation can refuse it.
  const invalid = editable(mixed);
  const alphaIndex = invalid.bundle.evidence.findIndex((item) => item.claimId === claimNamed(invalid, "record.alpha").id && item.metadata?.reviewedExtraction);
  const alphaInput = restoreReviewedExtractionEvidence(invalid.bundle.evidence[alphaIndex] as never);
  alphaInput.structuralTrust = "invalid";
  invalid.bundle.evidence[alphaIndex] = projectReviewedExtractionEvidence(alphaInput).evidence as never;
  rebindReceipt(invalid);
  assert.equal(arrivalOf(invalid, "record.alpha"), "proposed");
  // Demotion: an honest claim cannot be made disputed with an empty (or structural-only) refusal.
  const demoted = editable(mixed);
  settle(demoted, "record.alpha", "disputed");
  demoted.reviewRound.groundingRefused.push({ claimId: claimNamed(demoted, "record.alpha").id, gaps: [] });
  refuses(demoted, /nothing it carries casts doubt on its grounding/);
});

test("a receipt dimension is checked by its evidence as well as its claim, and names a claim the export has", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("dimensions"));
  const dimensions = (copy: Editable) => (copy.reviewedGrounding as unknown as { dimensions: { claimId: string; evidenceId?: string; reviewDisposition: string }[] }).dimensions;
  const nonexistent = editable(mixed);
  dimensions(nonexistent).find((dimension) => dimension.claimId === claimNamed(nonexistent, "record.alpha").id)!.claimId = "extraction-envelope.nothing.claim";
  refuses(nonexistent, /records a dimension for extraction-envelope.nothing.claim that its own evidence does not yield/);
  const moved = editable(mixed);
  const alpha = dimensions(moved).find((dimension) => dimension.claimId === claimNamed(moved, "record.alpha").id)!;
  assert.ok(alpha.evidenceId, "the dimension names its evidence");
  alpha.claimId = claimNamed(moved, "record.bravo").id;
  alpha.reviewDisposition = "rejected";
  refuses(moved, /records a dimension for .* that its own evidence does not yield/);
});

test("an exclusion code Fieldwork does not write is refused, and event times are compared as instants", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("codes"));
  for (const code of ["", "EXPORT_BOGUS"]) {
    const copy = editable(mixed);
    (copy.reviewRound.excluded.find((entry) => entry.fieldPath === "record.delta") as { code: string }).code = code;
    assert.throws(() => memoryClaimsFromReviewedExport(copy), /code/, code);
  }
  // A dispute written one hour before the verification, in a spelling that sorts after it as text, is not the latest.
  const copy = editable(mixed);
  const event = copy.bundle.events.find((entry) => entry.claimId === claimNamed(copy, "record.alpha").id)!;
  const earlier = new Date(Date.parse(event.createdAt) - 3_600_000 + 14 * 3_600_000).toISOString().replace("Z", "+14:00");
  assert.ok(earlier > event.createdAt, "the earlier instant sorts after the later one as text");
  copy.bundle.events.push({ ...event, id: `${event.id}.earlier`, status: "disputed", createdAt: earlier });
  assert.doesNotThrow(() => memoryClaimsFromReviewedExport(copy));
});

/** Re-project every reviewed-extraction entry through Surface after `change` edits its restored input, so each digest binding is valid. */
const regenerateAll = (copy: Editable, change: (input: ReturnType<typeof restoreReviewedExtractionEvidence>, claimId: string) => void): void => {
  copy.bundle.evidence = copy.bundle.evidence.map((entry) => {
    if (entry.metadata?.reviewedExtraction === undefined) return entry;
    const input = restoreReviewedExtractionEvidence(entry as never, { resolveImportRecord: resolverFromBundle(copy.bundle as never) });
    change(input, entry.claimId);
    return projectReviewedExtractionEvidence(input).evidence as never;
  });
};

test("evidence regenerated through Surface cannot contradict its own candidate, the claim's target or the receipt's value digest", async () => {
  const typedRun = await typedFieldRun("memory-contradict");
  await decide(typedRun, Object.fromEntries((await queueOf(typedRun)).map((item) => [item.name, "accept-proposed"])));
  const typed = await reviewedExport(typedRun);
  const mixed = await reviewedExport(await decidedMixedRun("contradict"));

  // The proposal says its value satisfies the schema; the candidate the reviewer selected still says it does not.
  const dateIndex = (copy: Editable) => {
    const entry = copy.bundle.evidence.find((item) => item.claimId === claimNamed(copy, "doc.publicationDate").id && item.metadata?.reviewedExtraction)!;
    return restoreReviewedExtractionEvidence(entry as never).proposalIndex;
  };
  const schema = editable(typed);
  const index = dateIndex(schema);
  settle(schema, "doc.publicationDate", "verified");
  regenerateAll(schema, (input) => {
    (input.importRecord.spec.envelope.result.proposals[index] as { evidenceMatch: { schema: string } }).evidenceMatch.schema = "ok";
  });
  rebindReceipt(schema);
  refuses(schema, /carries one schema match on its proposal and another on the candidate/);

  // The value changes in the claim, the selected candidate and the proposal; the receipt keeps the digest of the value it graded.
  const value = editable(mixed);
  const alpha = claimNamed(value, "record.alpha");
  const alphaIndex = restoreReviewedExtractionEvidence(value.bundle.evidence.find((item) => item.claimId === alpha.id && item.metadata?.reviewedExtraction) as never).proposalIndex;
  alpha.value = "Changed";
  regenerateAll(value, (input, claimId) => {
    (input.importRecord.spec.envelope.result.proposals[alphaIndex] as { candidateValue: unknown }).candidateValue = "Changed";
    if (claimId === alpha.id) for (const candidate of input.reviewItem!.spec.candidates) (candidate as { value: unknown }).value = "Changed";
  });
  refuses(value, /records a dimension for .* that its own evidence does not yield/);

  // The span the claim cites changes in the proposal and the candidate; the receipt keeps the locator it graded.
  const span = editable(mixed);
  const charlie = claimNamed(span, "record.charlie");
  const charlieIndex = restoreReviewedExtractionEvidence(span.bundle.evidence.find((item) => item.claimId === charlie.id && item.metadata?.reviewedExtraction) as never).proposalIndex;
  regenerateAll(span, (input, claimId) => {
    const provenance = (input.importRecord.spec.envelope.result.proposals[charlieIndex] as { provenance: { excerpt: string; locator: string; occurrence: { selected: { start: number; end: number } } } }).provenance;
    const start = 1000;
    const locator = `chars:${start}-${start + provenance.excerpt.length}`;
    provenance.locator = locator;
    provenance.occurrence.selected = { ...provenance.occurrence.selected, start, end: start + provenance.excerpt.length };
    if (claimId === charlie.id) for (const candidate of input.reviewItem!.spec.candidates) (candidate.locator as { locator: string }).locator = locator;
  });
  refuses(span, /records a dimension for .* that its own evidence does not yield/);
});

test("every candidate of the decided item states the claim's target, not only the first", async () => {
  const run = await conflictRun("memory-target");
  const service = await openRun(run);
  let snapshot: ReviewQueueSessionState;
  try {
    snapshot = (await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1).review.snapshot as unknown as ReviewQueueSessionState;
  } finally { await service.close(); }
  const conflict = snapshot.items.find((item) => item.spec.candidates.length > 1)!;
  const chosen = conflict.spec.candidates[1]!;
  await decide(run, {
    [conflict.metadata.name]: "select-proposed",
    ...Object.fromEntries(snapshot.items.filter((item) => item !== conflict).map((item) => [item.metadata.name, "accept-proposed"])),
  }, { [conflict.metadata.name]: chosen.id });
  const exported = await reviewedExport(run);
  for (const key of ["subjectType", "subjectId", "claimType", "fieldOrBehavior"] as const) {
    const copy = editable(exported);
    const status = claimNamed(copy, "record.status");
    const index = copy.bundle.evidence.findIndex((item) => item.claimId === status.id && item.metadata?.reviewedExtraction);
    const input = restoreReviewedExtractionEvidence(copy.bundle.evidence[index] as never);
    const selected = input.reviewItem!.spec.candidates.find((candidate) => candidate.id === input.reviewDecision!.spec.candidateId)!;
    (selected.claimTarget as unknown as Record<string, string>)[key] = "somewhere-else";
    copy.bundle.evidence[index] = projectReviewedExtractionEvidence(input, { profile: reviewedExtractionEvidenceChoiceProfile, includeImportRecord: true }).evidence as never;
    rebindReceipt(copy);
    refuses(copy, /claim target other than the one its Survey decision accepted/);

    // A candidate the reviewer did not select states the item's target too.
    const rival = editable(exported);
    const rivalIndex = rival.bundle.evidence.findIndex((item) => item.claimId === claimNamed(rival, "record.status").id && item.metadata?.reviewedExtraction);
    const rivalInput = restoreReviewedExtractionEvidence(rival.bundle.evidence[rivalIndex] as never);
    const unselected = rivalInput.reviewItem!.spec.candidates.find((candidate) => candidate.id !== rivalInput.reviewDecision!.spec.candidateId)!;
    (unselected.claimTarget as unknown as Record<string, string>)[key] = "somewhere-else";
    rival.bundle.evidence[rivalIndex] = projectReviewedExtractionEvidence(rivalInput, { profile: reviewedExtractionEvidenceChoiceProfile, includeImportRecord: true }).evidence as never;
    rebindReceipt(rival);
    refuses(rival, /claim target other than the one its Survey decision accepted/);
  }
});

test("the export Fieldwork 0.13.0 itself wrote for the real run projects, with the claim that writer called verified arriving proposed", async () => {
  // Written by the published release (Fieldwork 0.13.0, Surface 4.4.0, Survey 7.0.0) with `fieldwork export`, not by this
  // checkout. That writer called `doc.versionNumber = "2.1"` (a number field answered with text) verified, though its own
  // receipt records the structure as invalid; today's writer disputes it.
  const exported = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "real-run-0.13.0", "export-0.13.0.json"), "utf8")) as ReviewedExportV1;
  const bundle = exported.bundle as unknown as Bundle;
  assert.equal(bundle.claims.find((claim) => claim.fieldOrBehavior === "doc.versionNumber")!.status, "verified");
  const projection = memoryClaimsFromReviewedExport(exported);
  assert.deepEqual(projection.claims.map((entry) => [entry.claim.property, entry.arrival]), bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.fieldOrBehavior === "doc.versionNumber" || claim.status === "disputed" ? "proposed" : "reviewed"]));
  const version = one(projection, "doc.versionNumber");
  assert.ok(version.origin.kind === "reviewed-claim");
  assert.equal(version.origin.surfaceStatus, "verified");
  assert.ok(version.origin.groundingGaps?.includes("structure-invalid"), JSON.stringify(version.origin.groundingGaps));
});

test("a changed target, a conflicting type declaration or a receipt that records invalid structure cannot leave a claim reviewed", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("sevenths"));
  const typedRun = await typedFieldRun("memory-sevenths");
  await decide(typedRun, Object.fromEntries((await queueOf(typedRun)).map((item) => [item.name, "accept-proposed"])));
  const typed = await reviewedExport(typedRun);

  // The import record still declares the task's targets: a claim cannot move to another subject, type or field.
  for (const [key, bundleKey] of [["subjectId", "subjectId"], ["subjectType", "subjectType"], ["claimType", "claimType"], ["fieldOrBehavior", "fieldOrBehavior"]] as const) {
    const moved = editable(mixed);
    const alpha = claimNamed(moved, "record.alpha");
    (alpha as unknown as Record<string, string>)[bundleKey] = "somewhere-else";
    regenerateAll(moved, (input, claimId) => {
      if (claimId === alpha.id) for (const candidate of input.reviewItem!.spec.candidates) (candidate.claimTarget as unknown as Record<string, string>)[key] = "somewhere-else";
    });
    rebindReceipt(moved);
    refuses(moved, /claim target its import record does not declare/);
  }

  // One scalar of the receipt saying the structure was invalid is doubt, however the rest is rewritten.
  const scalar = editable(mixed);
  (scalar.reviewedGrounding as unknown as { dimensions: { claimId: string; structuralTrust: string }[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(scalar, "record.alpha").id)!.structuralTrust = "invalid";
  assert.equal(arrivalOf(scalar, "record.alpha"), "proposed");

  // The version number is declared a number on its candidate: a proposal that says string, with both schema matches ok, is a
  // different record from the one the reviewer saw.
  const version = claimNamed(editable(typed), "doc.versionNumber");
  const typeSwap = editable(typed);
  const versionIndex = restoreReviewedExtractionEvidence(typeSwap.bundle.evidence.find((item) => item.claimId === version.id && item.metadata?.reviewedExtraction) as never).proposalIndex;
  settle(typeSwap, "doc.versionNumber", "verified");
  regenerateAll(typeSwap, (input, claimId) => {
    const proposal = input.importRecord.spec.envelope.result.proposals[versionIndex] as { valueType?: string; evidenceMatch: { schema: string } };
    proposal.valueType = "string";
    proposal.evidenceMatch.schema = "ok";
    if (claimId === version.id) for (const candidate of input.reviewItem!.spec.candidates) {
      const producer = (candidate.producer as Record<string, { evidenceMatch: { schema: string } }>)["survey.kontourai.io/extraction-envelope"]!;
      producer.evidenceMatch.schema = "ok";
    }
  });
  rebindReceipt(typeSwap);
  refuses(typeSwap, /one value type on its proposal and another on the candidate/);

  // A receipt dimension is bound to the evidence it names.
  const evidence = editable(mixed);
  (evidence.reviewedGrounding as unknown as { dimensions: { claimId: string; evidenceId: string }[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(evidence, "record.alpha").id)!.evidenceId = "extraction-envelope.nothing.reviewed-extraction-evidence";
  refuses(evidence, /records a dimension for .* that its own evidence does not yield/);
});

test("each source of doubt alone keeps a claim from arriving reviewed, and structure left unchecked does not", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("doubt"));
  const doubtOf = (copy: Editable) => {
    const entry = memoryClaimsFromReviewedExport(copy).claims.find((item) => item.claim.property === "record.alpha")!;
    return [entry.arrival, entry.origin.kind === "reviewed-claim" ? entry.origin.groundingGaps ?? [] : []] as const;
  };
  assert.deepEqual(doubtOf(editable(mixed)), ["reviewed", []]);

  // The receipt alone records a gap that disputes the claim.
  const gap = editable(mixed);
  gap.reviewedGrounding.gaps = [...(gap.reviewedGrounding.gaps ?? []), { kind: "hidden-conflict", claimId: claimNamed(gap, "record.alpha").id }];
  assert.deepEqual(doubtOf(gap), ["proposed", ["hidden-conflict"]]);
  // A structural gap leaves it verified unless Surface found the structure invalid.
  const unchecked = editable(mixed);
  unchecked.reviewedGrounding.gaps = [{ kind: "structure-not-validated", structuralTrust: "unvalidated", claimId: claimNamed(unchecked, "record.alpha").id }];
  assert.deepEqual(doubtOf(unchecked), ["reviewed", []]);
  const invalid = editable(mixed);
  invalid.reviewedGrounding.gaps = [{ kind: "structure-not-validated", structuralTrust: "invalid", claimId: claimNamed(invalid, "record.alpha").id }];
  assert.deepEqual(doubtOf(invalid), ["proposed", ["structure-not-validated"]]);

  // The evidence alone yields invalid structure (re-projected through Surface; the receipt says validated and records no gap).
  const evidence = editable(mixed);
  const index = evidence.bundle.evidence.findIndex((item) => item.claimId === claimNamed(evidence, "record.alpha").id && item.metadata?.reviewedExtraction);
  const input = restoreReviewedExtractionEvidence(evidence.bundle.evidence[index] as never);
  input.structuralTrust = "invalid";
  evidence.bundle.evidence[index] = projectReviewedExtractionEvidence(input).evidence as never;
  rebindReceipt(evidence);
  (evidence.reviewedGrounding as unknown as { dimensions: { structuralTrust?: string }[] }).dimensions.forEach((dimension) => { dimension.structuralTrust = "validated"; });
  evidence.reviewedGrounding.gaps = [];
  assert.equal(doubtOf(evidence)[0], "proposed");
  assert.ok(doubtOf(evidence)[1].includes("structure-not-validated"), JSON.stringify(doubtOf(evidence)));
});

test("exports the published Fieldwork 0.11 wrote arrive reviewed, and the bare bundles 0.9 wrote are refused by name", async () => {
  // Written by the published releases with `fieldwork export`, not by this checkout. 0.11 checked excerpts against the
  // prepared text but did not record that it had; today's policy would read the missing record as a gap.
  const dir = join(import.meta.dirname, "fixtures", "published-writers");
  const old = JSON.parse(await readFile(join(dir, "fieldwork-0.11.0-generic-accept.json"), "utf8")) as ReviewedExportV1;
  const projection = memoryClaimsFromReviewedExport(old);
  assert.deepEqual(projection.claims.map((entry) => [entry.claim.property, entry.claim.value, entry.arrival]), [["record.status", "Active", "reviewed"]]);
  assert.deepEqual(projection.withheld, []);
  // The same export from today's writer says the same thing.
  const today = memoryClaimsFromReviewedExport(await reviewedExport(await decidedMixedRun("legacy-twin")));
  assert.equal(today.claims.find((entry) => entry.claim.property === "record.alpha")!.arrival, "reviewed");

  // 0.9 and 0.10 exported a bare trust bundle: no Survey decisions or attribution to map from.
  const bare = JSON.parse(await readFile(join(dir, "fieldwork-0.9.0-generic-accept.json"), "utf8")) as ReviewedExportV1;
  assert.equal("kind" in bare, false);
  assert.throws(() => memoryClaimsFromReviewedExport(bare), (error: Error & { code?: string }) => {
    assert.equal(error.code, "EXPORT_UNSUPPORTED_FORMAT");
    assert.match(error.message, /before 0\.11/);
    assert.match(error.message, /no round scope/);
    return true;
  });
});

test("what the receipt's dimension records against a claim is doubt, and a gap names its claim by evidence as well as by id", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("dimension-doubt"));
  const arrivalAndGaps = (copy: Editable) => {
    const entry = memoryClaimsFromReviewedExport(copy).claims.find((item) => item.claim.property === "record.alpha")!;
    return [entry.arrival, entry.origin.kind === "reviewed-claim" ? entry.origin.groundingGaps ?? [] : []] as const;
  };
  const dimensionOf = (copy: Editable) => (copy.reviewedGrounding as unknown as { dimensions: Record<string, unknown>[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(copy, "record.alpha").id)!;
  for (const [label, edit, kind] of [
    ["a prepared artifact that is not available", (dimension: Record<string, unknown>) => { dimension.preparedArtifact = { status: "missing" }; }, "missing-prepared-artifact"],
    ["an excluded rival", (dimension: Record<string, unknown>) => { dimension.excludedRivals = { proposalIndices: [1] }; }, "excluded-rival-unresolved"],
    ["a hidden conflict", (dimension: Record<string, unknown>) => { dimension.hiddenConflict = { rivalProposalIndices: [1], droppedProposalIndices: [] }; }, "hidden-conflict"],
    ["excerpts recorded unverified", (dimension: Record<string, unknown>) => { dimension.excerptVerification = "unverified"; }, "excerpt-not-verified"],
  ] as const) {
    const copy = editable(mixed);
    edit(dimensionOf(copy));
    // The dimension also no longer says what the evidence yields, which is doubt of its own.
    assert.deepEqual(arrivalAndGaps(copy), ["proposed", [kind, "receipt-differs"].sort()], label);
  }
  // A gap that names its evidence and not its claim is about that evidence's claim.
  const byEvidence = editable(mixed);
  const alphaEvidence = byEvidence.bundle.evidence.find((item) => item.claimId === claimNamed(byEvidence, "record.alpha").id && item.metadata?.reviewedExtraction)!;
  byEvidence.reviewedGrounding.gaps = [...(byEvidence.reviewedGrounding.gaps ?? []), { kind: "hidden-conflict", evidenceId: (alphaEvidence as unknown as { id: string }).id } as never];
  assert.deepEqual(arrivalAndGaps(byEvidence), ["proposed", ["hidden-conflict"]]);
  // A gap about another claim's evidence is not about this one.
  const other = editable(mixed);
  const charlieEvidence = other.bundle.evidence.find((item) => item.claimId === claimNamed(other, "record.charlie").id && item.metadata?.reviewedExtraction)!;
  other.reviewedGrounding.gaps = [{ kind: "hidden-conflict", evidenceId: (charlieEvidence as unknown as { id: string }).id } as never];
  assert.deepEqual(arrivalAndGaps(other), ["reviewed", []]);
});

test("anything a carried dimension says that the evidence does not is doubt, provenance dropped from the evidence is doubt, and a gap resolves to its claim by evidence", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("ninth"));
  const arrivalAndGaps = (copy: Editable, field = "record.alpha") => {
    const entry = memoryClaimsFromReviewedExport(copy).claims.find((item) => item.claim.property === field)!;
    return [entry.arrival, entry.origin.kind === "reviewed-claim" ? entry.origin.groundingGaps ?? [] : []] as const;
  };
  const dimensionOf = (copy: Editable, field = "record.alpha") => (copy.reviewedGrounding as unknown as { dimensions: Record<string, unknown>[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(copy, field).id)!;

  // Source state and any other key: the receipt no longer says what the evidence yields.
  const state = editable(mixed);
  (dimensionOf(state).sourceState as { status: string }).status = "drifted";
  assert.deepEqual(arrivalAndGaps(state), ["proposed", ["receipt-differs"]]);
  const confidence = editable(mixed);
  dimensionOf(confidence).candidateConfidence = 0.1;
  assert.deepEqual(arrivalAndGaps(confidence), ["proposed", ["receipt-differs"]]);

  // A chosen conflict whose receipt says the decision named another candidate than the one the evidence cites.
  const run = await conflictRun("memory-choice");
  const service = await openRun(run);
  let snapshot: ReviewQueueSessionState;
  try {
    snapshot = (await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1).review.snapshot as unknown as ReviewQueueSessionState;
  } finally { await service.close(); }
  const conflict = snapshot.items.find((item) => item.spec.candidates.length > 1)!;
  await decide(run, {
    [conflict.metadata.name]: "select-proposed",
    ...Object.fromEntries(snapshot.items.filter((item) => item !== conflict).map((item) => [item.metadata.name, "accept-proposed"])),
  }, { [conflict.metadata.name]: conflict.spec.candidates[1]!.id });
  const chosen = editable(await reviewedExport(run));
  const choice = dimensionOf(chosen, "record.status").choice as { decisionCandidateId: string };
  assert.ok(choice, "a chosen conflict carries its choice in the receipt");
  choice.decisionCandidateId = "another-candidate";
  assert.deepEqual(arrivalAndGaps(chosen, "record.status"), ["proposed", ["receipt-differs"]]);

  // Provenance dropped from the evidence is not a structural gap.
  const dropped = editable(mixed);
  const index = dropped.bundle.evidence.findIndex((item) => item.claimId === claimNamed(dropped, "record.alpha").id && item.metadata?.reviewedExtraction);
  const input = restoreReviewedExtractionEvidence(dropped.bundle.evidence[index] as never);
  input.droppedProvenance = ["source"];
  dropped.bundle.evidence[index] = projectReviewedExtractionEvidence(input).evidence as never;
  rebindReceipt(dropped);
  const [droppedArrival, droppedGaps] = arrivalAndGaps(dropped);
  assert.equal(droppedArrival, "proposed");
  assert.ok(droppedGaps.includes("profile-gap"), JSON.stringify(droppedGaps));

  // A disputed claim whose gap names its evidence and not its claim reads the same as one that names the claim.
  const rivalRun = await forgedUnverifiedConflictRun("memory-gap-evidence");
  await decide(rivalRun, Object.fromEntries((await queueOf(rivalRun)).map((item) => [item.name, "accept-proposed"])));
  const rival = await reviewedExport(rivalRun);
  const honest = memoryClaimsFromReviewedExport(rival);
  const byEvidence = editable(rival);
  for (const gap of byEvidence.reviewedGrounding.gaps) delete (gap as { claimId?: string }).claimId;
  assert.ok(byEvidence.reviewedGrounding.gaps.every((gap) => (gap as { evidenceId?: string }).evidenceId));
  assert.deepEqual(memoryClaimsFromReviewedExport(byEvidence), honest);
});

test("two items that state one claim are one claim, and the weaker arrival stands whichever comes first", async () => {
  const run = await indexedItemsRun("memory-twins", true);
  const queue = await queueOf(run);
  await decide(run, Object.fromEntries(queue.map((item) => [item.name, "accept-proposed"])));
  const exported = await reviewedExport(run);
  const twins = (exported.bundle as unknown as Bundle).claims.filter((claim) => claim.fieldOrBehavior === "record.items[]");
  assert.equal(twins.length, 2);
  const withDoubt = (reverse: boolean) => {
    const copy = editable(exported);
    const first = copy.bundle.claims.filter((claim) => claim.fieldOrBehavior === "record.items[]")[0]!;
    const index = copy.bundle.evidence.findIndex((item) => item.claimId === first.id && item.metadata?.reviewedExtraction);
    const input = restoreReviewedExtractionEvidence(copy.bundle.evidence[index] as never);
    input.structuralTrust = "invalid";
    copy.bundle.evidence[index] = projectReviewedExtractionEvidence(input).evidence as never;
    rebindReceipt(copy);
    if (reverse) copy.bundle.claims.reverse();
    return memoryClaimsFromReviewedExport(copy);
  };
  for (const reverse of [false, true]) {
    const projection = withDoubt(reverse);
    assert.deepEqual(byProperty(projection, "record.items[]").map((entry) => entry.arrival), ["proposed"], `reverse=${reverse}`);
    assert.deepEqual(projection.withheld.map((item) => item.reason), ["duplicate-claim"]);
  }
  const clean = memoryClaimsFromReviewedExport(exported);
  assert.deepEqual(byProperty(clean, "record.items[]").map((entry) => entry.arrival), ["reviewed"]);
});

test("an exclusion listed twice is one exclusion", async () => {
  const honest = await reviewedExport(await decidedMixedRun("twice-excluded"));
  const copy = editable(honest);
  copy.reviewRound.excluded.push({ fieldPath: "record.charlie", itemNames: ["extraction-envelope.not-needed"], code: "EXPORT_FIELD_UNSETTLED" });
  assert.throws(() => memoryClaimsFromReviewedExport(copy), /holds no such review item/);
  // A real non-undecided exclusion, duplicated.
  const run = await indexedItemsRun("memory-dup-exclusion");
  const queue = await queueOf(run);
  await decide(run, { [queue.find((item) => item.fieldPath === "record.status")!.name]: "accept-proposed", [queue.filter((item) => item.fieldPath === "record.items[]")[0]!.name]: "reject-proposed" });
  const exported = await reviewedExport(run);
  const once = memoryClaimsFromReviewedExport(exported);
  const doubled = editable(exported);
  const unsettled = doubled.reviewRound.excluded.find((entry) => entry.code === "EXPORT_FIELD_UNSETTLED")!;
  doubled.reviewRound.excluded.push({ ...unsettled });
  assert.deepEqual(memoryClaimsFromReviewedExport(doubled), once);
});

test("doubt held in the evidence survives thinning the receipt: unverified excerpts, a gap with contradictory addresses, an extraction outcome the import no longer states", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("tenth"));
  const read = (copy: Editable, field = "record.alpha") => {
    const entry = memoryClaimsFromReviewedExport(copy).claims.find((item) => item.claim.property === field)!;
    return [entry.arrival, entry.origin.kind === "reviewed-claim" ? entry.origin.groundingGaps ?? [] : []] as const;
  };
  const evidenceOf = (copy: Editable, field = "record.alpha") => copy.bundle.evidence.findIndex((item) => item.claimId === claimNamed(copy, field).id && item.metadata?.reviewedExtraction);
  const KEY = "survey.kontourai.io/extraction-envelope";

  // The item says its excerpts were NOT verified. Deleting every other dimension, and the key from this one, must not make
  // the receipt look like an older writer's: the evidence still says what it says.
  const unverified = editable(mixed);
  const index = evidenceOf(unverified);
  const input = restoreReviewedExtractionEvidence(unverified.bundle.evidence[index] as never);
  (input.reviewItem!.metadata.producer![KEY] as Record<string, unknown>).excerptVerification = "unverified";
  unverified.bundle.evidence[index] = projectReviewedExtractionEvidence(input).evidence as never;
  rebindReceipt(unverified);
  assert.ok(read(unverified)[1].includes("excerpt-not-verified"));
  const dimensions = (unverified.reviewedGrounding as unknown as { dimensions: Record<string, unknown>[] }).dimensions;
  const alphaId = claimNamed(unverified, "record.alpha").id;
  (unverified.reviewedGrounding as unknown as { dimensions: Record<string, unknown>[] }).dimensions = dimensions.filter((dimension) => dimension.claimId === alphaId);
  delete dimensions.find((dimension) => dimension.claimId === alphaId)!.excerptVerification;
  assert.deepEqual(read(unverified)[0], "proposed");
  assert.ok(read(unverified)[1].includes("excerpt-not-verified"), JSON.stringify(read(unverified)));

  // A gap that names a claim and evidence is about both, and one whose claim id is edited away stays about its evidence.
  const alphaEvidenceId = (mixed.bundle as unknown as Bundle).evidence.find((item) => item.claimId === claimNamed(editable(mixed), "record.alpha").id && item.metadata?.reviewedExtraction) as unknown as { id: string };
  for (const claimId of [claimNamed(editable(mixed), "record.alpha").id, "extraction-envelope.nothing.claim", claimNamed(editable(mixed), "record.charlie").id]) {
    const gap = editable(mixed);
    gap.reviewedGrounding.gaps = [{ kind: "missing-prepared-artifact", claimId, evidenceId: alphaEvidenceId.id } as never];
    assert.deepEqual(read(gap), ["proposed", ["missing-prepared-artifact"]], claimId);
  }
  const unresolvable = editable(mixed);
  unresolvable.reviewedGrounding.gaps = [{ kind: "missing-prepared-artifact", claimId: "extraction-envelope.nothing.claim" } as never];
  assert.deepEqual(read(unresolvable, "record.charlie"), ["proposed", ["missing-prepared-artifact"]]);

  // The extraction outcome is stated on the import and again on the candidate: a candidate that says partial under an
  // import that says success is a candidate the import did not yield.
  const outcome = editable(mixed);
  const outcomeIndex = evidenceOf(outcome);
  const outcomeInput = restoreReviewedExtractionEvidence(outcome.bundle.evidence[outcomeIndex] as never);
  for (const candidate of outcomeInput.reviewItem!.spec.candidates) (candidate.producer![KEY] as Record<string, unknown>).outcome = { status: "partial", reason: "max-chunks" };
  outcome.bundle.evidence[outcomeIndex] = projectReviewedExtractionEvidence(outcomeInput).evidence as never;
  rebindReceipt(outcome);
  const [outcomeArrival, outcomeGaps] = read(outcome);
  assert.equal(outcomeArrival, "proposed");
  assert.ok(outcomeGaps.includes("candidate-differs"), JSON.stringify(outcomeGaps));
});

test("a key the receipt's dimension states that the evidence does not yield is doubt, whether or not a later Surface would add it", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("added-key"));
  const copy = editable(mixed);
  (copy.reviewedGrounding as unknown as { dimensions: Record<string, unknown>[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(copy, "record.alpha").id)!.laterSurfaceFact = "x";
  const entry = memoryClaimsFromReviewedExport(copy).claims.find((item) => item.claim.property === "record.alpha")!;
  assert.equal(entry.arrival, "proposed");
  assert.ok(entry.origin.kind === "reviewed-claim" && entry.origin.groundingGaps?.includes("receipt-differs"));
});

test("a dimension may omit a key the policy yields, but not state one it does not, null included; a candidate may not state provenance Survey does not yield", async () => {
  const mixed = await reviewedExport(await decidedMixedRun("stated-keys"));
  const read = (copy: Editable) => {
    const entry = memoryClaimsFromReviewedExport(copy).claims.find((item) => item.claim.property === "record.alpha")!;
    return [entry.arrival, entry.origin.kind === "reviewed-claim" ? entry.origin.groundingGaps ?? [] : []] as const;
  };
  const dimensionOf = (copy: Editable) => (copy.reviewedGrounding as unknown as { dimensions: Record<string, unknown>[] }).dimensions.find((dimension) => dimension.claimId === claimNamed(copy, "record.alpha").id)!;
  // An older writer's dimension without a key a later Surface yields still reads.
  const omitted = editable(mixed);
  delete dimensionOf(omitted).candidateConfidence;
  assert.deepEqual(read(omitted), ["reviewed", []]);
  // A key it states that the policy does not yield is doubt, whatever the value.
  for (const value of ["x", null, 0, false]) {
    const stated = editable(mixed);
    dimensionOf(stated).laterSurfaceFact = value;
    assert.deepEqual(read(stated), ["proposed", ["receipt-differs"]], JSON.stringify(value));
  }
  // A candidate that states provenance Survey does not yield again.
  const extra = editable(mixed);
  const index = extra.bundle.evidence.findIndex((item) => item.claimId === claimNamed(extra, "record.alpha").id && item.metadata?.reviewedExtraction);
  const input = restoreReviewedExtractionEvidence(extra.bundle.evidence[index] as never);
  for (const candidate of input.reviewItem!.spec.candidates) (candidate.producer!["survey.kontourai.io/extraction-envelope"] as Record<string, unknown>).laterSurveyFact = "x";
  extra.bundle.evidence[index] = projectReviewedExtractionEvidence(input).evidence as never;
  rebindReceipt(extra);
  assert.ok(read(extra)[1].includes("candidate-differs"), JSON.stringify(read(extra)));
  assert.equal(read(extra)[0], "proposed");
});

test("an exclusion cannot name a decided item, repeat an item, or put an item under another field", async () => {
  const honest = await reviewedExport(await decidedMixedRun("exclusions"));
  const itemOf = (bundle: Bundle, field: string) => {
    const claim = bundle.claims.find((entry) => entry.fieldOrBehavior === field)!;
    const evidence = bundle.evidence.find((entry) => entry.claimId === claim.id && entry.metadata?.reviewedExtraction)!;
    return (evidence.metadata!.reviewedExtraction as { input: { reviewItem: { metadata: { name: string } } } }).input.reviewItem.metadata.name;
  };
  const refuses = (change: (bundle: Bundle, scope: Scope) => void, message: RegExp) => {
    const copy = clone(honest) as unknown as ReviewedExportV1 & { bundle: Bundle; reviewRound: Scope };
    change(copy.bundle, copy.reviewRound);
    assert.throws(() => memoryClaimsFromReviewedExport(copy), message);
  };
  const delta = (scope: Scope) => scope.excluded.find((entry) => entry.fieldPath === "record.delta")!;
  refuses((bundle, scope) => { const entry = delta(scope); entry.fieldPath = "record.alpha"; entry.itemNames = [itemOf(bundle, "record.alpha")]; }, /carries a decision for it/);
  refuses((bundle, scope) => { const entry = delta(scope); entry.fieldPath = "record.bravo"; entry.itemNames = [itemOf(bundle, "record.bravo")]; }, /carries a decision for it/);
  refuses((_bundle, scope) => { delta(scope).itemNames = [...delta(scope).itemNames, ...delta(scope).itemNames]; }, /undecided more than once/);
  refuses((_bundle, scope) => { delta(scope).fieldPath = "record.charlie"; }, /which is not its field/);
  // Every exclusion names items the record holds, whatever its code.
  refuses((_bundle, scope) => { scope.excluded.push({ fieldPath: "record.charlie", itemNames: ["nonexistent-item"], code: "EXPORT_CONFLICTING_DECISIONS" }); scope.complete = false; }, /holds no such review item/);
  refuses((bundle, scope) => { scope.excluded.push({ fieldPath: "record.charlie", itemNames: [itemOf(bundle, "record.bravo")], code: "EXPORT_UNGROUNDED_SELECTION" }); }, /which is not its field/);
  refuses((_bundle, scope) => { delete (scope as Partial<Scope>).excluded; }, /excluded/);
  refuses((_bundle, scope) => { delete (scope as Partial<Scope>).decisions; }, /decisions/);
});

test("a web snapshot's claims carry its Forage snapshot ref as source and speaker, and two fetches stay two authorities", async () => {
  const first = await snapshotRun("snapshot-a", "2026-07-23T10:00:00.000Z");
  const second = await snapshotRun("snapshot-b", "2026-07-24T10:00:00.000Z");
  const [a, b] = [one(memoryClaimsFromReviewedExport(await reviewedExport(first.run)), "record.status"), one(memoryClaimsFromReviewedExport(await reviewedExport(second.run)), "record.status")];
  assert.notEqual(first.snapshotRef, second.snapshotRef);
  for (const [entry, { snapshotRef }] of [[a, first], [b, second]] as const) {
    assert.equal(entry.claim.source.ref, snapshotRef);
    assert.equal(entry.claim.speaker, snapshotRef);
    assert.equal(entry.arrival, "reviewed");
  }
  assert.deepEqual([a.claim.property, a.claim.value], [b.claim.property, b.claim.value]);
  assert.notEqual(a.claim.id, b.claim.id);
});

test("an export that disagrees with itself about who decided what, or what it left out, is refused", async () => {
  const honest = await reviewedExport(await decidedMixedRun("round-agreement"));
  const refuses = (change: (copy: ReviewedExportV1 & { bundle: Bundle; reviewRound: Scope & Record<string, unknown> }) => void, message: RegExp) => {
    const copy = clone(honest) as unknown as ReviewedExportV1 & { bundle: Bundle; reviewRound: Scope & Record<string, unknown> };
    change(copy);
    assert.throws(() => memoryClaimsFromReviewedExport(copy), message);
  };
  const claimIdOf = (copy: { bundle: Bundle }, field: string) => copy.bundle.claims.find((claim) => claim.fieldOrBehavior === field)!.id;
  const decisionOf = (copy: { bundle: Bundle; reviewRound: Scope }, field: string) => copy.reviewRound.decisions.find((entry) => entry.claimId === claimIdOf(copy, field)) as unknown as { claimId: string; reviewItemName: string; actor: { id: string } };
  const exclusionOf = (copy: { reviewRound: Scope }, field: string) => copy.reviewRound.excluded.find((entry) => entry.fieldPath === field)!;

  // Attribution: the decision it names, who made it, and that there is one.
  refuses((copy) => { decisionOf(copy, "record.alpha").reviewItemName = "extraction-envelope.not-its-item"; }, /no round attribution that names the review item, actor and time/);
  refuses((copy) => { decisionOf(copy, "record.alpha").actor.id = "someone-else"; }, /no round attribution that names the review item, actor and time/);
  refuses((copy) => { decisionOf(copy, "record.bravo").actor.id = "someone-else"; }, /no round attribution that names the review item, actor and time/);
  refuses((copy) => { copy.reviewRound.decisions = copy.reviewRound.decisions.filter((entry) => entry.claimId !== claimIdOf(copy, "record.alpha")); }, /no round attribution/);
  refuses((copy) => { copy.reviewRound.decisions.push({ ...decisionOf(copy, "record.alpha"), actor: { id: "someone-else" } }); }, /more than one decision/);
  // A duplicate attribution that names the undecided item cannot hide the item from the accounting.
  refuses((copy) => {
    exclusionOf(copy, "record.delta").itemNames.forEach((name) => copy.reviewRound.decisions.push({ ...decisionOf(copy, "record.alpha"), reviewItemName: name }));
    copy.reviewRound.excluded = copy.reviewRound.excluded.filter((entry) => entry.fieldPath !== "record.delta");
  }, /more than one decision/);
  // An exclusion for another reason cannot name an item the export also exports a decision for.
  refuses((copy) => {
    copy.reviewRound.excluded.push({ fieldPath: "record.alpha", itemNames: [decisionOf(copy, "record.alpha").reviewItemName], code: "EXPORT_CONFLICTING_DECISIONS" });
    copy.reviewRound.complete = false;
  }, /also exports a decision for it/);
  refuses((copy) => { copy.reviewRound.decisions.push({ claimId: "extraction-envelope.nothing.claim", reviewItemName: "x", decidedAt: "2026-01-01T00:00:00.000Z", actor: { id: "y" } } as never); }, /which is not one of its claims/);
  // A rejected item stays decided even when its evidence is gone: it cannot come back as undecided.
  refuses((copy) => {
    const bravo = claimIdOf(copy, "record.bravo");
    const reviewItem = decisionOf(copy, "record.bravo").reviewItemName;
    copy.bundle.evidence = copy.bundle.evidence.filter((entry) => !(entry.claimId === bravo && entry.metadata?.reviewedExtraction));
    rebindReceipt(copy as never);
    const entry = exclusionOf(copy, "record.delta");
    entry.fieldPath = "record.bravo";
    entry.itemNames = [reviewItem];
  }, /carries a decision for it/);
  // What the export left out has to be listed: no empty exclusions, no scope that lies about completeness.
  refuses((copy) => { exclusionOf(copy, "record.delta").itemNames = []; }, /itemNames/);
  refuses((copy) => { copy.reviewRound.excluded = []; }, /says it is complete|lists none but says it is partial/);
  refuses((copy) => { copy.reviewRound.complete = true; }, /says it is complete but lists exclusions/);
  refuses((copy) => { copy.reviewRound.excluded = copy.reviewRound.excluded.filter((entry) => entry.fieldPath !== "record.delta"); }, /neither decides nor excludes 1 of its review items/);
  // Scope fields that are present have to be well formed.
  refuses((copy) => { copy.reviewRound.revision = -1; }, /revision/);
  refuses((copy) => { copy.reviewRound.revision = 1.5; }, /revision/);
  refuses((copy) => { delete (copy.reviewRound as Partial<Scope>).complete; }, /complete/);
  refuses((copy) => { delete (exclusionOf(copy, "record.delta") as Partial<Scope["excluded"][number]>).code; }, /code/);
  refuses((copy) => { delete (decisionOf(copy, "record.alpha") as Partial<{ actor: unknown }>).actor; }, /actor/);

  // The honest export's attribution is carried whole.
  const projection = memoryClaimsFromReviewedExport(honest);
  const alpha = one(projection, "record.alpha");
  assert.ok(alpha.origin.kind === "reviewed-claim");
  assert.deepEqual(alpha.origin.attribution, (honest.reviewRound as unknown as Scope).decisions.find((entry) => entry.claimId === alpha.origin.surfaceClaimId));
});

test("a complete round says so, and the evidence has to cite the proposal the decision selected", async () => {
  const run = await conflictRun("memory-complete");
  const service = await openRun(run);
  let snapshot: ReviewQueueSessionState;
  try {
    snapshot = (await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1).review.snapshot as unknown as ReviewQueueSessionState;
  } finally { await service.close(); }
  const conflict = snapshot.items.find((item) => item.spec.candidates.length > 1)!;
  const [rival, chosen] = conflict.spec.candidates;
  await decide(run, {
    [conflict.metadata.name]: "select-proposed",
    ...Object.fromEntries(snapshot.items.filter((item) => item !== conflict).map((item) => [item.metadata.name, "accept-proposed"])),
  }, { [conflict.metadata.name]: chosen!.id });
  const exported = await reviewedExport(run);
  const complete = memoryClaimsFromReviewedExport(exported);
  assert.equal(complete.reviewRound.complete, true);
  assert.deepEqual(complete.claims.map((entry) => entry.arrival), ["reviewed", "reviewed"]);

  // v3 evidence regenerated through Surface to cite the unchosen proposal is valid evidence of a different claim.
  const copy = clone(exported) as unknown as ReviewedExportV1 & { bundle: Bundle };
  const status = copy.bundle.claims.find((claim) => claim.fieldOrBehavior === "record.status")!;
  const index = copy.bundle.evidence.findIndex((entry) => entry.claimId === status.id && entry.metadata?.reviewedExtraction);
  const restored = restoreReviewedExtractionEvidence(copy.bundle.evidence[index] as never);
  const rivalIndex = (rival!.producer!["survey.kontourai.io/extraction-envelope"] as { proposalIndex: number }).proposalIndex;
  restored.proposalIndex = rivalIndex;
  copy.bundle.evidence[index] = projectReviewedExtractionEvidence(restored, { profile: reviewedExtractionEvidenceChoiceProfile, includeImportRecord: true }).evidence as never;
  rebindReceipt(copy as never);
  assert.throws(() => memoryClaimsFromReviewedExport(copy), /cites a proposal other than the candidate its Survey decision selected/);

  // A decision that names no candidate cannot state a value.
  const none = clone(exported) as unknown as ReviewedExportV1 & { bundle: Bundle };
  const entry = none.bundle.evidence.findIndex((item) => item.claimId === none.bundle.claims.find((claim) => claim.fieldOrBehavior === "record.alpha")!.id && item.metadata?.reviewedExtraction);
  const single = restoreReviewedExtractionEvidence(none.bundle.evidence[entry] as never);
  delete (single.reviewDecision!.spec as { candidateId?: string }).candidateId;
  none.bundle.evidence[entry] = projectReviewedExtractionEvidence(single).evidence as never;
  rebindReceipt(none as never);
  assert.throws(() => memoryClaimsFromReviewedExport(none), /selects no candidate/);
});

test("two items stating the same value from the same span are one claim, and the duplicate is reported", async () => {
  const run = await indexedItemsRun("memory-identical", true);
  const queue = await queueOf(run);
  await decide(run, { [queue.find((item) => item.fieldPath === "record.status")!.name]: "accept-proposed" });
  const projection = memoryClaimsFromReviewedExport(await reviewedExport(run));
  assert.deepEqual(byProperty(projection, "record.items[]").map((entry) => [entry.claim.value, entry.arrival]), [["one", "proposed"]]);
  assert.deepEqual(projection.withheld.map((item) => item.reason), ["duplicate-claim"]);
  assert.equal(new Set(projection.claims.map((entry) => entry.claim.id)).size, projection.claims.length);
});

test("an honest export from every example task projects, with a claim per item and arrival following the decisions", async () => {
  for (const example of (await readdir("examples", { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    for (const mode of ["all-decided", "half-decided"] as const) {
      const root = await tempRoot(`memory-example-${example}`);
      const { runDirectory } = await runFieldwork({ taskPath: join("examples", example, "task.json"), sourcePath: join("examples", example, "source.txt"), root });
      const queue = await queueOf(runDirectory);
      const decided = queue.filter((_, index) => mode === "all-decided" || index % 2 === 0);
      await decide(runDirectory, Object.fromEntries(decided.map((item) => [item.name, "accept-proposed"])));
      const projection = memoryClaimsFromReviewedExport(await reviewedExport(runDirectory));
      const label = `${example} ${mode}`;
      assert.equal(projection.claims.filter((entry) => entry.arrival === "reviewed").length, decided.length, label);
      assert.equal(projection.claims.filter((entry) => entry.arrival === "proposed").length, queue.length - decided.length, label);
      assert.equal(projection.claims.every((entry) => entry.claim.posture === "stated"), true, label);
      assert.deepEqual(projection.withheld, [], label);
    }
  }
});

test("an honest export with a rival Survey excluded, all items decided, projects that claim as proposed with the receipt's gap", async () => {
  const run = await forgedUnverifiedConflictRun("memory-excluded-rival-decided");
  await decide(run, Object.fromEntries((await queueOf(run)).map((item) => [item.name, "accept-proposed"])));
  const exported = await reviewedExport(run);
  const projection = memoryClaimsFromReviewedExport(exported);
  const status = one(projection, "record.status");
  assert.deepEqual([status.claim.value, status.arrival], ["Paused", "proposed"]);
  assert.ok(status.origin.kind === "reviewed-claim");
  assert.deepEqual([status.origin.surfaceStatus, status.origin.groundingGaps], ["disputed", ["excluded-rival-unresolved"]]);
  assert.equal(one(projection, "record.alpha").arrival, "reviewed");
  assert.equal(projection.reviewRound.complete, true);
});

test("a conflict nobody could confirm, or that was rejected whole, is withheld, and the rest of the round still maps", async () => {
  for (const decision of ["reject-proposed", "could-not-confirm"] as const) {
    const run = await conflictRun(`memory-${decision}`);
    const queue = await queueOf(run);
    const conflict = queue.find((item) => item.candidateCount > 1)!;
    await decide(run, Object.fromEntries(queue.map((item) => [item.name, item === conflict ? decision : "accept-proposed"])), undefined, { [conflict.name]: "Neither value can be confirmed." });
    const exported = await reviewedExport(run);
    const status = (exported.bundle as unknown as Bundle).claims.find((claim) => claim.fieldOrBehavior === "record.status")!;
    assert.equal(status.status, decision === "reject-proposed" ? "rejected" : "disputed");
    const projection = memoryClaimsFromReviewedExport(exported);
    assert.deepEqual(projection.claims.map((entry) => [entry.claim.property, entry.arrival]), [["record.alpha", "reviewed"]], decision);
    assert.deepEqual(projection.withheld.map((item) => [item.reason, item.fieldPath]), [[decision === "reject-proposed" ? "rejected-in-review" : "no-reviewed-evidence", "record.status"]], decision);
  }
});

test("exports Fieldwork 0.13.0 wrote, and decisions made under a configured reviewer, project without a false refusal", async () => {
  // Written by the published release, not by this checkout: the exports are the real shape of an older writer.
  const fixture = join(import.meta.dirname, "fixtures", "fieldwork-0.13.0");
  const recorded = JSON.parse(await readFile(join(fixture, "exports.json"), "utf8")) as Record<string, { runDirectory: string; sha256?: string }>;
  const root = await tempRoot("memory-stored-0.13");
  await cp(join(fixture, "runs"), root, { recursive: true });
  const projected: string[] = [];
  for (const [name, entry] of Object.entries(recorded)) {
    if (entry.sha256 === undefined) continue;
    const exported = await reviewedExport(join(root, entry.runDirectory));
    const projection = memoryClaimsFromReviewedExport(exported);
    const statuses = (exported.bundle as unknown as Bundle).claims.map((claim) => claim.status);
    assert.equal(projection.claims.length + projection.withheld.filter((item) => item.reason !== "excerpt-not-verified").length >= statuses.length, true, name);
    projected.push(`${name}:${projection.claims.length}`);
  }
  assert.equal(projected.length >= 4, true, projected.join(" "));

  // A named reviewer: the event actor, the decision's actor and the attribution all name them.
  const run = await runFieldwork({ taskPath: "examples/vendor-obligations/task.json", sourcePath: "examples/vendor-obligations/source.txt", root: await tempRoot("memory-named") });
  const service = await openRun(run.runDirectory, { reviewer: { id: "alice", kind: "human" } });
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: Object.fromEntries(snapshot.items.filter((_, index) => index % 2 === 0).map((item) => [item.metadata.name, "accept-proposed"])) } as never);
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally { await service.close(); }
  const named = memoryClaimsFromReviewedExport(await reviewedExport(run.runDirectory));
  const reviewed = named.claims.filter((entry) => entry.arrival === "reviewed");
  assert.equal(reviewed.length > 0 && reviewed.length < named.claims.length, true);
  for (const entry of reviewed) {
    assert.ok(entry.origin.kind === "reviewed-claim");
    assert.equal(entry.origin.reviewDecision.actorId, "alice");
  }
});

test("an export that carries two sources' import records is refused rather than attributed to one", async () => {
  const first = clone(await reviewedExport(await decidedMixedRun("two-sources-a"))) as unknown as ReviewedExportV1 & { bundle: Bundle & Record<string, unknown[]>; reviewRound: Scope };
  const second = await reviewedExport(await decidedMixedRun("two-sources-b", "a second snapshot\n")) as unknown as { bundle: Record<string, unknown[]>; reviewRound: Scope };
  for (const key of ["claims", "evidence", "events"]) first.bundle[key]!.push(...second.bundle[key]!);
  first.reviewRound.excluded = second.reviewRound.excluded;
  assert.throws(() => memoryClaimsFromReviewedExport(first), /carries 2 import records/);
});

test("a value that is not a reviewed export is refused", () => {
  assert.throws(() => memoryClaimsFromReviewedExport({} as never));
  assert.throws(() => memoryClaimsFromReviewedExport({ apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedExport", bundle: {}, reviewedGrounding: {}, reviewRound: {} }));
});

test("the documented mapping pins the same Knowledge Kit commit the code does", async () => {
  const doc = await readFile("docs/memory-source.md", "utf8");
  assert.ok(doc.includes(MEMORY_CLAIM_SCHEMA_PIN.commit), "docs/memory-source.md must name the pinned commit");
  assert.ok(doc.includes(MEMORY_CLAIM_SCHEMA_PIN.schema));
});
