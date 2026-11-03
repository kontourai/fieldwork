# Reviewed export as a memory source

A Fieldwork reviewed export can feed accumulated memory. `memoryClaimsFromReviewedExport(exported)` projects one `ReviewedExport` (a Surface trust bundle plus the Survey review records it carries) into memory claims. Reviewed claims arrive as reviewed; items no one decided arrive as proposed. It is a projection of the existing export, not a new truth: Fieldwork adds no schema, review disposition or trust status of its own, and it does not accumulate or store anything. Accumulation is [kontourai/surface#204](https://github.com/kontourai/surface/issues/204) and the store is Corpus Store.

## The claim schema is not Fieldwork's

The claims follow the Knowledge Kit memory claim schema. Fieldwork references it and does not copy it. This mapping targets:

| | |
| --- | --- |
| Repository | `kontourai/flow-agents` |
| Pull request | [#1574](https://github.com/kontourai/flow-agents/pull/1574), branch `feat/1571-memory-claims-routing` |
| Commit | `5e11b1ca719dd7ad082ec133452dee6163bdf77a` |
| Schema | `kits/knowledge/schemas/knowledge/memory-claim.schema.json`, `schema_version` `1.0` |
| Contract | `kits/knowledge/docs/memory-claims.md` at the same commit |

The same values are exported as `MEMORY_CLAIM_SCHEMA_PIN` and returned in each projection's `mapping`. Moving to a newer Kit commit is a deliberate change to the pin, the mapping below and the test.

Fieldwork builds the claim `id` itself (the Kit's identity rule: the sha256 of the canonical JSON of the claim's identity fields) because the Kit does not yet export a builder a package can import. The Kit recomputes the id on read and refuses a mismatch, so `test/memory-source.test.ts` pins ids that the Kit's own `memoryClaim` produced for these claims, and the Kit's `assertMemoryClaim` accepted every claim at the pinned commit.

## Review posture

The Kit's `posture` says how a claim was asserted, and the Kit keeps it apart from whether anyone reviewed the claim. The Kit's `posture` is part of the claim's identity, so a claim could not change posture when a reviewer decides it without becoming a different claim. Fieldwork therefore carries the two as the Kit does:

- `claim.posture` is `stated` or `proposed`. This is the review posture the export supports. `stated` means a reviewer accepted the value and the export verifies it. `proposed` means the export does not vouch for the value as reviewed.
- `origin` holds what the export said, copied and not reinterpreted, so a consumer can route on the Survey decision and the Surface status rather than on a Fieldwork word.

| The export says | Arrives as | `origin` |
| --- | --- | --- |
| Bundle claim `verified` | `stated` | `reviewed-claim`: the Surface claim id and status, the Survey `ReviewDecision` (name, status, resolution, actor id, time), and Fieldwork's `reviewRound.decisions` entry |
| Bundle claim `disputed` (the reviewer accepted it, but its grounding was refused) | `proposed` | `reviewed-claim` as above, with `groundingGaps` from `reviewRound.groundingRefused` |
| `reviewRound.excluded` entry `EXPORT_UNDECIDED` | `proposed`, one claim per verified proposal for the field | `unreviewed-item`: the export's exclusion entry |
| Bundle claim `rejected` | no claim | listed in `withheld` as `rejected-in-review` |
| Bundle claim in any other status | no claim | `withheld` as `unsupported-status` |
| Any other exclusion code (`EXPORT_FIELD_UNSETTLED`, `EXPORT_CONFLICTING_DECISIONS`, `EXPORT_UNGROUNDED_SELECTION`, `EXPORT_NOT_PROJECTABLE`) | no claim | `withheld` as `excluded-after-review` with the code |

A reviewed claim is never downgraded to `proposed` for being re-read, and an unreviewed item is never promoted. Nothing is dropped silently: everything the export holds that is not a claim is in `withheld` with the export's own reason. `reviewRound.complete` is passed through so a consumer can tell a partial export from a complete one.

Why not `hypothetical` or `retracted`: no fact in a reviewed export says a speaker spoke hypothetically or withdrew a statement, so the mapping never emits them. A rejected review is not a speaker's retraction.

## Field mapping

| Memory claim | From the export |
| --- | --- |
| `subject.type`, `subject.id` | the bundle claim's `subjectType`, `subjectId` (for an unreviewed item, the import record's claim target for the field) |
| `claimType` | the bundle claim's `claimType`, unchanged. The Kit assigns `knowledge.memory-claim` to claims it distills; other producers supply their own, so Fieldwork's claims do not share a slot with them |
| `property` | `fieldOrBehavior` |
| `value` | the bundle claim's `value`; for an unreviewed item, the proposal's `candidateValue` |
| `source.ref` | the run's source snapshot ref (`fieldwork-source:v1:...`) |
| `source.locator` | the proposal's `chars:<start>-<end>` locator |
| `source.excerpt` | the proposal's verbatim excerpt |
| `source.observedAt` | when Traverse extracted it |
| `source.extractor` | the proposal's extractor |
| `speaker` | the source ref. Fieldwork knows no author; naming the snapshot keeps each snapshot's authority its own |
| `validTime`, `qualifiers`, `supersedes`, `audience` | never emitted. Nothing in a reviewed export asserts them, and an absent `audience` inherits the source's, so omission never widens |

The proposal comes from the reviewed-extraction evidence the export carries (the evidence Surface's restore reads, bound to the extraction by digest). A reviewed claim with no such evidence cannot be grounded and is withheld as `no-reviewed-evidence`; a recheck round's export carries none today (see `reviewedGrounding` `not-evaluated`).

## Source authority stays per source

One export covers one run's review authority, and so does one projection. The claim's `source.ref` and `speaker` are that run's source snapshot, and both are in the Kit's claim identity, so the same field and value from two snapshots are two claims with two ids. The function takes one export and has no way to merge two. A batch of sources is an ordered collection of independent child runs; project each export on its own and keep the results apart.

## What this does not do

- It does not re-run Surface's reviewed-grounding policy. `reviewedGrounding` and `reviewRound` stay the authority on grounding; the projection reads the bundle Surface validates and the evidence Surface restores, and refuses an export whose evidence fails Surface's digest binding.
- It does not call the Kit, a store or an accumulation projection, and it does not decide what is current in a slot.
- It does not route, rank or deduplicate claims. The Kit's routing policy and Surface's accumulation own that.

## Reproducing the Kit check

At the pinned commit, copy `kits/knowledge/...` `src/memory-claims.ts` next to a script, project a real export, and call `assertMemoryClaim(claim)` and `memoryClaim(fieldsWithoutIdAndVersion).id` on each claim. The ids in `test/memory-source.test.ts` are the ones that check produced.
