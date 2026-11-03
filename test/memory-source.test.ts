import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1, ReviewedExportV1 } from "../src/api-contracts.js";
import { reviewedExport } from "../src/fieldwork.js";
import { MEMORY_CLAIM_SCHEMA_PIN, memoryClaimId, memoryClaimsFromReviewedExport, type MemorySourceProjection } from "../src/memory-source.js";
import { openRun } from "../src/server.js";
import { apiFetch } from "./helpers.js";
import { conflictRun } from "./helpers/conflict-run.js";
import { decide, decidedMixedRun, forgedUnverifiedConflictRun, queueOf } from "./helpers/memory-source-run.js";
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
  delta: "sha256:f77445e84dbe007c9eb9985c8ff831d4585883ce71f03c97cc4a8406af07a888",
  statusActive: "sha256:19e42d1d34ec8a7916dabe5d2ef2716af82648f8e8ac45f1d9af3d19bbfcad89",
  statusPaused: "sha256:4e057a7a8885201c8fbd9a1a7bc38d98371c7ed36cc11c95207750fb96052201",
};

/** Every top-level key of the pinned schema this mapping may fill; the schema forbids any other. */
const SCHEMA_KEYS = ["schema_version", "id", "subject", "claimType", "property", "value", "speaker", "source", "posture"];
const SOURCE_KEYS = ["ref", "locator", "excerpt", "observedAt", "extractor"];

interface Bundle {
  claims: { id: string; fieldOrBehavior: string; value: unknown; status: string; subjectType: string; subjectId: string; claimType: string }[];
  evidence: { claimId: string; evidenceType: string; sourceRef: string; sourceLocator: string; excerptOrSummary: string; metadata?: Record<string, unknown> }[];
}
interface Scope { revision: number; complete: boolean; excluded: { fieldPath: string; itemNames: string[]; code: string }[]; decisions: { claimId: string }[] }

const byProperty = (projection: MemorySourceProjection, property: string) => projection.claims.filter((entry) => entry.claim.property === property);
const one = (projection: MemorySourceProjection, property: string) => {
  const found = byProperty(projection, property);
  assert.equal(found.length, 1, `${property}: ${found.length} claims`);
  return found[0]!;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("a mixed round maps reviewed claims as stated and unreviewed items as proposed, and the round trips back to the export", async () => {
  const exported = await reviewedExport(await decidedMixedRun("round-trip"));
  const projection = memoryClaimsFromReviewedExport(exported);
  const bundle = exported.bundle as unknown as Bundle;
  const scope = exported.reviewRound as unknown as Scope;

  // The posture each property arrives with, and the id the Kit gives the same claim.
  const kitIdOf = (entry: MemorySourceProjection["claims"][number]) => {
    const { id: _id, ...content } = entry.claim;
    assert.equal(entry.claim.id, memoryClaimId(content), "the id is the digest of the claim as emitted");
    return memoryClaimId({ ...content, source: { ...content.source, observedAt: FIXED_OBSERVED_AT } });
  };
  assert.deepEqual(
    projection.claims.map((entry) => [entry.claim.property, entry.claim.value, entry.claim.posture, kitIdOf(entry)]),
    [
      ["record.alpha", "alpha-value", "stated", KIT_IDS.alpha],
      ["record.charlie", "charlie-value", "stated", KIT_IDS.charlie],
      ["record.delta", "delta-value", "proposed", KIT_IDS.delta],
      ["record.status", "Active", "proposed", KIT_IDS.statusActive],
      ["record.status", "Paused", "proposed", KIT_IDS.statusPaused],
    ],
  );

  // Round trip: what the export said about each field is what the claims say, derived from the export
  // itself and not from the constants above. Verified claims are stated, undecided items proposed,
  // and a rejected claim is not remembered at all.
  const fromExport = new Map<string, string>();
  for (const claim of bundle.claims) if (claim.status === "verified") fromExport.set(claim.fieldOrBehavior, "stated");
  for (const exclusion of scope.excluded) {
    assert.equal(exclusion.code, "EXPORT_UNDECIDED");
    fromExport.set(exclusion.fieldPath, "proposed");
  }
  assert.deepEqual(
    new Map(projection.claims.map((entry) => [entry.claim.property, entry.claim.posture])),
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
  assert.deepEqual(status.map((entry) => [entry.claim.value, entry.claim.posture, entry.claim.source.excerpt]), [
    ["Active", "proposed", "Status: Active"],
    ["Paused", "proposed", "Status: Paused"],
  ]);
  assert.notEqual(status[0]!.claim.source.locator, status[1]!.claim.source.locator);
});

test("a chosen conflict value arrives stated on its own span, and the rival is not remembered", async () => {
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
  assert.equal(status.claim.posture, "stated");
  assert.equal(status.claim.source.excerpt, "Status: Paused");
  assert.equal(projection.claims.some((entry) => entry.claim.value === "Active"), false);
  assert.equal(one(projection, "record.alpha").claim.posture, "stated");
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
  assert.equal(date.claim.posture, "proposed");
  assert.ok(date.origin.kind === "reviewed-claim");
  assert.equal(date.origin.surfaceStatus, "disputed");
  assert.equal(date.origin.reviewDecision.status, "verified", "the reviewer accepted it; the export still disputes it");
  assert.deepEqual(date.origin.groundingGaps, ["schema-mismatch"]);
  assert.equal(projection.claims.filter((entry) => entry.claim.posture === "stated").length, 2);
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
  const edit = (change: (bundle: Bundle, scope: Scope) => void): MemorySourceProjection => {
    const copy = clone(honest) as unknown as { bundle: Bundle; reviewRound: Scope } & ReviewedExportV1;
    change(copy.bundle, copy.reviewRound);
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
  });
  assert.equal(propertiesOf(bare).includes("record.charlie"), false);
  assert.deepEqual(bare.withheld.filter((item) => item.reason === "no-reviewed-evidence").map((item) => item.fieldPath), ["record.charlie"]);

  // With no evidence at all there is no import record, so no undecided item can be recovered either.
  const none = edit((bundle) => { bundle.evidence = bundle.evidence.filter((entry) => !entry.metadata?.reviewedExtraction); });
  assert.deepEqual(none.claims, []);
  assert.equal(none.withheld.filter((item) => item.reason === "no-import-record").length, 2);

  // An exclusion for any reason but "no one decided it" is not an unreviewed item.
  const conflicting = edit((_bundle, scope) => { scope.excluded.find((entry) => entry.fieldPath === "record.delta")!.code = "EXPORT_CONFLICTING_DECISIONS"; });
  assert.equal(propertiesOf(conflicting).includes("record.delta"), false);
  assert.deepEqual(conflicting.withheld.filter((item) => item.reason === "excluded-after-review").map((item) => [item.fieldPath, item.detail]), [["record.delta", "EXPORT_CONFLICTING_DECISIONS"]]);
});

test("a proposal Survey excluded for an unverifiable excerpt is not remembered, and the verified one beside it is", async () => {
  const run = await forgedUnverifiedConflictRun("memory-unverified");
  const items = await queueOf(run);
  await decide(run, { [items.find((item) => item.fieldPath === "record.alpha")!.name]: "accept-proposed" });
  const exported = await reviewedExport(run);
  assert.deepEqual((exported.reviewRound as unknown as Scope).excluded.map((entry) => [entry.fieldPath, entry.code]), [["record.status", "EXPORT_UNDECIDED"]]);

  const projection = memoryClaimsFromReviewedExport(exported);
  assert.deepEqual(byProperty(projection, "record.status").map((entry) => [entry.claim.value, entry.claim.posture, entry.claim.source.excerpt]), [["Paused", "proposed", "Status: Paused"]]);
  assert.equal(projection.claims.some((entry) => entry.claim.value === "Actiff"), false);
  assert.deepEqual(projection.withheld.map((item) => [item.reason, item.fieldPath]), [["excerpt-not-verified", "record.status"]]);
  assert.equal(one(projection, "record.alpha").claim.posture, "stated");
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
