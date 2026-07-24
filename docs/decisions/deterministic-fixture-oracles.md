# Deterministic fixture oracles

Status: accepted

The offline deterministic provider is a fixture adapter, not a model simulator. It orders proposals by their actual prepared-source spans. Equal starts sort by span end and then field path, so declaration order cannot change replay order. String and date captures remain literal strings, enum captures must be declared values, and boolean, number, array, and object captures must be unambiguous JSON literals of the declared runtime type. Invalid JSON or a mismatched runtime type fails the run closed.

Each projected field path is unique within a task. Fieldwork rejects duplicates before a run is created so proposal-to-claim ownership cannot depend on declaration order or first-match lookup.

The comparison-neutral corpus fixtures each retain a checked-in `oracle.json`. Tests compare the production `run → Survey events → reviewed export` result to those independent frozen expectations. The oracle pins ordered typed proposals, exact excerpts and `chars:` locators, non-overlap, occurrence resolution, provider and replay metadata, diagnostics and warnings posture, and reviewed claims with their evidence. A source, task, Traverse, Survey, or Surface change that alters these public observations therefore requires an intentional oracle review.

The compact example corpus remains bounded groundwork. A separate generated long-input tier freezes a 25,018-character source, three default Traverse provider calls, overlap deduplication, exact full-text offsets, a late-document proposal, Survey review, and grounded export. The checked-in source specification is complete and non-overlapping so a large opaque filler file is unnecessary.

Runtime conformance separately proves durable authorization, bounded concurrent completion, deterministic ordering, classified chunk failure, call ceilings, and cancellation mechanics. A document-format tier adds an ordered collection of independent child runs from replayable HTML, WebVTT, PDF-layout, and OCR snapshots. Its frozen oracle covers source/snapshot identity, exact prepared-text locators, PDF page/element/table-cell context, OCR posture, source-local failure containment, Survey review, and portable Surface output. Browser evidence covers the shared inspector rendering.

Provider-quality measurement remains follow-up scope in [issue #9](https://github.com/kontourai/fieldwork/issues/9). Traverse and Relay now prove provider-native batching; Dispatch #28 owns preserving that capability through Fieldwork's routed, authorization-bearing runtime composition. Synthetic fixtures do not establish live-provider quality or justify a new extraction pass.
