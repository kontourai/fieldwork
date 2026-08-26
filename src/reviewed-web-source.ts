import { createHash } from "node:crypto";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { parseSnapshotSourceRef, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { resolvePreparedArtifact } from "@kontourai/traverse";
import { deriveServerReviewSessionApplyResult } from "@kontourai/survey/review-workbench/server-review-session";
import { canonicalJson } from "./contracts.js";
import { FIELDWORK_SOURCE_KIND, importNameFor, reviewSessionRecord } from "./fieldwork.js";
import { readRun, readRunMetadata } from "./run-store.js";
import { importExtractionEnvelope } from "@kontourai/survey";

const PAGE_CHARS = 16_384;
const MAX_PAGES = 8;

export interface ReviewedWebSourceOwner {
  /** Host-configured directories; no client request can select either one. */
  readonly runDirectory: string;
  readonly snapshotRoot: string;
  authorize(request: { readonly operation: "list" | "describe" | "inspect"; readonly exactRef?: string }): boolean | Promise<boolean>;
}

export type ReviewedWebSourceResult =
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceDescriptor"; readonly status: "available"; readonly exactRef: string; readonly runResource: string; readonly captureRef: string; readonly preparedArtifact: { readonly ref: string; readonly digest: string; readonly contentLength: number }; readonly review: { readonly revision: number; readonly state: "reviewed" }; readonly integrity: { readonly state: "unchecked" }; readonly inspection: { readonly pageChars: number; readonly maxPages: number } }
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceDescriptor"; readonly status: "restricted" | "missing" | "unsupported" };

export type ReviewedWebSourceInspection =
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceInspection"; readonly status: "available"; readonly exactRef: string; readonly integrity: "verified"; readonly pages: readonly { readonly index: number; readonly start: number; readonly end: number; readonly text: string }[]; readonly totalPages: number; readonly nextCursor?: string; readonly truncated: boolean }
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceInspection"; readonly status: "restricted" | "missing" | "corrupt" | "digest-mismatch" | "storage-unavailable" | "unsupported" };
export type ReviewedWebSourceRefs =
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceRefs"; readonly status: "available"; readonly refs: readonly string[]; readonly truncated: boolean; readonly nextCursor?: string }
  | { readonly apiVersion: "fieldwork.kontourai.io/v1"; readonly kind: "ReviewedWebSourceRefs"; readonly status: "restricted" | "corrupt" | "unsupported" };

/** A configured owner is the only authority that can resolve opaque source refs. */
export class ReviewedWebSourceReader {
  constructor(private readonly owner: ReviewedWebSourceOwner) {}

  async listReviewedWebSourceRefs(cursor?: string): Promise<ReviewedWebSourceRefs> {
    if (!validCursor(cursor)) return refs("unsupported");
    if (!await this.owner.authorize({ operation: "list" })) return refs("restricted");
    try {
      const all = await this.reviewedRefs();
      const start = Number(cursor ?? "0");
      const entries = all.slice(start, start + 128);
      if (!await this.owner.authorize({ operation: "list" })) return refs("restricted");
      const next = start + entries.length;
      return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceRefs", status: "available", refs: entries, truncated: next < all.length, ...(next < all.length ? { nextCursor: String(next) } : {}) };
    } catch { return refs("corrupt"); }
  }

  async describeReviewedWebSource(exactRef: string): Promise<ReviewedWebSourceResult> {
    if (!isExactRef(exactRef)) return descriptor("unsupported");
    if (!await this.owner.authorize({ operation: "describe", exactRef })) return descriptor("restricted");
    const found = await this.metadata(exactRef);
    if (!found) return descriptor("missing");
    if (!await this.owner.authorize({ operation: "describe", exactRef })) return descriptor("restricted");
    return {
      apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status: "available", exactRef,
      runResource: found.run.runResource, captureRef: found.captureRef,
      preparedArtifact: found.run.preparedArtifact,
      review: { revision: found.run.review.revision, state: "reviewed" },
      // Metadata binds claims to an artifact but deliberately does not read its bytes.
      integrity: { state: "unchecked" }, inspection: { pageChars: PAGE_CHARS, maxPages: MAX_PAGES },
    };
  }

  async inspectReviewedWebSource(exactRef: string, cursor?: string): Promise<ReviewedWebSourceInspection> {
    if (!isExactRef(exactRef) || !validCursor(cursor)) return inspection("unsupported");
    if (!await this.owner.authorize({ operation: "inspect", exactRef })) return inspection("restricted");
    let found: Awaited<ReturnType<ReviewedWebSourceReader["metadata"]>>;
    try { found = await this.metadata(exactRef); } catch { return inspection("corrupt"); }
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
      if (!verifyOccurrence(stored.preparedText, found.proposal)) return inspection("corrupt");
      if (!await this.owner.authorize({ operation: "inspect", exactRef })) return inspection("restricted");
      const page = Number(cursor ?? "0");
      const totalPages = Math.ceil(stored.preparedText.length / PAGE_CHARS);
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
    const imported = importExtractionEnvelope(stored.envelope, { importName: importNameFor(stored.run), producerNamespace: "fieldwork", sourceKind: FIELDWORK_SOURCE_KIND, claimTarget: proposal => {
      const projection = stored.run.task.spec.projections.find(entry => entry.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error("unknown projection");
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }});
    const applied = deriveServerReviewSessionApplyResult({ record: reviewSessionRecord(stored.run, stored.run.review.events.length), events: stored.run.review.events, requiredResolvedItems: "all" });
    if (!applied.ok) return undefined;
    for (let index = 0; index < stored.envelope.result.proposals.length; index++) {
      const proposal = stored.envelope.result.proposals[index]!;
      const ref = opaqueRef(stored.run.runResource, captureRef, stored.run.preparedArtifact.ref, stored.run.preparedArtifact.digest, index, proposal.provenance.occurrence);
      if (ref !== exactRef) continue;
      const candidate = imported.reviewItems.flatMap(item => item.spec.candidates).find(value => value.locator?.locator === proposal.provenance.locator && value.locator?.excerpt === proposal.provenance.excerpt);
      if (!candidate || !applied.results.some(result => result.selectedCandidateId === candidate.id && result.status === "verified")) return undefined;
      return { run: stored.run, captureRef, proposal };
    }
    return undefined;
  }

  private async reviewedRefs(): Promise<string[]> {
    const stored = await readRunMetadata(this.owner.runDirectory);
    const captureRef = stored.envelope.source.snapshotRef;
    if (!captureRef || !parseSnapshotSourceRef(captureRef)) return [];
    const imported = importExtractionEnvelope(stored.envelope, { importName: importNameFor(stored.run), producerNamespace: "fieldwork", sourceKind: FIELDWORK_SOURCE_KIND, claimTarget: proposal => {
      const projection = stored.run.task.spec.projections.find(entry => entry.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error("unknown projection");
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }});
    const applied = deriveServerReviewSessionApplyResult({ record: reviewSessionRecord(stored.run, stored.run.review.events.length), events: stored.run.review.events, requiredResolvedItems: "all" });
    if (!applied.ok) return [];
    return stored.envelope.result.proposals.flatMap((proposal, index) => {
      const candidate = imported.reviewItems.flatMap(item => item.spec.candidates).find(value => value.locator?.locator === proposal.provenance.locator && value.locator?.excerpt === proposal.provenance.excerpt);
      return candidate && applied.results.some(result => result.selectedCandidateId === candidate.id && result.status === "verified")
        ? [opaqueRef(stored.run.runResource, captureRef, stored.run.preparedArtifact.ref, stored.run.preparedArtifact.digest, index, proposal.provenance.occurrence)] : [];
    });
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
function verifyOccurrence(text: string, proposal: { provenance: { excerpt: string; occurrence: { selected: { start: number; end: number }; count: number } } }): boolean {
  const { excerpt, occurrence } = proposal.provenance; const { start, end } = occurrence.selected;
  if (start < 0 || end < start || text.slice(start, end) !== excerpt) return false;
  let count = 0; let at = text.indexOf(excerpt);
  while (at >= 0) { count++; at = text.indexOf(excerpt, at + Math.max(1, excerpt.length)); }
  return count === occurrence.count;
}
