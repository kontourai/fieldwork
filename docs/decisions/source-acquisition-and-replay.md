# Source acquisition and replay

## Decision

Fieldwork composes Forage for network acquisition and content-addressed snapshots. The application selects a bounded filesystem store and exposes portable snapshot references. Exact replay resolves the requested reference through Forage and fails closed when the snapshot is missing or altered. Acquisition responses do not contain source bodies or machine-local store paths.

A run accepts exactly one local file or exact snapshot. Repeated CLI/API inputs create an ordered batch of independent child runs. Each child retains its own source identity, Traverse artifact, Survey review history, and failure result; Fieldwork does not invent a cross-source review authority or relabel concurrent calls as provider-native batching.

Traverse owns source preparation. HTML and WebVTT use its built-in preparation. PDF and image inputs require host-supplied parser/OCR adapters, whose portable identifiers participate in run identity. Missing capabilities fail with typed public errors instead of silently degrading binary content to text.

## Consequences

Raw acquired bytes remain in the Forage snapshot store. Fieldwork persists only the exact prepared text needed for locator inspection and review. The source identity binds snapshot authority, content digest, media type, and relevant adapter identity, so changed preparation capabilities cannot reuse an older run accidentally.

This establishes deterministic acquisition/replay and multi-source composition without moving SSRF policy into Fieldwork or moving review semantics out of Survey. Format-native layout and visual inspection require separate conformance evidence.
