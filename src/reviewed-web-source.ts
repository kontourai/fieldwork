import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { parseSnapshotSourceRef, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createObservationStore } from "@kontourai/lookout";
import { enumerateExactOccurrences, resolvePreparedArtifact } from "@kontourai/traverse";
import { canonicalJson } from "./contracts.js";
import { projectAttestedReviewedProjection } from "./fieldwork.js";
import { currentReviewFence, readRun, readRunMetadata } from "./run-store.js";
import { buildReviewedExtractionSourceState, restoreReviewedExtractionEvidence } from "@kontourai/surface";
import { FieldworkSourceCheckReceiptStore, type ReceiptV2 } from "./source-check-receipts.js";
import { parseReviewedWebSourceCurrentness, type ReviewedWebSourceCurrentness, type ReviewedWebSourceInspection, type ReviewedWebSourceRefs, type ReviewedWebSourceResult } from "./reviewed-web-source-contract.js";
import { REVIEWED_WEB_SOURCE_MAX_PAGES, REVIEWED_WEB_SOURCE_PAGE_CHARS } from "./fieldwork-limits.js";

const PAGE_CHARS = REVIEWED_WEB_SOURCE_PAGE_CHARS;
const MAX_PAGES = REVIEWED_WEB_SOURCE_MAX_PAGES;

export interface ReviewedWebSourceOwner {
  /** Host-configured directories; no client request can select either one. */
  readonly runDirectory: string;
  readonly snapshotRoot: string;
  authorize(request: { readonly operation: "list" | "describe" | "inspect"; readonly exactRef?: string }): boolean | Promise<boolean>;
  /** Optional native-only currentness capability. Existing owner operations do not use it. */
  readonly sourceChecks?: {
    readonly receiptRoot: string;
    readonly observationRoot: string;
    authorizeCurrentness(request: { readonly operation: "currentness"; readonly exactRef: string }): CurrentnessLease | Promise<CurrentnessLease>;
  };
}

export interface CurrentnessLease { isCurrent(): boolean; }

export type { ReviewedWebSourceCurrentness, ReviewedWebSourceInspection, ReviewedWebSourceRefs, ReviewedWebSourceResult } from "./reviewed-web-source-contract.js";

/** A configured owner is the only authority that can resolve opaque source refs. */
export class ReviewedWebSourceReader {
  private readonly sourceChecks: CapturedSourceChecks | undefined;
  private readonly currentnessOwner: CapturedCurrentnessOwner | undefined;

  constructor(private readonly owner: ReviewedWebSourceOwner) {
    // Do not invoke an inherited/configured accessor to discover this optional
    // authority.  Currentness is unavailable unless its whole capability is a
    // plain own-data configuration captured at construction.
    const runDirectory = Object.getOwnPropertyDescriptor(owner, "runDirectory");
    const snapshotRoot = Object.getOwnPropertyDescriptor(owner, "snapshotRoot");
    if (!runDirectory || !("value" in runDirectory) || typeof runDirectory.value !== "string"
      || !snapshotRoot || !("value" in snapshotRoot) || typeof snapshotRoot.value !== "string") return;
    this.currentnessOwner = { runDirectory: resolveRoot(runDirectory.value), snapshotRoot: resolveRoot(snapshotRoot.value) };
    const descriptor = Object.getOwnPropertyDescriptor(owner, "sourceChecks");
    if (!descriptor || !("value" in descriptor) || !isPlainRecord(descriptor.value)) return;
    const checks = descriptor.value;
    const receipt = Object.getOwnPropertyDescriptor(checks, "receiptRoot");
    const observation = Object.getOwnPropertyDescriptor(checks, "observationRoot");
    const authorize = Object.getOwnPropertyDescriptor(checks, "authorizeCurrentness");
    if (!receipt || !("value" in receipt) || typeof receipt.value !== "string"
      || !observation || !("value" in observation) || typeof observation.value !== "string"
      || !authorize || !("value" in authorize) || typeof authorize.value !== "function") return;
    this.sourceChecks = { receiptRoot: resolveRoot(receipt.value), observationRoot: resolveRoot(observation.value), authorize: authorize.value, receiver: checks };
  }

  async listReviewedWebSourceRefs(cursor?: string): Promise<ReviewedWebSourceRefs> {
    if (!validCursor(cursor)) return refs("unsupported");
    if (!await this.authorized({ operation: "list" })) return refs("restricted");
    try {
      // Retain the metadata identity with the opaque refs so the last fence
      // covers the same reviewed snapshot which was used to enumerate them.
      const { refs: all, run } = await this.reviewedRefs();
      const start = Number(cursor ?? "0");
      const entries = all.slice(start, start + 128);
      if (!await this.authorized({ operation: "list" })) return refs("restricted");
      if (!currentReviewFence(this.owner.runDirectory, run)) return refs("corrupt");
      const next = start + entries.length;
      return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceRefs", status: "available", refs: entries, truncated: next < all.length, ...(next < all.length ? { nextCursor: String(next) } : {}) };
    } catch (error) { return refs((error as NodeJS.ErrnoException).code === "UNSUPPORTED" ? "unsupported" : "corrupt"); }
  }

  async describeReviewedWebSource(exactRef: string): Promise<ReviewedWebSourceResult> {
    if (!isExactRef(exactRef)) return descriptor("unsupported");
    if (!await this.authorized({ operation: "describe", exactRef })) return descriptor("restricted");
    let found: Awaited<ReturnType<ReviewedWebSourceReader["metadata"]>>;
    try { found = await this.metadata(exactRef, this.owner.runDirectory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return descriptor(code === "ENOENT" ? "missing" : code === "UNSUPPORTED" ? "unsupported" : "corrupt");
    }
    if (!found) return descriptor("missing");
    if (!await this.authorized({ operation: "describe", exactRef })) return descriptor("restricted");
    if (!currentReviewFence(this.owner.runDirectory, found.run)) return descriptor("missing");
    return {
      apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status: "available", exactRef,
      runResource: found.run.runResource, captureRef: found.captureRef,
      preparedArtifact: closedPrepared(found.run.preparedArtifact),
      review: { revision: found.run.review.revision, state: "reviewed" },
      evidence: found.evidence,
      // Metadata binds claims to an artifact but deliberately does not read its bytes.
      integrity: { state: "unchecked" }, inspection: { pageChars: PAGE_CHARS, maxPages: MAX_PAGES },
    };
  }

  async inspectReviewedWebSource(exactRef: string, cursor?: string): Promise<ReviewedWebSourceInspection> {
    if (!isExactRef(exactRef) || !validCursor(cursor)) return inspection("unsupported");
    if (!await this.authorized({ operation: "inspect", exactRef })) return inspection("restricted");
    let found: Awaited<ReturnType<ReviewedWebSourceReader["metadata"]>>;
    try { found = await this.metadata(exactRef, this.owner.runDirectory); }
    catch (error) { return inspection((error as NodeJS.ErrnoException).code === "UNSUPPORTED" ? "unsupported" : "corrupt"); }
    if (!found) return inspection("missing");
    try {
      // Exact replay is local Forage storage only. It never calls fetch().
      const store = createFilesystemSnapshotStore({ root: this.owner.snapshotRoot });
      const replay = await resolveSnapshotSourceRef(store, found.captureRef);
      if (!replay.ok) return inspection(replay.error.kind === "snapshot-store-error" ? "storage-unavailable" : replay.error.kind === "snapshot-not-found" ? "missing" : "corrupt");
      const bytes = typeof replay.snapshot.body === "string" ? Buffer.from(replay.snapshot.body) : replay.snapshot.body;
      if (createHash("sha256").update(bytes).digest("hex") !== replay.reference.bodyHash) return inspection("digest-mismatch");
      const stored = await readRun(this.owner.runDirectory);
      const resolution = await resolvePreparedArtifact(stored.envelope.result.preparedArtifact, { get: () => stored.preparedText });
      if (resolution.status === "digest-mismatch") return inspection("digest-mismatch");
      if (resolution.status !== "available" || resolution.artifact.ref !== found.run.preparedArtifact.ref) return inspection("corrupt");
      if (!matchesOccurrence(stored.preparedText, found.proposal)) return inspection("corrupt");
      // Rebuild the same attested Survey-to-Surface projection exported to
      // consumers; it binds this exact proposal index, candidate, decision,
      // prepared artifact, and capture instead of equating display text.
      if (!found.evidence) return inspection("missing");
      const currentAttested = projectAttestedReviewedProjection(stored);
      if (currentAttested.enrichment.grounding.outcome === "not-evaluated") return inspection("unsupported");
      const stillSelected = currentAttested.enrichment.additionalEvidence
        .map((entry) => closedEvidence(entry, found.proposalIndex))
        .some((entry) => entry?.id === found.evidence.id && entry.candidate.id === found.candidateId);
      if (!stillSelected) return inspection("missing");
      if (!await this.authorized({ operation: "inspect", exactRef })) return inspection("restricted");
      // No awaits after authorization: this bounded fence sees any appended
      // accept/reject event that raced the authorization promise.
      if (!currentReviewFence(this.owner.runDirectory, stored.run)) return inspection("missing");
      const page = Number(cursor ?? "0");
      const totalPages = Math.ceil(stored.preparedText.length / PAGE_CHARS);
      // An empty source has one explicit, empty page range. For every other
      // source a cursor at/after the end is not an attested page response.
      if ((totalPages === 0 && page !== 0) || (totalPages > 0 && page >= totalPages)) return inspection("unsupported");
      const pages = Array.from({ length: Math.min(MAX_PAGES, Math.max(0, totalPages - page)) }, (_, offset) => {
        const index = page + offset; const start = index * PAGE_CHARS; const end = Math.min(stored.preparedText.length, start + PAGE_CHARS);
        return { index, start, end, text: stored.preparedText.slice(start, end) };
      });
      const next = page + pages.length;
      return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "available", exactRef, integrity: "verified", pages, totalPages, ...(next < totalPages ? { nextCursor: String(next) } : {}), truncated: next < totalPages };
    } catch { return inspection("storage-unavailable"); }
  }

  /**
   * Read one completed v2 receipt as an owner-head as-of fact. This performs
   * no fetch, body replay, proposal-body read, write, recovery, or repair.
   */
  async readReviewedWebSourceCurrentness(exactRef: string): Promise<ReviewedWebSourceCurrentness> {
    if (!isExactRef(exactRef)) return currentness("unsupported");
    const checks = this.sourceChecks, currentnessOwner = this.currentnessOwner;
    if (!checks || !currentnessOwner) return currentness("unsupported");
    const initial = await this.currentnessLease(checks, exactRef);
    if (!initial || !leaseCurrent(initial)) return currentness("restricted");
    let found: Awaited<ReturnType<ReviewedWebSourceReader["metadata"]>>;
    try { found = await this.metadata(exactRef, currentnessOwner.runDirectory); }
    catch (error) { return currentness(metadataFailure(error)); }
    if (!found) return currentness("missing");

    const original = oldReviewedCapture(found.surfaceEvidence);
    if (!original) return currentness("missing-digest");
    const receipts = new FieldworkSourceCheckReceiptStore(checks.receiptRoot);
    let stored: Awaited<ReturnType<FieldworkSourceCheckReceiptStore["readCurrentWithWitness"]>>;
    try { stored = await receipts.readCurrentWithWitness(original.sourceId); }
    catch { return currentness("storage-unavailable"); }
    if (stored.kind !== "available") return currentness(receiptFailure(stored.kind));
    if (!sameSource(original.sourceId, original.resourceRef, stored.receipt.currentCapture.sourceId, stored.receipt.currentCapture.url)) return currentness("incompatible-source");
    if (!stored.receipt.acquisitionHead.headSnapshotRef.snapshotDigest) return currentness("missing-digest");

    const snapshots = createFilesystemSnapshotStore({ root: currentnessOwner.snapshotRoot });
    const observations = createObservationStore({ root: checks.observationRoot });
    const firstHeads = await compareHeads(snapshots, observations, stored.receipt);
    if (firstHeads !== "matches") return currentness(firstHeads);

    const observation = reviewedSourceObservation(original, stored.receipt);
    try { buildReviewedExtractionSourceState(found.surfaceEvidence, observation, stored.receipt.checkedAt); }
    catch { return currentness("incompatible-source"); }

    const final = await this.currentnessLease(checks, exactRef);
    if (!final || !leaseCurrent(final)) return currentness("restricted");
    const finalHeads = await compareHeads(snapshots, observations, stored.receipt);
    if (finalHeads !== "matches") return currentness(finalHeads);
    let receiptFence: Awaited<ReturnType<FieldworkSourceCheckReceiptStore["compareCurrentWitness"]>>;
    try { receiptFence = await receipts.compareCurrentWitness(stored.witness); }
    catch { return currentness("storage-unavailable"); }
    if (receiptFence.kind !== "matches") return currentness(receiptFence.kind === "superseded" ? "receipt-superseded" : receiptFailure(receiptFence.kind));

    // This is deliberately synchronous: no await may reopen the original
    // review or borrowed leases after the final as-of fences.
    if (!currentReviewFence(currentnessOwner.runDirectory, found.run)) return currentness("missing");
    if (!leaseCurrent(initial) || !leaseCurrent(final)) return currentness("restricted");
    const result: ReviewedWebSourceCurrentness = {
      apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status: "available",
      exactRef, evidenceId: found.surfaceEvidence.id, reviewRevision: found.run.review.revision,
      checkedAt: stored.receipt.checkedAt, observationRef: observationRef(observation),
      scope: "local-owner-heads-as-of", captureIntegrity: "not-rechecked", sourceObservation: observation,
    };
    try { return parseReviewedWebSourceCurrentness(result); }
    catch { return currentness("limits-exceeded"); }
  }

  private async metadata(exactRef: string, runDirectory: string) {
    const stored = await readRunMetadata(runDirectory);
    const captureRef = stored.envelope.source.snapshotRef;
    if (!captureRef || !parseSnapshotSourceRef(captureRef)) return undefined;
    const attested = projectAttestedReviewedProjection(stored);
    if (attested.enrichment.grounding.outcome === "not-evaluated") throw unsupportedReviewedShape();
    for (let index = 0; index < stored.envelope.result.proposals.length; index++) {
      const proposal = stored.envelope.result.proposals[index]!;
      const ref = opaqueRef(stored.run.runResource, captureRef, stored.run.preparedArtifact.ref, stored.run.preparedArtifact.digest, index, proposal.provenance.occurrence);
      if (ref !== exactRef) continue;
      const evidence = attested.enrichment.additionalEvidence.map((entry) => closedEvidence(entry, index)).find((entry): entry is NonNullable<ReturnType<typeof closedEvidence>> => entry !== undefined);
      if (!evidence) return undefined;
      const surfaceEvidence = attested.enrichment.additionalEvidence.find((entry) => entry.id === evidence.id);
      if (!surfaceEvidence) return undefined;
      return { run: stored.run, captureRef, proposal, proposalIndex: index, candidateId: evidence.candidate.id, evidence, surfaceEvidence };
    }
    return undefined;
  }

  private async reviewedRefs(): Promise<{ readonly refs: string[]; readonly run: Awaited<ReturnType<typeof readRunMetadata>>["run"] }> {
    const stored = await readRunMetadata(this.owner.runDirectory);
    const captureRef = stored.envelope.source.snapshotRef;
    if (!captureRef || !parseSnapshotSourceRef(captureRef)) return { refs: [], run: stored.run };
    const attested = projectAttestedReviewedProjection(stored);
    if (attested.enrichment.grounding.outcome === "not-evaluated") throw unsupportedReviewedShape();
    return { run: stored.run, refs: stored.envelope.result.proposals.flatMap((proposal, index) => {
      const evidence = attested.enrichment.additionalEvidence.map((entry) => closedEvidence(entry, index)).find((entry): entry is NonNullable<ReturnType<typeof closedEvidence>> => entry !== undefined);
      return evidence
        ? [opaqueRef(stored.run.runResource, captureRef, stored.run.preparedArtifact.ref, stored.run.preparedArtifact.digest, index, proposal.provenance.occurrence)] : [];
    }) };
  }

  /** Authorization failures deliberately have the same closed public result as denial. */
  private async authorized(request: { readonly operation: "list" | "describe" | "inspect"; readonly exactRef?: string }): Promise<boolean> {
    try { return await this.owner.authorize(request); }
    catch { return false; }
  }

  private async currentnessLease(checks: CapturedSourceChecks, exactRef: string): Promise<CapturedLease | undefined> {
    try {
      const lease = await Reflect.apply(checks.authorize, checks.receiver, [{ operation: "currentness", exactRef }]);
      return captureLease(lease);
    } catch { return undefined; }
  }
}

interface CapturedSourceChecks { readonly receiptRoot: string; readonly observationRoot: string; readonly authorize: Function; readonly receiver: object; }
interface CapturedCurrentnessOwner { readonly runDirectory: string; readonly snapshotRoot: string; }

function opaqueRef(runResource: string, captureRef: string, preparedRef: string, digest: string, proposalIndex: number, occurrence: unknown): string {
  return `fieldwork-reviewed-source:v1:${createHash("sha256").update(canonicalJson({ runResource, captureRef, preparedRef, digest, proposalIndex, occurrence })).digest("hex")}`;
}
function isExactRef(value: unknown): value is string { return typeof value === "string" && /^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/.test(value); }
function validCursor(value: string | undefined): boolean { return value === undefined || /^(?:0|[1-9][0-9]{0,5})$/.test(value); }
function descriptor(status: Exclude<ReviewedWebSourceResult["status"], "available">): ReviewedWebSourceResult { return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status }; }
function inspection(status: Exclude<ReviewedWebSourceInspection["status"], "available">): ReviewedWebSourceInspection { return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status }; }
function refs(status: Exclude<ReviewedWebSourceRefs["status"], "available">): ReviewedWebSourceRefs { return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceRefs", status }; }
function matchesOccurrence(text: string, proposal: { provenance: { excerpt: string; occurrence: { selected: { start: number; end: number }; count: number } } }): boolean {
  const { excerpt, occurrence } = proposal.provenance; const { start, end } = occurrence.selected;
  if (start < 0 || end < start || text.slice(start, end) !== excerpt) return false;
  const exact = enumerateExactOccurrences(text, excerpt);
  return exact.length === occurrence.count && exact.some(entry => entry.start === start && entry.end === end);
}

function closedPrepared(value: { ref: string; digest: string; contentLength: number; file: "prepared.txt" }): { ref: string; digest: string; contentLength: number } {
  return { ref: value.ref, digest: value.digest, contentLength: value.contentLength };
}

function closedEvidence(entry: Parameters<typeof restoreReviewedExtractionEvidence>[0], expectedProposalIndex: number) {
  const restored = restoreReviewedExtractionEvidence(entry);
  if (restored.proposalIndex !== expectedProposalIndex || restored.reviewDecision?.spec.status !== "verified" || !restored.reviewItem || !restored.reviewDecision) return undefined;
  const proposal = restored.importRecord.spec.envelope.result.proposals[restored.proposalIndex];
  const candidate = restored.reviewItem.spec.candidates.find((value) => value.id === restored.reviewDecision!.spec.candidateId);
  if (!proposal || !candidate) return undefined;
  return {
    id: entry.id, claimId: restored.claimId, proposalIndex: restored.proposalIndex,
    import: { name: restored.importRecord.metadata.name }, candidate: { id: candidate.id },
    reviewItem: { name: restored.reviewItem.metadata.name }, reviewDecision: { name: restored.reviewDecision.metadata.name },
    locator: { scheme: "traverse-exact-occurrence-v1", locator: proposal.provenance.locator, occurrence: {
      index: proposal.provenance.occurrence.selected.index, count: proposal.provenance.occurrence.count,
      start: proposal.provenance.occurrence.selected.start, end: proposal.provenance.occurrence.selected.end,
    } },
  };
}

function unsupportedReviewedShape(): Error {
  return Object.assign(new Error("Reviewed source metadata is unsupported for this review shape"), { code: "UNSUPPORTED" });
}

type ClosedCurrentness = Exclude<ReviewedWebSourceCurrentness, { readonly status: "available" }> ["status"];
function currentness(status: ClosedCurrentness): ReviewedWebSourceCurrentness { return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceCurrentness", status }; }
function resolveRoot(value: string): string { return resolve(value); }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
interface CapturedLease { readonly isCurrent: Function; readonly receiver: object; }
function captureLease(value: unknown): CapturedLease | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const receiver = value as object;
  let candidate: object | null = receiver;
  while (candidate !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, "isCurrent");
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function"
      ? { isCurrent: descriptor.value, receiver } : undefined;
    candidate = Object.getPrototypeOf(candidate);
  }
  return undefined;
}
function leaseCurrent(lease: CapturedLease): boolean {
  try {
    // A borrowed lease is never disposed or renewed here. A promise is not a
    // synchronous lease assertion and must fail closed rather than be truthy.
    return Reflect.apply(lease.isCurrent, lease.receiver, []) === true;
  } catch { return false; }
}
function metadataFailure(error: unknown): ClosedCurrentness {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" ? "missing" : code === "UNSUPPORTED" ? "unsupported" : code === "EFBIG" ? "limits-exceeded" : "corrupt";
}
function receiptFailure(kind: string): ClosedCurrentness {
  return kind === "missing" ? "no-check"
    : kind === "pending" ? "check-pending"
      : kind === "legacy" ? "legacy-receipt"
        : kind === "superseded" ? "receipt-superseded"
          : kind === "unavailable" ? "check-failed"
            : kind === "unsupported" ? "unsupported"
              : kind === "corrupt" ? "corrupt" : "unavailable";
}

function oldReviewedCapture(evidence: Parameters<typeof buildReviewedExtractionSourceState>[0]) {
  try {
    const restored = restoreReviewedExtractionEvidence(evidence);
    const snapshotRef = restored.importRecord.spec.envelope.source.snapshotRef;
    if (!snapshotRef) return undefined;
    const parsed = parseSnapshotSourceRef(snapshotRef);
    if (!parsed?.snapshotDigest) return undefined;
    return {
      snapshotRef, sourceId: parsed.sourceId, resourceRef: parsed.url, capturedAt: parsed.fetchedAt,
      envelopeDigest: { algorithm: "sha256" as const, value: parsed.snapshotDigest },
      contentDigest: { algorithm: "sha256" as const, value: parsed.bodyHash },
    };
  } catch { return undefined; }
}
function sameSource(expectedSource: string, expectedResource: string, observedSource: string, observedResource: string): boolean {
  return expectedSource === observedSource && expectedResource === observedResource;
}
async function compareHeads(
  snapshots: ReturnType<typeof createFilesystemSnapshotStore>,
  observations: ReturnType<typeof createObservationStore>,
  receipt: ReceiptV2,
): Promise<ClosedCurrentness | "matches"> {
  try {
    const forage = await snapshots.compareHeadWitness(receipt.acquisitionHead);
    if (forage.kind !== "matches") return headFailure(forage.kind);
    const lookout = await observations.compareHeadWitness(receipt.proposalHead);
    if (lookout.kind !== "matches") return headFailure(lookout.kind);
    return "matches";
  } catch { return "storage-unavailable"; }
}
function headFailure(kind: string): ClosedCurrentness {
  return kind === "changed" ? "head-changed"
    : kind === "missing" ? "no-check"
      : kind === "unsupported" ? "unsupported"
        : kind === "corrupt" ? "corrupt"
          : kind === "unavailable" ? "unavailable" : "unavailable";
}
function reviewedSourceObservation(expected: NonNullable<ReturnType<typeof oldReviewedCapture>>, receipt: ReceiptV2) {
  const observed = {
    snapshotRef: receipt.currentCapture.snapshotRef, sourceId: receipt.currentCapture.sourceId,
    resourceRef: receipt.currentCapture.url, capturedAt: receipt.currentCapture.fetchedAt,
    envelopeDigest: { algorithm: "sha256" as const, value: receipt.acquisitionHead.headSnapshotRef.snapshotDigest },
    contentDigest: { algorithm: "sha256" as const, value: receipt.currentCapture.bodyHash },
  };
  const ref = `fieldwork-reviewed-source-observation:v1:${createHash("sha256").update(canonicalJson({ expected, observed, checkedAt: receipt.checkedAt, generation: receipt.generation })).digest("hex")}`;
  return { version: "surface.reviewed-source-observation/v1" as const, owner: { authority: "fieldwork-source-check-receipt/v2", observationRef: ref }, expected, observed };
}
function observationRef(observation: ReturnType<typeof reviewedSourceObservation>): string { return observation.owner.observationRef; }
