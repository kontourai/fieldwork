# Reviewed export as a memory source

A Fieldwork reviewed export can feed accumulated memory. `memoryClaimsFromReviewedExport(exported)` projects one `ReviewedExport` (a Surface trust bundle plus the Survey review records it carries) into memory claims. Reviewed claims arrive as reviewed; items no one decided arrive as proposed. It is a projection of the existing export, not a new truth: Fieldwork adds no schema, review disposition or trust status of its own, and it does not accumulate or store anything. Accumulation is [kontourai/surface#204](https://github.com/kontourai/surface/issues/204) and the store is Corpus Store.

## The claim schema is not Fieldwork's

The claims follow the Knowledge Kit memory claim schema. Fieldwork references it and does not copy it. This mapping targets:

| | |
| --- | --- |
| Repository | `kontourai/flow-agents` |
| Pull request | [#1574](https://github.com/kontourai/flow-agents/pull/1574), branch `feat/1571-memory-claims-routing` |
| Commit | `6737ea9ebb37137a349fa7f60e5fd2dba9561c93` |
| Schema | `kits/knowledge/schemas/knowledge/memory-claim.schema.json`, `schema_version` `1.0` |
| Contract | `kits/knowledge/docs/memory-claims.md` at the same commit |

The same values are exported as `MEMORY_CLAIM_SCHEMA_PIN` and returned in each projection's `mapping`. Moving to a newer Kit commit is a deliberate change to the pin, the mapping below and the test.

Fieldwork builds the claim `id` itself (the Kit's identity rule at this commit: the sha256 of the canonical JSON of every other field of the claim, provenance included, so an edited excerpt or time is a different claim) because the Kit does not yet export a builder a package can import. The Kit recomputes the id on read and refuses a mismatch, so `test/memory-source.test.ts` pins ids that the Kit's own `memoryClaim` produced for these claims (with `source.observedAt` fixed, since a run's extraction time differs per run), and the Kit's `assertMemoryClaim` accepted every claim at the pinned commit.

## Review posture

Every claim is posture `stated`. The Kit's `posture` says how a claim was asserted, and the Kit keeps it apart from whether anyone reviewed the claim, so Fieldwork does not write review state into it. There is also a practical reason: the Kit's conflict routing skips `proposed` and `hypothetical` claims, so an unreviewed assertion marked `proposed` would escape conflict detection against what is already known.

The review posture rides beside the claim, as `arrival`:

- `arrival` is `reviewed` or `proposed`. It is derived from the export's own facts and nothing else, and it is the Kit's store-level arrival: a `proposed` claim is stored as a pending create proposal; a `reviewed` one is a claim a reviewer already accepted. It is not part of the claim, so a claim keeps its `id` when a reviewer decides it.
- `origin` holds what the export said, copied and not reinterpreted, so a consumer can route on the Survey decision and the Surface status rather than on a Fieldwork word.

| The export says | `arrival` | `origin` |
| --- | --- | --- |
| Bundle claim `verified` | `reviewed` | `reviewed-claim`: the Surface claim id and status, the Survey `ReviewDecision` (name, status, resolution, actor id, time), and Fieldwork's `reviewRound.decisions` entry |
| Bundle claim `disputed` (the reviewer accepted it, but its grounding was refused) | `proposed` | `reviewed-claim` as above, with `groundingGaps` from `reviewRound.groundingRefused` |
| `reviewRound.excluded` entry `EXPORT_UNDECIDED` | `proposed`, one claim per candidate of each item it names (Survey groups identical proposals into one candidate) | `unreviewed-item`: the export's exclusion entry |
| Bundle claim `rejected` | no claim | listed in `withheld` as `rejected-in-review` |
| Bundle claim in any other status | no claim | `withheld` as `unsupported-status` |
| Any other exclusion code (`EXPORT_FIELD_UNSETTLED`, `EXPORT_CONFLICTING_DECISIONS`, `EXPORT_UNGROUNDED_SELECTION`, `EXPORT_NOT_PROJECTABLE`) | no claim | `withheld` as `excluded-after-review` with the code |

A reviewed claim is never downgraded to `proposed` for being re-read, and an unreviewed item is never promoted. Nothing is dropped silently: everything the export holds that is not a claim is in `withheld` with the export's own reason. `reviewRound.complete` is passed through so a consumer can tell a partial export from a complete one.

Undecided items are taken by item. The export names the items it lists as undecided; the projection rebuilds the review items from the import record with Survey's own builder and takes the proposals of exactly those items, so a rejected or unsettled sibling on the same field is not remembered. A proposal Survey excluded because its excerpt did not verify was never a candidate. When it sits on an undecided item's field it is reported as `excerpt-not-verified`; beside a decided claim it appears in that claim's `groundingGaps`.

The export has to agree with itself, and the projection throws when it does not. It refuses:

- a bundle claim whose status, value or claim target disagrees with the Survey decision its evidence carries (stated as accepted but decided `rejected`, `rejected` but decided `verified`, a decision that was held, a value, subject, claim type or field other than the one the decision selected, or evidence citing a proposal other than the candidate the decision selected);
- a status that disagrees with the claim's own latest event (Surface derives status from events) or with `reviewRound.groundingRefused`, a refusal naming a claim that is not a disputed one, and an attribution that names a claim that does not exist, another review item, or another actor than the decision;
- an `EXPORT_UNDECIDED` entry that names an item the import record does not hold, an item that carries a decision (in the evidence or in the round's attribution), an item twice, an item under another field, or no item at all;
- a review item in the import record that the export neither decides nor lists as excluded, `complete` that disagrees with `excluded`, and a round scope missing `excluded` or `decisions` or with a malformed revision, `complete`, code or actor.

Two items that state the same value from the same span are one claim to the Kit, so the second is reported as `duplicate-claim` (an accepted one stands over an undecided twin).

What this is not: an authenticity check. Surface's digest binding makes evidence tamper-evident against edits, but evidence can be regenerated through Surface, and nothing in an export is signed. An export whose records are mutually consistent is accepted, even if it was rewritten consistently, including one that omits an item along with every record of it. The checks stop a claim being marked `reviewed` by editing only some of the records that say otherwise.

Why not `hypothetical` or `retracted`: no fact in a reviewed export says a speaker spoke hypothetically or withdrew a statement, so the mapping never emits them. A rejected review is not a speaker's retraction. Why `stated` for an unreviewed field: the document states the value; whether the extraction is right is exactly what review decides, and that is what `arrival` says.

## Field mapping

| Memory claim | From the export |
| --- | --- |
| `subject.type`, `subject.id` | the bundle claim's `subjectType`, `subjectId` (for an unreviewed item, the claim target of its review item) |
| `claimType` | the bundle claim's `claimType`, unchanged. The Kit assigns `knowledge.memory-claim` to claims it distills; other producers supply their own, so Fieldwork's claims do not share a slot with them |
| `property` | `fieldOrBehavior` |
| `value` | the bundle claim's `value`; for an unreviewed item, the proposal's `candidateValue`. A reviewer-edited value is not representable: Surface's reviewed-extraction contract refuses one, so the bundle's value is always the selected candidate's |
| `source.ref` | the run's source snapshot ref: `fieldwork-source:v1:...` for a local file, the Forage snapshot ref for a web snapshot |
| `source.locator` | the proposal's `chars:<start>-<end>` locator |
| `source.excerpt` | the proposal's verbatim excerpt |
| `source.observedAt` | when Traverse extracted it (part of the Kit identity, so a re-run of the same source gives new ids) |
| `source.extractor` | the proposal's extractor |
| `posture` | `stated` always (see above) |
| `speaker` | the source ref. Fieldwork knows no author; naming the snapshot keeps each snapshot's authority its own |
| `validTime`, `qualifiers`, `supersedes`, `visibility` | never emitted. Nothing in a reviewed export asserts them. An absent `visibility` reads as sealed (the narrowest), so omission never widens; a host that wants wider visibility stamps it |

The proposal comes from the reviewed-extraction evidence the export carries (the evidence Surface's restore reads, bound to the extraction by digest). A reviewed claim with no such evidence cannot be grounded and is withheld as `no-reviewed-evidence`; a recheck round's export carries none today (see `reviewedGrounding` `not-evaluated`).

## Source authority stays per source

One export covers one run's review authority, and so does one projection; an export that carries more than one source's import record is refused rather than attributed to one. The claim's `source.ref` and `speaker` are that run's source snapshot, and both are in the Kit's claim identity, so the same field and value from two snapshots are two claims with two ids. The function takes one export and has no way to merge two. A batch of sources is an ordered collection of independent child runs; project each export on its own and keep the results apart.

## What this does not do

- It does not re-run Surface's reviewed-grounding policy. `reviewedGrounding` and `reviewRound` stay the authority on grounding; the projection reads the bundle Surface validates and the evidence Surface restores, and refuses an export whose evidence fails Surface's digest binding.
- It does not call the Kit, a store or an accumulation projection, and it does not decide what is current in a slot.
- It does not route, rank or deduplicate claims. The Kit's routing policy and Surface's accumulation own that.

## Reproducing the Kit check

At the pinned commit, copy `kits/knowledge/...` `src/memory-claims.ts` next to a script, project a real export, and call `assertMemoryClaim(claim)` and `memoryClaim(fieldsWithoutIdAndVersion).id` on each claim. The ids in `test/memory-source.test.ts` are the ones that check produced.
