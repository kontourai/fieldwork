import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Panel, StatusBar, Topbar } from "@kontourai/ui/react";
import { createPersistentReviewSessionEventStore, mountExtractionInspector, mountReviewWorkbench } from "@kontourai/survey/review-workbench";
import type { ExtractionInspectorModel, ReviewItem, ReviewSessionEvent } from "@kontourai/survey";
import type { ReviewPresentationAdapter, ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import "@kontourai/survey/review-workbench.css";
import "@kontourai/ui/tokens";
import "@kontourai/ui/react/styles.css";
import "./style.css";
import {
  fieldworkHostPresentationSchema, fieldworkRunViewSchema, reviewMutationResponseSchema,
  type FieldworkHostPresentationV1, type FieldworkRunViewV1
} from "../api-contracts.js";

const capability = new URLSearchParams(location.hash.slice(1)).get("cap") ?? "";
const apiHeaders = { "x-fieldwork-capability": capability };

/* A seven-field run does not need eight filter controls in front of it. Below
   this many rows the filter bar is a disclosure the reviewer can open; above
   it, filtering is the only way through the queue, so it stays open. */
const FILTER_DISCLOSURE_THRESHOLD = 12;

const DIGEST_SEGMENT = /^[0-9a-f]{12,}$/i;
const VERSION_SEGMENT = /^v\d+(?:alpha\d*|beta\d*)?$/i;

/** Fieldwork refs read `fieldwork-source:v1:<name>:<digest>`; Forage snapshot
    refs read `forage-snapshot:<sourceId>?url=…&sha256=…&fetchedAt=…`. Reviewers
    need the name from either. Dropping the query first matters: without it every
    snapshot-backed run — which is every acquired source and every recheck round —
    printed its whole 200-character locator on the face of each card. */
function readableRefName(ref: string): string {
  const named = refPath(ref).split(":")
    .filter((segment) => segment && !DIGEST_SEGMENT.test(segment) && !VERSION_SEGMENT.test(segment));
  const name = (named[named.length - 1] ?? refPath(ref)).replace(/[-_]+/g, " ").trim();
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : ref;
}

function refPath(ref: string): string {
  return ref.split("?")[0] ?? ref;
}

function refDigest(ref: string): string | undefined {
  return refPath(ref).split(":").filter((segment) => DIGEST_SEGMENT.test(segment)).pop();
}

/** Forage records when a snapshot was taken in its ref; it is the only place a
    recheck round carries "when was this captured", so read it where it exists. */
function refFetchedAt(ref: string): string | undefined {
  const query = ref.slice(ref.indexOf("?") + 1);
  const value = ref.includes("?") ? new URLSearchParams(query).get("fetchedAt") : null;
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

const ACRONYMS = new Set(["id", "url", "uri", "api", "utc", "iso", "pdf", "html", "json", "csv", "sla", "vat", "kpi", "pii", "usd", "eur", "gbp", "jpy", "cad", "aud", "chf", "cny", "inr"]);
const UNIT_SUFFIXES = new Set(["usd", "eur", "gbp", "jpy", "cad", "aud", "chf", "cny", "inr", "pct", "days", "hours", "months", "years"]);

/** Survey's `humanizeIdentifier` renders `commercial.annualFeeUsd` as
    `Commercial.Annual Fee Usd` — the machine identifier with spaces pushed into
    it. A reviewer reads a field name, so write one: dotted segments joined,
    camelCase split, sentence case, known acronyms cased, a trailing unit
    parenthesised. `labelForTarget` is Survey's supported hook for exactly this. */
function humanizeFieldPath(target: string): string {
  const words = target.split(".")
    .flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").split(/\s+/))
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return target;
  const unit = words.length > 1 && UNIT_SUFFIXES.has(words[words.length - 1]!) ? words.pop()! : undefined;
  const cased = words.map((word, index) => ACRONYMS.has(word) ? word.toUpperCase()
    : index === 0 ? `${word[0]!.toUpperCase()}${word.slice(1)}`
    : word);
  const label = cased.join(" ");
  return unit ? `${label} (${ACRONYMS.has(unit) ? unit.toUpperCase() : unit})` : label;
}

/* --- Recheck ---------------------------------------------------------------
   `fieldwork recheck` builds its review round through Lookout's semantic
   transition, which stamps every item it emits with the kind of change that put
   it there. Nothing about that reached the screen: a re-review looked exactly
   like a first review, and a reviewer had no way to tell which of the seven
   highlighted spans were the two that actually moved. This reads the metadata
   the shipped CLI genuinely emits — no new run-store field, no invented shape. */
const SEMANTIC_TRANSITION = "lookout.kontourai.io/semantic-transition";

const CHANGE_LABELS: Record<string, string> = {
  "proposal-added": "New",
  "proposal-removed": "Removed",
  "proposal-moved": "Moved",
  "proposal-value-changed": "Value changed",
  "proposal-provenance-changed": "Evidence changed",
  "coverage-gap": "Not covered",
  "provenance-gap": "No evidence",
};

interface RecheckChange {
  readonly itemName: string;
  readonly target: string;
  readonly label: string;
}

interface RecheckRound {
  readonly changes: readonly RecheckChange[];
  readonly fields: ReadonlySet<string>;
  readonly capturedAt?: string;
  readonly previouslyCapturedAt?: string;
}

function readRecheckRound(items: readonly ReviewItem[]): RecheckRound | undefined {
  const changes: RecheckChange[] = [];
  let capturedAt: string | undefined, previouslyCapturedAt: string | undefined;
  for (const item of items) {
    const transition = item.metadata.producer?.[SEMANTIC_TRANSITION] as { semanticKind?: string } | undefined;
    if (!transition?.semanticKind) continue;
    changes.push({
      itemName: item.metadata.name,
      target: item.spec.target,
      label: CHANGE_LABELS[transition.semanticKind] ?? "Changed",
    });
    for (const candidate of item.spec.candidates) {
      const at = refFetchedAt(candidate.source.sourceRef);
      if (!at) continue;
      if (candidate.role === "proposed") capturedAt = at;
      if (candidate.role === "current") previouslyCapturedAt = at;
    }
  }
  if (changes.length === 0) return undefined;
  return {
    changes,
    fields: new Set(changes.map((change) => change.target)),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(previouslyCapturedAt === undefined ? {} : { previouslyCapturedAt }),
  };
}

function readableInstant(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Elements that own their own click. Selecting a card must not swallow these. */
const CARD_CONTROLS = "button, a, input, textarea, select, label, summary, [contenteditable]";

/** Keeps the document and the queue pointing at the same fact, in both directions. */
function linkDocumentAndQueue(
  inspectorHost: HTMLElement,
  workbenchHost: HTMLElement,
  candidates: ExtractionInspectorModel["candidates"],
  recheck: RecheckRound | undefined,
): () => void {
  const itemByHighlight = new Map(candidates.flatMap((candidate) =>
    candidate.highlightElementId ? [[candidate.highlightElementId, candidate.reviewItemName] as const] : []));
  let activeItemName: string | undefined;

  const cardFor = (itemName: string) =>
    workbenchHost.querySelector<HTMLElement>(`[data-testid="review-field"][data-item-name="${itemName}"]`);
  /* A recheck round's items are Lookout's (`lookout-semantic.…`) while the
     inspector's candidates are the new extraction's (`extraction-envelope.…`),
     so review-item identity does not join the two surfaces there. The field path
     does, and it is the same join Survey's own card header uses. */
  const highlightIdFor = (itemName: string) => {
    const field = cardFor(itemName)?.dataset.field;
    const candidate = candidates.find((entry) => entry.reviewItemName === itemName)
      ?? (field ? candidates.find((entry) => entry.field === field) : undefined);
    return candidate?.highlightElementId;
  };
  /* The painted `<mark class="source-highlight">` is the visible, focusable
     return control (survey 2.3.0); `data-highlight-return-to` is its published
     reverse binding, a space-separated list of the `highlightElementId`s it
     covers — `~=` because two candidates can share one span. */
  const markFor = (itemName: string) => {
    const id = highlightIdFor(itemName);
    return id ? inspectorHost.querySelector<HTMLElement>(`mark[data-highlight-return-to~="${id}"]`) : null;
  };

  /* Survey rebuilds both surfaces wholesale, so everything the host stamps on
     their DOM has to be re-stamped rather than set once. Writes are guarded by
     an equality check: the MutationObserver that triggers this also watches it. */
  const decorate = () => {
    if (!recheck) return;
    for (const change of recheck.changes) {
      const kind = cardFor(change.itemName)?.querySelector<HTMLElement>(".fkind");
      // Two fields drifting can raise four items (a value change and a
      // provenance change each). Undifferentiated, the duplicate reads as a bug.
      if (kind && kind.textContent !== change.label) kind.textContent = change.label;
    }
    for (const candidate of candidates) {
      if (!candidate.highlightElementId) continue;
      const mark = inspectorHost.querySelector<HTMLElement>(`mark[data-highlight-return-to~="${candidate.highlightElementId}"]`);
      const changed = recheck.fields.has(candidate.field);
      if (!mark || mark.hasAttribute("data-fw-changed") === changed) continue;
      if (changed) mark.setAttribute("data-fw-changed", ""); else mark.removeAttribute("data-fw-changed");
    }
  };

  const paint = () => {
    for (const host of [inspectorHost, workbenchHost]) {
      host.querySelectorAll("[data-fw-active]").forEach((node) => node.removeAttribute("data-fw-active"));
    }
    decorate();
    if (!activeItemName) return;
    markFor(activeItemName)?.setAttribute("data-fw-active", "");
    cardFor(activeItemName)?.setAttribute("data-fw-active", "");
  };

  const select = (itemName: string | undefined, reveal: "card" | "source" | "none") => {
    if (!itemName) return;
    activeItemName = itemName;
    paint();
    // Instant, nearest-edge scrolling only: a smooth scroll would keep the
    // decision buttons moving under a reviewer (and under a test) mid-click.
    const reveals = { card: cardFor, source: markFor, none: () => null }[reveal];
    reveals(itemName)?.scrollIntoView({ block: "nearest", behavior: "auto" });
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest) return;
    /* "Could not confirm" requires a reason, and Survey renders the reviewer
       note inside the collapsed `Audit details` accordion. Pressing the button
       without one therefore focused a hidden textarea and called reportValidity
       on it: no request, no state change, no message — a permanently dead
       control, on the one decision the vendor-renewal example is written around
       ("the security assurance names a report that has not been delivered").
       This runs in capture, ahead of Survey's own handler, so the field the
       reviewer is about to be asked for is on screen before it is asked for. */
    const unconfirmed = target.closest<HTMLElement>('[data-testid="could-not-confirm"]');
    if (unconfirmed) {
      const card = unconfirmed.closest<HTMLElement>('[data-testid="review-field"]');
      const note = card?.querySelector<HTMLTextAreaElement>('[data-testid="reviewer-note"]');
      if (note && !note.value.trim()) card?.querySelector("details.audit-details")?.setAttribute("open", "");
      return;
    }
    const jump = target.closest<HTMLAnchorElement>('a[href^="#highlight-"]');
    if (jump) {
      // The launch capability lives in location.hash. A fragment navigation
      // would overwrite it and leave a reload unable to reach the server.
      event.preventDefault();
      const itemName = jump.closest<HTMLElement>('[data-testid="review-field"]')?.dataset.itemName;
      select(itemName, "source");
      if (itemName) markFor(itemName)?.focus();
      return;
    }
    // The painted mark is the click target now (survey 2.3.0); the anchor the
    // published id names is an inert zero-width span.
    const highlight = target.closest<HTMLElement>("[data-highlight-return-to]");
    if (highlight) {
      const bound = highlight.getAttribute("data-highlight-return-to")?.split(/\s+/, 1)[0];
      if (bound) {
        select(itemByHighlight.get(bound), "card");
        return;
      }
    }
    // Clicking the fact you are reading is the obvious way to ask "where did
    // this come from"; before this it was the one gesture that did nothing, and
    // the only way through was the small `from` link inside the card.
    const card = target.closest<HTMLElement>('[data-testid="review-field"]');
    if (card && !target.closest(CARD_CONTROLS)) select(card.dataset.itemName, "source");
  };

  // Survey stops propagation on its own inspector handlers, so listen in capture.
  inspectorHost.addEventListener("click", onClick, true);
  workbenchHost.addEventListener("click", onClick, true);

  const onActivate = (event: Event) => select((event as CustomEvent<{ reviewItemName?: string }>).detail?.reviewItemName, "card");
  inspectorHost.addEventListener("survey-extraction-candidate-activate", onActivate);

  const onFocusIn = (event: FocusEvent) => {
    const field = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-testid="review-field"]');
    // Focusing a decision control is part of a pointer click. Scrolling the
    // linked source here can move that control between mouse-down and mouse-up
    // inside a constrained host iframe, leaving the click with no target. Keep
    // the cross-surface selection, but reserve source scrolling for deliberate
    // card and evidence navigation.
    select(field?.dataset.itemName, "none");
  };
  workbenchHost.addEventListener("focusin", onFocusIn);

  // Both surfaces re-render themselves wholesale (a decision rebuilds the queue,
  // a filter rebuilds the source), so the selection and the host's own stamps
  // have to be repainted. Attribute writes are not observed and text writes are
  // equality-guarded, so this cannot drive itself.
  decorate();
  const observer = new MutationObserver(() => { decorate(); if (activeItemName) paint(); });
  observer.observe(inspectorHost, { childList: true, subtree: true });
  observer.observe(workbenchHost, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    inspectorHost.removeEventListener("click", onClick, true);
    workbenchHost.removeEventListener("click", onClick, true);
    inspectorHost.removeEventListener("survey-extraction-candidate-activate", onActivate);
    workbenchHost.removeEventListener("focusin", onFocusIn);
  };
}

function App() {
  const [state, setState] = useState<FieldworkRunViewV1>(); const [notice, setNotice] = useState("Review ready");
  const [presentation, setPresentation] = useState<FieldworkHostPresentationV1>({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkHostPresentation",
    eyebrow: "Fieldwork", title: "Grounded review", theme: "dark", navigation: [],
  });
  const [evidenceFiltersOpen, setEvidenceFiltersOpen] = useState(false);
  const [queueFiltersOpen, setQueueFiltersOpen] = useState(false);
  // The document root carries the theme too, so the page canvas outside the
  // shell resolves the same tokens instead of painting an unthemed background.
  useEffect(() => { document.documentElement.dataset.theme = presentation.theme; }, [presentation.theme]);
  const inspector = useRef<HTMLDivElement>(null), workbench = useRef<HTMLDivElement>(null);
  const load = async () => {
    try {
      const [runResponse, hostResponse] = await Promise.all([
        fetch("/api/v1/run", { headers: apiHeaders }),
        fetch("/api/v1/host", { headers: apiHeaders }),
      ]);
      const loaded = fieldworkRunViewSchema.safeParse(await runResponse.json());
      if (!loaded.success) throw new Error("Invalid Fieldwork run response");
      const host = fieldworkHostPresentationSchema.safeParse(await hostResponse.json());
      if (!host.success) throw new Error("Invalid Fieldwork host presentation");
      setState(loaded.data);
      setPresentation(host.data);
    } catch { setNotice("Unable to load server-owned review state"); }
  };
  useEffect(() => { void load(); }, []);
  const inspectorModel = useMemo(
    () => (state ? state.inspector as unknown as ExtractionInspectorModel : undefined),
    [state],
  );
  /* `review.items` is the extraction envelope's proposal list; the queue renders
     `review.snapshot.items`. On a first round they match, so the panel badge was
     right by coincidence. On a recheck they do not — the badge counted the new
     run's seven proposals beside a queue reading "4 fields to review". Count the
     queue a reviewer is actually looking at. */
  const queueItems = useMemo(
    () => (state ? (state.review.snapshot as unknown as ReviewQueueSessionState).items : []),
    [state],
  );
  const recheck = useMemo(() => readRecheckRound(queueItems), [queueItems]);
  useEffect(() => {
    if (!state || !inspectorModel) return;
    setEvidenceFiltersOpen(inspectorModel.candidates.length > FILTER_DISCLOSURE_THRESHOLD);
    setQueueFiltersOpen(queueItems.length > FILTER_DISCLOSURE_THRESHOLD);
  }, [state, inspectorModel, queueItems]);
  useEffect(() => {
    if (!state || !inspectorModel || !inspector.current || !workbench.current) return;
    const inspectorHost = inspector.current, workbenchHost = workbench.current;
    inspectorHost.replaceChildren(); workbenchHost.replaceChildren();
    const disposeInspector = mountExtractionInspector(inspectorHost, inspectorModel);
    // `highlightElementId` is Survey's published id for each candidate's source
    // anchor (2.3.0); the server builds the model with
    // `buildExtractionInspectorModel`, which always supplies it.
    const candidateByItem = new Map(inspectorModel.candidates.map((candidate) => [candidate.reviewItemName, candidate.highlightElementId]));
    // Recheck items are Lookout's, the inspector's candidates are the new
    // extraction's; only the field path joins them. Without this the provenance
    // link silently degraded to a raw ref on every recheck round.
    const candidateByField = new Map(inspectorModel.candidates.map((candidate) => [candidate.field, candidate.highlightElementId]));
    // "Where did this come from" is the reviewer's question. Answer it on the
    // face of the card — readable source name plus the exact locator — and make
    // the answer a jump to the highlighted sentence. The 64-hex source digest
    // stays where a digest belongs: the audit record.
    const presentationAdapter: ReviewPresentationAdapter = {
      // A field is a thing a person reads, not an identifier they decode.
      labelForTarget: (target) => humanizeFieldPath(target),
      linkForSource: (sourceRef, context) => {
        if (context.candidate.role !== "proposed") return undefined;
        const highlightElementId = candidateByItem.get(context.item.metadata.name)
          ?? candidateByField.get(context.item.spec.target);
        if (!highlightElementId || !sourceRef) return undefined;
        const locator = context.candidate.locator?.locator;
        const name = readableRefName(sourceRef);
        return { label: locator ? `${name} · ${locator}` : name, href: `#${highlightElementId}` };
      },
    };
    let revision = state.run.revision;
    const store = createPersistentReviewSessionEventStore({ initialEvents: state.review.events as unknown as ReviewSessionEvent[], persist: async (request) => {
      const response = await fetch("/api/v1/review", {
        method: "POST", headers: { ...apiHeaders, "content-type": "application/json" },
        body: JSON.stringify({ events: request.events, expectedEventCount: request.expectedEventCount, expectedRevision: revision })
      });
      const saved = reviewMutationResponseSchema.parse(await response.json());
      if (!saved.ok) throw new Error(saved.error.code);
      revision = saved.revision;
      return { events: saved.events as unknown as ReviewSessionEvent[], eventCount: saved.eventCount };
    }, onStatusChange: (status) => {
      if (status.status === "saving") setNotice("Saving review…");
      if (status.status === "saved") setNotice(`Saved ${status.events.length} server-owned review event(s)`);
      if (status.status === "error") {
        setNotice("Review conflict: reloading server-owned state");
        void load();
      }
    } });
    mountReviewWorkbench(workbenchHost, state.review.snapshot as unknown as ReviewQueueSessionState, { eventStore: store, presentationAdapter });
    const disposeLinking = linkDocumentAndQueue(inspectorHost, workbenchHost, inspectorModel.candidates, recheck);
    return () => { disposeLinking(); disposeInspector(); workbenchHost.replaceChildren(); };
  }, [state, inspectorModel, recheck]);
  const sources = inspectorModel?.sources ?? [];
  const inspectorCount = inspectorModel?.candidates.length ?? 0;
  const singleSource = sources.length === 1 ? sources[0] : undefined;
  const documentName = singleSource ? readableRefName(singleSource.importName)
    : sources.length === 0 ? "Prepared source" : `${sources.length} prepared sources`;
  const documentDigest = singleSource?.expectedDigest ?? singleSource?.actualDigest ?? (singleSource ? refDigest(singleSource.importName) : undefined);
  const documentDigestTitle = singleSource ? [singleSource.importName, singleSource.artifactRef, documentDigest].filter(Boolean).join("\n") : undefined;
  const navigation = [...presentation.navigation, ...(presentation.returnAction ? [presentation.returnAction] : [])];
  const shellClasses = [
    "fieldwork-shell", "theme-survey",
    evidenceFiltersOpen ? "fw-evidence-filters-open" : "",
    queueFiltersOpen ? "fw-queue-filters-open" : "",
    recheck ? "fw-recheck" : "",
  ].filter(Boolean).join(" ");
  const recheckFieldCount = recheck?.fields.size ?? 0;
  const filterToggle = (open: boolean, toggle: () => void, label: string) => (
    <button type="button" className="fieldwork-filter-toggle" aria-expanded={open} onClick={toggle}>{label}</button>
  );
  return <main className={shellClasses} data-theme={presentation.theme}>
    <Topbar eyebrow={presentation.eyebrow} title={presentation.title}
      meta={[{ label: "Run", value: state?.run.resource ?? "loading" }]}/>
    {navigation.length > 0 && <nav className="fieldwork-host-navigation" aria-label="Host navigation">{navigation.map((item) => <a key={`${item.label}:${item.href}`} href={item.href}>{item.label}</a>)}</nav>}
    <div className="fieldwork-review">
      <Panel className="fieldwork-column fieldwork-column-source" title="Source document" count={inspectorCount}
        actions={filterToggle(evidenceFiltersOpen, () => setEvidenceFiltersOpen((open) => !open), "Filter evidence")}>
        <header className="fieldwork-document-head">
          <h3 className="fieldwork-document-name">{documentName}</h3>
          <p className="fieldwork-document-meta">
            {/* On a recheck the count a reviewer needs is not how many spans are
                grounded but how many of them moved. */}
            <span>{recheck
              ? `${recheckFieldCount} of ${inspectorCount} spans changed`
              : `${inspectorCount} grounded ${inspectorCount === 1 ? "span" : "spans"}`}</span>
            {documentDigest && <span className="fieldwork-document-digest" title={documentDigestTitle}>{documentDigest.slice(0, 12)}</span>}
          </p>
        </header>
        <div className="survey-workbench-embed theme-survey" data-theme={presentation.theme}
          data-fw-sources={sources.length} ref={inspector}/>
      </Panel>
      <Panel className="fieldwork-column fieldwork-column-review"
        title={recheck ? "What changed" : "Facts to decide"} count={queueItems.length}
        actions={filterToggle(queueFiltersOpen, () => setQueueFiltersOpen((open) => !open), "Find fields")}>
        {recheck && <aside className="fieldwork-recheck" data-testid="recheck-summary">
          <p className="fieldwork-recheck-lede">
            The source moved. {recheckFieldCount} {recheckFieldCount === 1 ? "field" : "fields"} changed,
            raising {recheck.changes.length} {recheck.changes.length === 1 ? "item" : "items"} to re-decide.
          </p>
          <p className="fieldwork-recheck-when">
            {recheck.capturedAt && recheck.previouslyCapturedAt
              ? <>Captured {readableInstant(recheck.capturedAt)}, previously {readableInstant(recheck.previouslyCapturedAt)}. </>
              : undefined}
            Everything else is unchanged, and the run you already reviewed is untouched.
          </p>
        </aside>}
        <div className="survey-workbench-embed theme-survey" data-theme={presentation.theme} ref={workbench}/>
      </Panel>
    </div>
    <StatusBar ariaLabel="Fieldwork status" start="Local server authority" items={[{ label: "Review", value: notice || "ready" }]}/>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
