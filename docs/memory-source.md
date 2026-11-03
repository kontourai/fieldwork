# Reviewed export as a memory source

A Fieldwork reviewed export can feed accumulated memory. `memoryClaimsFromReviewedExport(exported)` projects one `ReviewedExport` (a Surface trust bundle plus the Survey review records it carries) into memory claims. Reviewed claims arrive as reviewed; items no one decided arrive as proposed. It is a projection of the existing export, not a new truth: Fieldwork adds no schema, review disposition or trust status of its own, and it does not accumulate or store anything. Accumulation is [kontourai/surface#204](https://github.com/kontourai/surface/issues/204) and the store is Corpus Store.

## The claim schema is not Fieldwork's

The claims follow the Knowledge Kit memory claim schema. Fieldwork references it and does not copy it. This mapping targets:

| | |
| --- | --- |
| Repository | `kontourai/flow-agents` |
| Pull request | [#1574](https://github.com/kontourai/flow-agents/pull/1574), branch `feat/1571-memory-claims-routing` |
| Commit | `c107d1253d582d65bcb6aaa8c33e7c081f949751` |
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
| Bundle claim `verified`, with nothing carried casting doubt on its grounding (see below) | `reviewed` | `reviewed-claim`: the Surface claim id and status, the Survey `ReviewDecision` (name, status, resolution, actor id, time), and Fieldwork's `reviewRound.decisions` entry |
| Bundle claim `verified` with doubt about its grounding, or `disputed` (the reviewer accepted it, but its grounding was refused) | `proposed` | `reviewed-claim` as above, with `groundingGaps` from `reviewRound.groundingRefused` |
| `reviewRound.excluded` entry `EXPORT_UNDECIDED` | `proposed`, one claim per candidate of each item it names (Survey groups identical proposals into one candidate) | `unreviewed-item`: the export's exclusion entry |
| Bundle claim `rejected` | no claim | listed in `withheld` as `rejected-in-review` |
| Bundle claim in any other status | no claim | `withheld` as `unsupported-status` |
| Any other exclusion code (`EXPORT_FIELD_UNSETTLED`, `EXPORT_CONFLICTING_DECISIONS`, `EXPORT_UNGROUNDED_SELECTION`, `EXPORT_NOT_PROJECTABLE`) | no claim | `withheld` as `excluded-after-review` with the code |

A claim is not downgraded to `proposed` for being re-read, only for doubt about its grounding that the export carries, and an unreviewed item is never promoted. Nothing is dropped silently: everything the export holds that is not a claim is in `withheld` with the export's own reason. `reviewRound.complete` is passed through so a consumer can tell a partial export from a complete one.

Undecided items are taken by item. The export names the items it lists as undecided; the projection rebuilds the review items from the import record with Survey's own builder and takes the proposals of exactly those items, so a rejected or unsettled sibling on the same field is not remembered. A proposal Survey excluded because its excerpt did not verify was never a candidate. When it sits on an undecided item's field it is reported as `excerpt-not-verified`; beside a decided claim it appears in that claim's `groundingGaps`.

Two rules keep a claim from arriving `reviewed` on thinner evidence than the export has.

**Doubt downgrades; it does not refuse.** A claim arrives `reviewed` only when it is `verified` and nothing the export carries casts doubt on its grounding. Doubt is any of: a gap that disputes it in the grounding the projection recomputes from the digest-bound evidence (the same policy Fieldwork evaluates at export, `reviewedGroundingPolicy` in `src/reviewed-evidence.ts`, evaluated by Surface; anything but the structural gaps that leave a claim verified, where structure Surface checked and found invalid does dispute it); a disputing gap in the receipt beside it (a gap names its claim by id or by the evidence it names; a gap naming neither is about every claim); a negative fact on the claim's receipt dimension (a prepared artifact that is not available, an excluded rival, a hidden conflict, excerpts recorded unverified, or structure found invalid); or a Traverse schema mismatch on the proposal or on the candidate the reviewer selected. A claim with doubt arrives `proposed`, with the kinds of doubt in `origin.groundingGaps`, whatever its status says. One check is skipped for old writers: a receipt written before Fieldwork 0.14 never recorded whether excerpts were checked against the prepared text, so when no dimension of the receipt records it, the excerpt gap that today's policy would find is not doubt. This is also how an export an older Fieldwork wrote reads: Fieldwork 0.13.0 called a number field answered with text `verified` while its own receipt recorded the structure as invalid, and that claim arrives `proposed` with `structure-invalid` among the gaps.

**The records have to agree with each other, and the projection throws when they do not.** The receipt's per-claim dimensions must be the ones the evidence yields for the fields that bind them to a claim (its evidence, the reviewer's disposition, the exact locator and the digest of the value it states). The deciding records are compared with the import record Survey built the items from (a claim's subject, type and field must be a target it declares, and the proposal and the selected candidate must carry the same value type). The projection refuses:

- a bundle claim whose status, value or claim target disagrees with the Survey decision its evidence carries (stated as accepted but decided `rejected`, `rejected` but decided `verified`, a decision that was held, a value other than the one the decision selected, a subject, claim type or field that any candidate of the decided item does not share or that the import record does not declare, a value type the proposal and the selected candidate do not both carry, or evidence citing a proposal other than the candidate the decision selected), more than one reviewed-extraction evidence entry for a claim, and a `disputed` claim that nothing it carries casts doubt on;
- a claim, `verified`, `disputed` or `rejected`, whose status is not its latest event's (equal times: the first listed, as Surface derives it), or whose round attribution is missing or names another item, actor or time than its decision, or that has a review event by another actor; a rejected claim that states another target or value than the proposal it rejected;
- a round whose attributions repeat a claim or an item, or name a claim that does not exist;
- a receipt and refusal list that disagree with the claims: a refusal for a claim that is not disputed, a refusal that does not list exactly the gaps the receipt records for its claim, a receipt dimension that the carried evidence does not yield (a claim the export does not have, another disposition, locator or value digest), and a disputed claim with reviewed evidence that has no refusal (a conflict nobody could confirm is disputed with no evidence and is withheld as `no-reviewed-evidence`);
- an exclusion of any code that names an item the import record does not hold or lists it under another field, an `EXPORT_UNDECIDED` entry that names an item that carries a decision (in the evidence or in the round's attribution), an item twice, or no item at all, and any other exclusion that names an item the export also exports a decision for;
- a review item in the import record that the export neither decides nor lists as excluded, `complete` that disagrees with `excluded`, and a round scope missing `excluded` or `decisions`, or with a malformed revision, `complete`, actor, or an exclusion code Fieldwork does not write.

Two items that state the same value from the same span are one claim to the Kit, so the second is reported as `duplicate-claim`.

What the projection does not compare: the receipt's `outcome`, `evaluatedClaimIds`, `evidenceIds`, `reviewItemNames` and `reviewDecisionNames`, and the dimension fields other than the ones named above, except that a dimension's `structuralTrust: "invalid"` counts as doubt. They do not decide a claim's arrival.

What this is not: an authenticity check. Surface's digest binding makes evidence tamper-evident against edits, but evidence can be regenerated through Surface, and nothing in an export is signed. An export whose records are mutually consistent is accepted, even if it was rewritten consistently, including one that omits an item along with every record of it. The checks stop a claim arriving `reviewed` by editing only some of the records that say otherwise; they cannot tell an edit from a writer that disagreed with itself, which is why doubt downgrades instead of refusing.

Why not `hypothetical` or `retracted`: no fact in a reviewed export says a speaker spoke hypothetically or withdrew a statement, so the mapping never emits them. A rejected review is not a speaker's retraction. Why `stated` for an unreviewed field: the document states the value; whether the extraction is right is exactly what review decides, and that is what `arrival` says.

## Which Fieldwork versions it reads

It reads the `ReviewedExport` envelope, which Fieldwork has written since 0.11. Exports from 0.11, 0.12, 0.13, 0.14 and 0.15 (the published releases checked) project: every claim those writers called verified arrives `reviewed`, except a claim whose own receipt records invalid structure, which arrives `proposed`. Fieldwork 0.9 and 0.10 exported a bare trust bundle with no Survey decisions, round attribution or import record beside it, so there is nothing to map a `reviewed` claim from; those are refused with code `EXPORT_UNSUPPORTED_FORMAT`, and the remedy is to export the run again with a current Fieldwork.

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

- It does not replace Surface's reviewed-grounding policy or Fieldwork's `reviewedGrounding` receipt, which stay the authority on grounding. It re-evaluates the same policy over the evidence the export carries only to check that the export's own claims and receipt agree with it; it can add doubt the receipt does not record (the receipt is an editable record, the evidence is digest-bound), and it never removes doubt the receipt does record.
- It does not call the Kit, a store or an accumulation projection, and it does not decide what is current in a slot.
- It does not route or rank claims, or merge them across exports; within one export, identical content is one claim. The Kit's routing policy and Surface's accumulation own that.

## Reproducing the Kit check

At the pinned commit, copy `kits/knowledge/...` `src/memory-claims.ts` next to a script, project a real export, and call `assertMemoryClaim(claim)` and `memoryClaim(fieldsWithoutIdAndVersion).id` on each claim. The ids in `test/memory-source.test.ts` are the ones that check produced.
