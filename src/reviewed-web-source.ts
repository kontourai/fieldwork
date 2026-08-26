import { createHash } from "node:crypto";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { parseSnapshotSourceRef, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { enumerateExactOccurrences, resolvePreparedArtifact } from "@kontourai/traverse";
import { canonicalJson } from "./contracts.js";
import { projectAttestedReviewedProjection } from "./fieldwork.js";
import { currentReviewFence, readRun, readRunMetadata } from "./run-store.js";
import { restoreReviewedExtractionEvidence } from "@kontourai/surface";
import type { ReviewedWebSourceInspection, ReviewedWebSourceRefs, ReviewedWebSourceResult } from "./reviewed-web-source-contract.js";
import { REVIEWED_WEB_SOURCE_MAX_PAGES, REVIEWED_WEB_SOURCE_PAGE_CHARS } from "./fieldwork-limits.js";

const PAGE_CHARS = REVIEWED_WEB_SOURCE_PAGE_CHARS;
const MAX_PAGES = REVIEWED_WEB_SOURCE_MAX_PAGES;

export interface ReviewedWebSourceOwner {
  /** Host-configured directories; no client request can select either one. */
  readonly runDirectory: string;
  readonly snapshotRoot: string;
  authorize(request: { readonly operation: "list" | "describe" | "inspect"; readonly exactRef?: string }): boolean | Promise<boolean>;
}

export type { ReviewedWebSourceInspection, ReviewedWebSourceRefs, ReviewedWebSourceResult } from "./reviewed-web-source-contract.js";

/** A configured owner is the only authority that can resolve opaque source refs. */
export class ReviewedWebSourceReader {
  constructor(private readonly owner: ReviewedWebSourceOwner) {}

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
    try { found = await this.metadata(exactRef); }
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
    try { found = await this.metadata(exactRef); }
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

  private async metadata(exactRef: string) {
    const stored = await readRunMetadata(this.owner.runDirectory);
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
      return { run: stored.run, captureRef, proposal, proposalIndex: index, candidateId: evidence.candidate.id, evidence };
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
}

function opaqueRef(runResource: string, captureRef: string, preparedRef: string, digest: string, proposalIndex: number, occurrence: unknown): string {
  return `fieldwork-reviewed-source:v1:${createHash("sha256").update(canonicalJson({ runResource, captureRef, preparedRef, digest, proposalIndex, occurrence })).digest("hex")}`;
}
function isExactRef(value: string): boolean { return /^fieldwork-reviewed-source:v1:[a-f0-9]{64}$/.test(value); }
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
