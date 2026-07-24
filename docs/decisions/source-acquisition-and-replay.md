# Source acquisition and replay

## Decision

Fieldwork composes Forage for network acquisition and content-addressed snapshots. The application selects a bounded filesystem store and exposes portable snapshot references. Exact replay resolves the requested reference through Forage and fails closed when the snapshot is missing or altered. Acquisition responses do not contain source bodies or machine-local store paths.

A run accepts exactly one local file or exact snapshot. Repeated CLI/API inputs create an ordered batch of independent child runs. Each child retains its own source identity, Traverse artifact, Survey review history, and failure result; Fieldwork does not invent a cross-source review authority or relabel concurrent calls as provider-native batching.

Traverse owns source preparation. HTML and WebVTT use its built-in preparation. PDF and image inputs require host-supplied parser/OCR adapters, whose portable identifiers participate in run identity. Missing capabilities fail with typed public errors instead of silently degrading binary content to text.

Lookout owns registered-source checks, immutable proposal observations, continuity conflicts, and neutral semantic diff projection. Fieldwork composes those contracts rather than adding a second conditional-fetch or proposal-diff implementation. An unchanged result skips extraction. A changed result creates a new run, then Fieldwork replaces its initial full-proposal queue with the Lookout-projected semantic items before any decision event exists. The earlier run and its Survey event prefix are never rewritten.

Task and preparation drift are classifications, not semantic source changes. Changed bytes with byte-identical proposals produce an empty new round. Evidence additions, removals, moves, value changes, and provenance changes retain both observation identities and exact old/new snapshot evidence in a new Survey-owned round. Lookout's optimistic proposal-observation commit is also the application concurrency boundary: only one recheck may advance a source from the selected prior observation.

## Consequences

Raw acquired bytes remain in the Forage snapshot store. Fieldwork persists only the exact prepared text needed for locator inspection and review. The source identity binds snapshot authority, content digest, media type, and relevant adapter identity, so changed preparation capabilities cannot reuse an older run accidentally.

This establishes deterministic acquisition/replay, multi-source composition, and source rechecks without moving SSRF or semantic-diff policy into Fieldwork or moving review semantics out of Survey. Frozen document-format and replay/drift conformance verifies the composition through PDF layout, OCR posture, unchanged-source provider skipping, exact old/new evidence, concurrent continuity, review, and portable output; it does not turn Fieldwork into a fetcher, parser, OCR engine, diff kernel, or second review surface.
