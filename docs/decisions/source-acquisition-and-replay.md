# Source acquisition and replay

## Decision

Fieldwork composes Forage for network acquisition and content-addressed snapshots. The application selects a bounded filesystem store and exposes portable snapshot references. Exact replay resolves the requested reference through Forage and fails closed when the snapshot is missing or altered. Acquisition responses do not contain source bodies or machine-local store paths.

A run accepts exactly one local file or exact snapshot. Repeated CLI/API inputs create an ordered batch of independent child runs. Each child retains its own source identity, Traverse artifact, Survey review history, and failure result; Fieldwork does not invent a cross-source review authority or relabel concurrent calls as provider-native batching.

Traverse owns source preparation. HTML and WebVTT use its built-in preparation. PDF and image inputs require host-supplied parser/OCR adapters, whose portable identifiers participate in run identity. Missing capabilities fail with typed public errors instead of silently degrading binary content to text.

Lookout owns registered-source checks, immutable proposal observations, continuity conflicts, and neutral semantic diff projection. Fieldwork composes those contracts rather than adding a second conditional-fetch or proposal-diff implementation. An unchanged result skips extraction. A changed result creates a new run, then Fieldwork replaces its initial full-proposal queue with the Lookout-projected semantic items before any decision event exists. The earlier run and its Survey event prefix are never rewritten.

A reviewed export is the receipt of one run's own review authority: the decisions recorded against that run's persisted review queue, projected from the queue itself. A first round's queue is the whole extraction, so the receipt is document-shaped; a recheck round's queue is the transition, so the receipt is round-shaped. Earlier decisions are not folded in. They were made against a different snapshot authority and are already the earlier run's receipt; copying them forward would publish one decision twice under two run identities and would make an export depend on a run it does not contain. Each recheck claim instead carries its round — transition and observation identities, change kind, and whether its evidence is the prior or the current observation — so a carried-forward value is never read as a fresh one.

Because the queue is the projected authority, a round has to be complete when the reviewer sees it, not repaired at export. Fieldwork completes Lookout's semantic items with the application-owned source kind, a per-observation raw-source identity, and the extractor of an observation whose evidence is absent; Lookout is the durable home for all three. Two rounds are refused rather than exported: one that resolves a single claim target two ways, and one that resolves onto an absent proposal, which has no span to cite and would need a reviewed-retraction record the trust bundle does not define.

Task and preparation drift are classifications, not semantic source changes. Changed bytes with byte-identical proposals produce an empty new round. Evidence additions, removals, moves, value changes, and provenance changes retain both observation identities and exact old/new snapshot evidence in a new Survey-owned round. Lookout's optimistic proposal-observation commit is the proposal advancement boundary: only one recheck may advance a source from the selected prior observation.

Fieldwork's recheck-v2 transport distinguishes acquisition that did not run from
completed or failed acquisition. Task drift is a write-free, pre-network
refusal; a missing check or prior observation is represented honestly as null.
Invocation identities and plain runtime policy are captured before awaits,
while opaque runtime capabilities retain their host-owned instances.

The authenticated Forage acquisition head and the Lookout proposal head are
independent. Same-byte recapture and conditional revalidation do not manufacture
proposal observations or copy review decisions. A receipt uses the actual
owner check time and capture facts, preserving lower legacy assurance when no
envelope digest exists.

Fieldwork owns bounded local check receipts and their pending/completed
generation, separate from those owner stores. Observable acquisition or
proposal head changes and superseded receipt generations refuse publication.
Successful publication follows a usable Survey round; replacing an initial
queue holds the existing run-review lock and rechecks the persisted revision,
events and queue. A concurrent review is never overwritten. A partial commit
can require recovery and is not reported as semantic success. These are
conservative as-of fences, not cross-store atomicity or a promise that a website
remains unchanged after a check. Source drift does not establish claim falsity,
and a check does not renew review or independently satisfy an answer policy.

## Consequences

Raw acquired bytes remain in the Forage snapshot store. Fieldwork persists only the exact prepared text needed for locator inspection and review. The source identity binds snapshot authority, content digest, media type, and relevant adapter identity, so changed preparation capabilities cannot reuse an older run accidentally.

This establishes deterministic acquisition/replay, multi-source composition, and source rechecks without moving SSRF or semantic-diff policy into Fieldwork or moving review semantics out of Survey. Frozen document-format and replay/drift conformance verifies the composition through PDF layout, OCR posture, unchanged-source provider skipping, exact old/new evidence, concurrent continuity, review, and portable output; it does not turn Fieldwork into a fetcher, parser, OCR engine, diff kernel, or second review surface.
