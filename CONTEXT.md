# Fieldwork context

Fieldwork is an application, not an acquisition, extraction, review, trust, or design-system primitive. It composes Forage acquisition and exact snapshots, Traverse proposal extraction, Survey review records and Workbench surfaces, `@kontourai/ui` shell theming, and Surface trust validation for a local review workflow.

The durable authority boundary is the actual prepared bytes rebound to the Traverse artifact identity (digest, length, ref, source/snapshot ref, and envelope), followed by Survey events persisted under revision/prefix compare-and-swap. Browser state, deterministic provider output, and raw source files are never reviewed truth. Fieldwork owns bounded and symlink-safe local run storage, loopback capability/origin enforcement, CLI/API/UI composition, disclosure checks, and a host-neutral launch descriptor. Survey owns review interaction semantics and source inspection; `@kontourai/ui` owns shared shell primitives and theme tokens.

Run collisions are non-destructive: an identical request reuses a valid run and its append-only review history, while an invalid collision fails closed. The loopback server is not an ambient localhost API. Every launch creates a random capability sent by the browser, and storage-level locking serializes independent server instances around the complete read/validate/write transaction.

The root package facade owns only Fieldwork's versioned JSON transport. It does not expose concrete Traverse, Survey, or Surface implementation declarations. Persisted Survey payloads cross a temporary structural adapter and then Survey's semantic validators; Survey #188 owns the reusable unknown-input validator needed to remove that adapter.

Runtime binding is launch policy, not task meaning. Relay owns invocation portability, Dispatch owns ordered routing and receipts, and Datum owns configured role resolution. Fieldwork records their secret-free identities and receipts, then adapts the selected runtime through Traverse. Conduit remains the host lifecycle and asset-installation boundary; Fieldwork does not use it as a model-invocation layer.

Physical batching remains capability-gated across that same path. Traverse groups chunks, Dispatch performs per-item authorization and fallback, and Relay owns the one-call runtime operation. Fieldwork records requested batch policy and content-free operation/item receipt identity; it never infers batching from concurrency.

Source authority remains per source. Repeated inputs produce an ordered collection of independent child runs rather than collapsing distinct snapshot authorities into one Survey review record. Forage owns network policy and snapshot integrity; Fieldwork owns application store selection and portable acquisition/batch transports. Traverse owns format preparation. Binary preparation is capability-explicit: a host supplies PDF or OCR adapters, and the adapter identity is part of the durable run identity.
