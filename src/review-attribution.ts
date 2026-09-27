import type { ReviewSessionEvent } from "@kontourai/survey";
import {
  buildReviewWorkbenchResultsFromSession,
  type ReviewQueueSessionState,
  type ReviewWorkbenchResult,
} from "@kontourai/survey/review-workbench";
import type { FieldworkReviewerIdentity } from "./api-contracts.js";

/**
 * Who made a review decision is known only to the host: the person at the
 * loopback UI, or the embedding host that made the call. Survey's session model
 * carries one actor and one time per session and takes both from the queue
 * snapshot (kontourai/survey#234), so the server stamps each appended event
 * instead, from the host-configured reviewer and its own clock, and ignores
 * whatever actor or time the client sent.
 *
 * The stamp rides the event's producer channel, which Survey carries without
 * interpreting. `spec.actor` and `spec.occurredAt` hold the stamped values, so
 * the event history and the exported decision name the same actor.
 */
export const REVIEW_ATTRIBUTION_PRODUCER = "fieldwork.kontourai.io/review-attribution";

/**
 * Actor id recorded when no reviewer identity is configured. It is paired with
 * the `unattributed` actor kind and is reserved, so a configured reviewer
 * cannot take it.
 */
export const UNATTRIBUTED_ACTOR_ID = "unattributed";

export type ReviewActorKind = "human" | "agent" | "unattributed";
export type ReviewAssuranceMode = "individual" | "batch" | "agent";

interface ReviewAttributionStamp {
  readonly actorKind: ReviewActorKind;
  readonly mode: ReviewAssuranceMode;
  /** An actor the client put on the event, when it differs from the stamp and from the round's default. */
  readonly clientClaimedActorId?: string;
}

/**
 * How one exported decision was attributed. Events written before the server
 * stamped them carry Survey's constant snapshot actor and time; they still load
 * and export, marked `legacy-synthetic-actor` rather than rewritten.
 */
export interface ReviewDecisionAttribution {
  readonly reviewItemName: string;
  readonly actor: { readonly id: string; readonly kind: ReviewActorKind | "legacy-synthetic-actor" };
  readonly decidedAt: string;
  readonly mode?: ReviewAssuranceMode;
}

const REVIEWER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

/** Validate a host-supplied reviewer identity. Undefined means none was configured. */
export function parseReviewerIdentity(value: FieldworkReviewerIdentity | undefined): FieldworkReviewerIdentity | undefined {
  if (value === undefined) return undefined;
  if (typeof value.id !== "string" || !REVIEWER_ID.test(value.id)) {
    throw invalidReviewer("Reviewer id must be 1-128 characters of letters, digits, and . _ : @ -, starting with a letter or digit");
  }
  if (value.id === UNATTRIBUTED_ACTOR_ID) {
    throw invalidReviewer(`Reviewer id ${UNATTRIBUTED_ACTOR_ID} is reserved for decisions made with no configured reviewer`);
  }
  if (value.kind !== "human" && value.kind !== "agent") throw invalidReviewer("Reviewer kind must be human or agent");
  return { id: value.id, kind: value.kind };
}

/**
 * Stamp the events one request appends. The mode is per request: `agent` when
 * the host says the caller is an agent, `batch` when the request decides more
 * than one item, otherwise `individual`.
 */
export function stampAppendedEvents(
  appended: readonly ReviewSessionEvent[],
  reviewer: FieldworkReviewerIdentity | undefined,
  roundDefaultActorId: string,
  now: Date,
): ReviewSessionEvent[] {
  const decidedItems = new Set(appended
    .filter((event) => isDecisionEvent(event) && event.spec.data?.workbenchDecision !== null)
    .map((event) => event.spec.reviewItemName));
  const mode: ReviewAssuranceMode = reviewer?.kind === "agent" ? "agent" : decidedItems.size > 1 ? "batch" : "individual";
  const actorId = reviewer?.id ?? UNATTRIBUTED_ACTOR_ID;
  const occurredAt = now.toISOString();
  return appended.map((event) => {
    const claimed = event.spec.actor?.id;
    const stamp: ReviewAttributionStamp = {
      actorKind: reviewer?.kind ?? "unattributed",
      mode,
      ...(claimed !== undefined && claimed !== actorId && claimed !== roundDefaultActorId ? { clientClaimedActorId: claimed } : {}),
    };
    return {
      ...event,
      metadata: { ...event.metadata, producer: { ...event.metadata.producer, [REVIEW_ATTRIBUTION_PRODUCER]: { ...stamp } } },
      spec: { ...event.spec, actor: { id: actorId }, occurredAt },
    };
  });
}

/**
 * The part of an event the client owns. The browser keeps its own copy of the
 * events it already persisted and posts it back as the append-only prefix; that
 * copy never learns the server's stamp, so the prefix is compared without it.
 */
export function withoutServerStamp(event: ReviewSessionEvent): unknown {
  const { actor: _actor, occurredAt: _occurredAt, ...spec } = event.spec;
  const { [REVIEW_ATTRIBUTION_PRODUCER]: _stamp, ...producer } = event.metadata.producer ?? {};
  const { producer: _producer, ...metadata } = event.metadata;
  return {
    ...event,
    metadata: Object.keys(producer).length > 0 ? { ...metadata, producer } : metadata,
    spec,
  };
}

/**
 * Re-derive each result under the actor and time stamped on the event that
 * established its decision, through Survey's own result builder. Survey's
 * replay reads both from the snapshot, so without this every decision in a
 * round would carry the one snapshot actor and time. Results whose deciding
 * event predates stamping are left exactly as Survey derived them and marked
 * legacy. Remove the re-derivation once Survey replay reads the event actor
 * (kontourai/survey#234).
 */
export function attributeReviewResults(
  session: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
  results: readonly ReviewWorkbenchResult[],
): { readonly results: ReviewWorkbenchResult[]; readonly attribution: ReviewDecisionAttribution[] } {
  const deciding = new Map<string, ReviewSessionEvent>();
  for (const event of [...events].sort((left, right) => left.spec.sequence - right.spec.sequence)) {
    if (isDecisionEvent(event) && event.spec.reviewItemName) deciding.set(event.spec.reviewItemName, event);
  }
  const attributed: ReviewWorkbenchResult[] = [];
  const attribution: ReviewDecisionAttribution[] = [];
  for (const result of results) {
    const event = deciding.get(result.reviewItemName);
    const stamp = event === undefined ? undefined : readStamp(event);
    if (!event || !stamp) {
      attributed.push(result);
      attribution.push({
        reviewItemName: result.reviewItemName,
        actor: { id: result.reviewDecision.spec.actor?.id ?? session.actorId, kind: "legacy-synthetic-actor" },
        decidedAt: result.reviewDecision.spec.reviewedAt ?? session.reviewedAt,
      });
      continue;
    }
    const item = session.items.find((entry) => entry.metadata.name === result.reviewItemName);
    const actorId = event.spec.actor?.id;
    if (!item || !actorId) throw invalidStamp(result.reviewItemName);
    const [rederived] = buildReviewWorkbenchResultsFromSession({
      ...session, items: [item], activeItemName: item.metadata.name, actorId, reviewedAt: event.spec.occurredAt,
    });
    if (!rederived || rederived.decision !== result.decision || rederived.selectedCandidateId !== result.selectedCandidateId) {
      throw invalidStamp(result.reviewItemName);
    }
    attributed.push(rederived);
    attribution.push({
      reviewItemName: result.reviewItemName,
      actor: { id: actorId, kind: stamp.actorKind },
      decidedAt: event.spec.occurredAt,
      mode: stamp.mode,
    });
  }
  return { results: attributed, attribution };
}

function readStamp(event: ReviewSessionEvent): ReviewAttributionStamp | undefined {
  const raw = event.metadata.producer?.[REVIEW_ATTRIBUTION_PRODUCER];
  if (raw === undefined) return undefined;
  const stamp = raw as Partial<ReviewAttributionStamp> | null;
  if (!stamp || typeof stamp !== "object"
    || !["human", "agent", "unattributed"].includes(stamp.actorKind as string)
    || !["individual", "batch", "agent"].includes(stamp.mode as string)) {
    throw invalidStamp(event.spec.reviewItemName ?? event.metadata.name);
  }
  return stamp as ReviewAttributionStamp;
}

function isDecisionEvent(event: ReviewSessionEvent): boolean {
  return event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted";
}

function invalidReviewer(message: string): Error {
  return Object.assign(new TypeError(message), { code: "INVALID_ARGUMENT" });
}

function invalidStamp(name: string): Error {
  return Object.assign(
    new Error(`Stored review attribution for ${name} is malformed; re-run the source rather than editing stored review state.`),
    { code: "REVIEW_ATTRIBUTION_INVALID" },
  );
}
