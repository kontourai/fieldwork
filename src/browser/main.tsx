import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Panel, StatusBar, Topbar } from "@kontourai/ui/react";
import { createPersistentReviewSessionEventStore, mountExtractionInspector, mountReviewWorkbench } from "@kontourai/survey/review-workbench";
import type { ExtractionInspectorModel, ReviewSessionEvent } from "@kontourai/survey";
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

/** Kontour refs read `fieldwork-source:v1:<name>:<digest>`. Reviewers need the name. */
function readableRefName(ref: string): string {
  const named = ref.split(":").filter((segment) => segment && !DIGEST_SEGMENT.test(segment) && !VERSION_SEGMENT.test(segment));
  const name = (named[named.length - 1] ?? ref).replace(/[-_]+/g, " ").trim();
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : ref;
}

function refDigest(ref: string): string | undefined {
  return ref.split(":").filter((segment) => DIGEST_SEGMENT.test(segment)).pop();
}

/* Mirrors @kontourai/survey's private `safeId` (extraction-inspector.js), the
   derivation behind every source highlight's element id. Survey does not export
   it, so the review card's source link has to reconstruct the same id.
   test/browser/review.spec.ts ("every decided fact links to the source
   highlight it came from") resolves each generated href against the live
   inspector, so a change to Survey's derivation fails there rather than
   silently shipping dead links. */
function surveyElementId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Keeps the document and the queue pointing at the same fact, in both directions. */
function linkDocumentAndQueue(
  inspectorHost: HTMLElement,
  workbenchHost: HTMLElement,
  candidates: ExtractionInspectorModel["candidates"],
): () => void {
  const candidateByItem = new Map(candidates.map((candidate) => [candidate.reviewItemName, candidate.id]));
  const itemByCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate.reviewItemName]));
  let activeItemName: string | undefined;

  const cardFor = (itemName: string) =>
    workbenchHost.querySelector<HTMLElement>(`[data-testid="review-field"][data-item-name="${itemName}"]`);
  const anchorFor = (itemName: string) => {
    const candidateId = candidateByItem.get(itemName);
    return candidateId ? inspectorHost.querySelector<HTMLElement>(`[data-highlight-candidate-id="${candidateId}"]`) : null;
  };

  const paint = () => {
    for (const host of [inspectorHost, workbenchHost]) {
      host.querySelectorAll("[data-fw-active]").forEach((node) => node.removeAttribute("data-fw-active"));
    }
    if (!activeItemName) return;
    const anchor = anchorFor(activeItemName);
    anchor?.setAttribute("data-fw-active", "");
    anchor?.nextElementSibling?.setAttribute("data-fw-active", "");
    cardFor(activeItemName)?.setAttribute("data-fw-active", "");
  };

  const select = (itemName: string | undefined, reveal: "card" | "source" | "none") => {
    if (!itemName) return;
    activeItemName = itemName;
    paint();
    // Instant, nearest-edge scrolling only: a smooth scroll would keep the
    // decision buttons moving under a reviewer (and under a test) mid-click.
    const reveals = { card: cardFor, source: anchorFor, none: () => null }[reveal];
    reveals(itemName)?.scrollIntoView({ block: "nearest", behavior: "auto" });
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest) return;
    const jump = target.closest<HTMLAnchorElement>('a[href^="#highlight-"]');
    if (jump) {
      // The launch capability lives in location.hash. A fragment navigation
      // would overwrite it and leave a reload unable to reach the server.
      event.preventDefault();
      const itemName = jump.closest<HTMLElement>('[data-testid="review-field"]')?.dataset.itemName;
      select(itemName, "source");
      if (itemName) anchorFor(itemName)?.focus();
      return;
    }
    const highlight = target.closest<HTMLElement>("[data-highlight-candidate-id]");
    if (highlight?.dataset.highlightCandidateId) {
      select(itemByCandidate.get(highlight.dataset.highlightCandidateId), "card");
      return;
    }
    const mark = target.closest("mark");
    const markAnchor = mark?.previousElementSibling as HTMLElement | undefined;
    if (markAnchor?.dataset.highlightCandidateId) select(itemByCandidate.get(markAnchor.dataset.highlightCandidateId), "card");
  };

  // Survey stops propagation on its own inspector handlers, so listen in capture.
  inspectorHost.addEventListener("click", onClick, true);
  workbenchHost.addEventListener("click", onClick, true);

  const onActivate = (event: Event) => select((event as CustomEvent<{ reviewItemName?: string }>).detail?.reviewItemName, "card");
  inspectorHost.addEventListener("survey-extraction-candidate-activate", onActivate);

  const onFocusIn = (event: FocusEvent) => {
    const field = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-testid="review-field"]');
    select(field?.dataset.itemName, "source");
  };
  workbenchHost.addEventListener("focusin", onFocusIn);

  // Both surfaces re-render themselves wholesale (a decision rebuilds the queue,
  // a filter rebuilds the source), so the selection has to be repainted.
  const observer = new MutationObserver(() => { if (activeItemName) paint(); });
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
  useEffect(() => {
    if (!state || !inspectorModel) return;
    setEvidenceFiltersOpen(inspectorModel.candidates.length > FILTER_DISCLOSURE_THRESHOLD);
    setQueueFiltersOpen(state.review.items.length > FILTER_DISCLOSURE_THRESHOLD);
  }, [state, inspectorModel]);
  useEffect(() => {
    if (!state || !inspectorModel || !inspector.current || !workbench.current) return;
    const inspectorHost = inspector.current, workbenchHost = workbench.current;
    inspectorHost.replaceChildren(); workbenchHost.replaceChildren();
    const disposeInspector = mountExtractionInspector(inspectorHost, inspectorModel);
    const candidateByItem = new Map(inspectorModel.candidates.map((candidate) => [candidate.reviewItemName, candidate.id]));
    // "Where did this come from" is the reviewer's question. Answer it on the
    // face of the card — readable source name plus the exact locator — and make
    // the answer a jump to the highlighted sentence. The 64-hex source digest
    // stays where a digest belongs: the audit record.
    const presentationAdapter: ReviewPresentationAdapter = {
      linkForSource: (sourceRef, context) => {
        if (context.candidate.role !== "proposed") return undefined;
        const candidateId = candidateByItem.get(context.item.metadata.name);
        if (!candidateId || !sourceRef) return undefined;
        const locator = context.candidate.locator?.locator;
        const name = readableRefName(sourceRef);
        return { label: locator ? `${name} · ${locator}` : name, href: `#highlight-${surveyElementId(candidateId)}` };
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
    const disposeLinking = linkDocumentAndQueue(inspectorHost, workbenchHost, inspectorModel.candidates);
    return () => { disposeLinking(); disposeInspector(); workbenchHost.replaceChildren(); };
  }, [state, inspectorModel]);
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
  ].filter(Boolean).join(" ");
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
            <span>{inspectorCount} grounded {inspectorCount === 1 ? "span" : "spans"}</span>
            {documentDigest && <span className="fieldwork-document-digest" title={documentDigestTitle}>{documentDigest.slice(0, 12)}</span>}
          </p>
        </header>
        <div className="survey-workbench-embed theme-survey" data-theme={presentation.theme}
          data-fw-sources={sources.length} ref={inspector}/>
      </Panel>
      <Panel className="fieldwork-column fieldwork-column-review" title="Facts to decide" count={state?.review.items.length ?? 0}
        actions={filterToggle(queueFiltersOpen, () => setQueueFiltersOpen((open) => !open), "Find fields")}>
        <div className="survey-workbench-embed theme-survey" data-theme={presentation.theme} ref={workbench}/>
      </Panel>
    </div>
    <StatusBar ariaLabel="Fieldwork status" start="Local server authority" items={[{ label: "Review", value: notice || "ready" }]}/>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
