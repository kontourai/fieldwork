import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Panel, StatusBar, Topbar } from "@kontourai/ui/react";
import { createPersistentReviewSessionEventStore, mountExtractionInspector, mountReviewWorkbench } from "@kontourai/survey/review-workbench";
import type { ExtractionInspectorModel, ReviewSessionEvent } from "@kontourai/survey";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
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

function App() {
  const [state, setState] = useState<FieldworkRunViewV1>(); const [notice, setNotice] = useState("Review ready");
  const [presentation, setPresentation] = useState<FieldworkHostPresentationV1>({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkHostPresentation",
    eyebrow: "Fieldwork", title: "Grounded review", theme: "light", navigation: [],
  });
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
  useEffect(() => {
    if (!state || !inspector.current || !workbench.current) return;
    inspector.current.replaceChildren(); workbench.current.replaceChildren();
    const disposeInspector = mountExtractionInspector(inspector.current, state.inspector as unknown as ExtractionInspectorModel);
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
    mountReviewWorkbench(workbench.current, state.review.snapshot as unknown as ReviewQueueSessionState, { eventStore: store });
    return () => { disposeInspector(); workbench.current?.replaceChildren(); };
  }, [state]);
  const inspectorCount = Array.isArray(state?.inspector.candidates) ? state.inspector.candidates.length : 0;
  const navigation = [...presentation.navigation, ...(presentation.returnAction ? [presentation.returnAction] : [])];
  return <main className="fieldwork-shell theme-survey" data-theme={presentation.theme}><Topbar eyebrow={presentation.eyebrow} title={presentation.title} meta={[{ label: "Run", value: state?.run.resource ?? "loading" }]} />{navigation.length > 0 && <nav className="fieldwork-host-navigation" aria-label="Host navigation">{navigation.map((item) => <a key={`${item.label}:${item.href}`} href={item.href}>{item.label}</a>)}</nav>}<Panel title="Grounded source inspection" count={inspectorCount}><div className="survey-workbench-embed theme-survey" data-theme={presentation.theme} ref={inspector}/></Panel><Panel title="Survey review workbench" count={state?.review.items.length ?? 0}><div className="survey-workbench-embed theme-survey" data-theme={presentation.theme} ref={workbench}/></Panel><StatusBar ariaLabel="Fieldwork status" start="Local server authority" items={[{ label: "Review", value: notice || "ready" }]}/></main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
