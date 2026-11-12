# Reviewed export as a memory source

A Fieldwork reviewed export can feed accumulated memory. `memoryClaimsFromReviewedExport(exported)` projects one `ReviewedExport` (a Surface trust bundle plus the Survey review records it carries) into memory claims. Reviewed claims arrive as reviewed; items no one decided arrive as proposed. It is a projection of the existing export, not a new truth: Fieldwork adds no schema, review disposition or trust status of its own, and it does not accumulate or store anything. Accumulation is [kontourai/surface#204](https://github.com/kontourai/surface/issues/204) and the store is Corpus Store.

## The claim schema is not Fieldwork's

The claims follow the Knowledge Kit memory claim schema. Fieldwork references it and does not copy it. This mapping targets:

| | |
| --- | --- |
| Repository | `kontourai/flow-agents` |
| Pull request | [#1574](https://github.com/kontourai/flow-agents/pull/1574), merged; the commit below is its merge commit on `main` |
| Commit | `b0e4b106dd8d7f9f8a847c77ec7e9c395acceaa9` |
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
| Bundle claim `verified` with doubt about its grounding, or `disputed` (the reviewer accepted it, but its grounding was refused) | `proposed` | `reviewed-claim` as above, with `groundingGaps`: the kinds of doubt (for a disputed claim, the gaps `reviewRound.groundingRefused` lists) |
| `reviewRound.excluded` entry `EXPORT_UNDECIDED` | `proposed`, one claim per candidate of each item it names (Survey groups identical proposals into one candidate) | `unreviewed-item`: the export's exclusion entry |
| Bundle claim `rejected` | no claim | listed in `withheld` as `rejected-in-review` |
| Bundle claim in any other status | no claim | `withheld` as `unsupported-status` |
| Any other exclusion code (`EXPORT_FIELD_UNSETTLED`, `EXPORT_CONFLICTING_DECISIONS`, `EXPORT_UNGROUNDED_SELECTION`, `EXPORT_NOT_PROJECTABLE`) | no claim | `withheld` as `excluded-after-review` with the code |

A claim is not downgraded to `proposed` for being re-read, only for doubt about its grounding that the export carries, and an unreviewed item is never promoted. Nothing is dropped silently: everything the export holds that is not a claim is in `withheld` with the export's own reason. `reviewRound.complete` is passed through so a consumer can tell a partial export from a complete one.

Undecided items are taken by item. The export names the items it lists as undecided; the projection rebuilds the review items from the import record with Survey's own builder and takes the proposals of exactly those items, so a rejected or unsettled sibling on the same field is not remembered. A proposal Survey excluded because its excerpt did not verify was never a candidate. When it sits on an undecided item's field it is reported as `excerpt-not-verified`; beside a decided claim it appears in that claim's `groundingGaps`.

Two rules keep a claim from arriving `reviewed` on thinner evidence than the export has.

**Doubt downgrades; it does not refuse.** A claim arrives `reviewed` only when it is `verified` and nothing the export carries casts doubt on its grounding. Doubt is any of: a gap that disputes it in the grounding the projection recomputes from the digest-bound evidence (the same policy Fieldwork evaluates at export, `reviewedGroundingPolicy` in `src/reviewed-evidence.ts`, evaluated by Surface; anything but the structural gaps that leave a claim verified, where structure Surface checked and found invalid does dispute it, and a profile gap says structure was left unvalidated only when it says so: one that records dropped provenance or an unavailable artifact is doubt); a disputing gap in the receipt beside it (a gap names its claim by id and by the evidence it names, and is about both; one that names a claim or evidence the export does not have, or neither, is about every claim); a negative fact on the claim's receipt dimension (a prepared artifact that is not available, an excluded rival, a hidden conflict, excerpts recorded unverified, or structure found invalid), or any key the dimension states on which it differs from what the policy yields from the evidence (`receipt-differs`: the choice, the source state, a key the policy does not yield at all; a key only the policy yields is not stated, so a later Surface can add one); or a key of a candidate's extraction provenance (the extraction outcome, the evidence match, the occurrence) that differs from what Survey yields again from the import record (`candidate-differs`); or a Traverse schema mismatch on the proposal or on the candidate the reviewer selected. A claim with doubt arrives `proposed`, with the kinds of doubt in `origin.groundingGaps`, whatever its status says. One check is skipped for old writers: Fieldwork 0.11 and 0.12 never recorded whether excerpts were checked against the prepared text, so when the review item the evidence carries has no `excerptVerification` and its import says `provenance: "unverified"`, the excerpt gap that today's policy would find is not doubt. It is read from the evidence, not the receipt: an item that records `unverified` is doubt whatever the receipt says. This is also how an export an older Fieldwork wrote reads: Fieldwork 0.13.0 called a number field answered with text `verified` while its own receipt recorded the structure as invalid, and that claim arrives `proposed` with `structure-invalid` among the gaps.

**The records have to agree with each other, and the projection throws when they do not.** The receipt's per-claim dimensions must be the ones the evidence yields for the fields that bind them to a claim (its evidence, the reviewer's disposition, the exact locator and the digest of the value it states). The deciding records are compared with the import record Survey built the items from (a claim's subject, type and field must be a target it declares, and the proposal and the selected candidate must carry the same value type). The projection refuses:

- a bundle claim whose status, value or claim target disagrees with the Survey decision its evidence carries (stated as accepted but decided `rejected`, `rejected` but decided `verified`, a decision that was held, a value other than the one the decision selected, a subject, claim type or field that any candidate of the decided item does not share or that the import record does not declare, a value type the proposal and the selected candidate do not both carry, or evidence citing a proposal other than the candidate the decision selected), more than one reviewed-extraction evidence entry for a claim, and a `disputed` claim that nothing it carries casts doubt on;
- a claim, `verified`, `disputed` or `rejected`, whose status is not its latest event's (equal times: the first listed, as Surface derives it), or whose round attribution is missing or names another item, actor or time than its decision, or that has a review event by another actor; a rejected claim that states another target or value than the proposal it rejected;
- a round whose attributions repeat a claim or an item, or name a claim that does not exist;
- a receipt and refusal list that disagree with the claims: a refusal for a claim that is not disputed, a refusal that does not list exactly the gaps the receipt records for its claim, a receipt dimension that the carried evidence does not yield (a claim the export does not have, another disposition, locator or value digest), and a disputed claim with reviewed evidence that has no refusal (a conflict nobody could confirm is disputed with no evidence and is withheld as `no-reviewed-evidence`);
- an exclusion of any code that names an item the import record does not hold or lists it under another field, an `EXPORT_UNDECIDED` entry that names an item that carries a decision (in the evidence or in the round's attribution), an item twice, or no item at all, and any other exclusion that names an item the export also exports a decision for;
- a review item in the import record that the export neither decides nor lists as excluded, `complete` that disagrees with `excluded`, and a round scope missing `excluded` or `decisions`, or with a malformed revision, `complete`, actor, or an exclusion code Fieldwork does not write.

Two items that state the same value from the same span are one claim to the Kit, so the second is reported as `duplicate-claim`.

What the projection does not compare: the receipt's aggregate fields (`outcome`, `evaluatedClaimIds`, `evidenceIds`, `reviewItemNames`, `reviewDecisionNames`) do not decide a claim's arrival. Every key a dimension states is compared, and a stated key that the policy does not yield, or yields differently (an explicit `null` included), is doubt; a key the policy yields and the dimension omits is not, so an older writer's dimension still reads.

What the projection cannot tell: whether an export was written by Fieldwork 0.11 or 0.12 or rewritten into the shape they produced. Those writers never recorded the excerpt check and imported with `provenance: "unverified"`, so an export whose items lack `excerptVerification` under an import that says `unverified` is read as theirs and the check that today's policy would make is skipped; there is nothing in such an export to tell the two apart. (An item that lacks the record under an import that says `verified` is not that shape, and is doubt.) Reading that shape as honest is the choice that keeps the claims those writers called verified `reviewed`, apart from the typed exceptions above. A current Fieldwork refuses to export a run that 0.11 or 0.12 wrote (`EXPORT_UNBOUND_ENVELOPE`), so the check is recorded by running and reviewing the source again with a current Fieldwork.

What this is not: an authenticity check. Surface's digest binding makes evidence tamper-evident against edits, but evidence can be regenerated through Surface, and nothing in an export is signed. An export whose records are mutually consistent is accepted, even if it was rewritten consistently, including one that omits an item along with every record of it. The checks stop a claim arriving `reviewed` by editing only some of the records that say otherwise; they cannot tell an edit from a writer that disagreed with itself, which is why doubt downgrades instead of refusing.

Why not `hypothetical` or `retracted`: no fact in a reviewed export says a speaker spoke hypothetically or withdrew a statement, so the mapping never emits them. A rejected review is not a speaker's retraction. Why `stated` for an unreviewed field: the document states the value; whether the extraction is right is exactly what review decides, and that is what `arrival` says.

## Who reviewed it

`arrival` is descriptive provenance: `reviewed` says a reviewer's decision accepted the claim in this export, and the checks above found nothing carried that casts doubt on it. It is not a promotion signal and it does not say a person made the decision. Promotion is the Knowledge Kit's decision, not Fieldwork's, and Fieldwork does not duplicate that gate: a consumer that stores or promotes claims applies the Kit's rule, which cannot be bypassed by a Fieldwork export because the projection never emits a human attestation. The Kit separates the two: it promotes a routed claim only on a decision whose `spec.reviewerKind` is `human`, asserted by the host that authenticated the reviewer (Survey 8.4.0), and it reads a decision with no such field, or one marked inferred, as `unattested`, which can annotate a routed claim and cannot promote it.

Fieldwork uses Survey 8.4.0 but still writes no `spec.reviewerKind` (none of the 25 decisions in the exports written by published Fieldwork 0.11 to 0.13 does). To the Kit they remain `unattested`. The v1 reviewed export omits only Survey's newly inferred bundle-claim reviewer metadata (`reviewerKindInferred: true`) to keep its historical bytes stable; it retains the original Survey decisions and authority fields. Unsupported persisted reviewer-kind fields remain refused by the closed storage schema. The projection reads no authority into that compatibility mapping: `origin.attribution.actor.kind` (`human`, `agent` or `unattributed`) is Fieldwork's own stamp, and neither an inferred metadata kind nor that stamp supplies the Kit's human attestation. Having Fieldwork attest the reviewer kind its host configured (`--reviewer-kind`) remains a separate change, with its own authority and migration review.

## Which Fieldwork versions it reads

It reads the `ReviewedExport` envelope, which Fieldwork has written since 0.11. The published 0.11, 0.12, 0.13, 0.14, 0.14.1 and 0.15 were each run over all eleven examples (accepted, rejected, half decided and could-not-confirm) and the stored runs they can read: every claim those writers called verified arrives `reviewed`, with two kinds of exception. A claim whose own records carry doubt arrives `proposed`: 0.11 to 0.13 called a number or date answered in the wrong form verified. Their proposals carry Traverse's schema mismatch (and, for a number answered as text, their receipts record the invalid structure; for a date they record nothing), and today's writer disputes such a claim, so it arrives `proposed`. And the claims of a recheck round, which carries no reviewed-extraction evidence, are withheld (`no-reviewed-evidence`).

Fieldwork 0.9 and 0.10 exported a bare trust bundle. The Survey records do ride in its evidence, but there is no round scope beside it (no attribution, no list of undecided items, no completeness), so an unreviewed item cannot be listed and a decision cannot be attributed. This function reads the envelope, so those are refused with code `EXPORT_UNSUPPORTED_FORMAT`, and the remedy is to run and review the source again with Fieldwork 0.11 or later. Reading them would take a second mapping path that grounds a claim on its Survey records alone; that is a possible follow-up, not part of this issue.

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

At the pinned commit, copy the Kit's `src/memory-claims.ts` and `src/memory-json.ts` (which it imports) next to a script, in a folder where `@kontourai/relay` and `@kontourai/surface` resolve, project a real export, and call `assertMemoryClaim(claim)` and `memoryClaim(fieldsWithoutIdAndVersion).id` on each claim. The ids in `test/memory-source.test.ts` are the ones that check produced.
