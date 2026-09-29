# Local run artifacts

Status: accepted

A run retains the exact prepared text required to inspect Traverse `chars:` locators, its verified artifact identity, a text-free portable extraction envelope, and append-only Survey review events. The filenames are pinned by the versioned `run.json` schema. Reads reject symlinks and realpath escapes and bind the actual prepared bytes to the digest, length, artifact ref, source/snapshot ref, and Traverse envelope before review or export.

An identical deterministic run reuses an existing valid directory without rewriting its events or revision. New files use exclusive unpredictable temporary names and atomic rename. Review mutation takes a canonical-directory lock and holds it across read, revision/prefix compare-and-swap, Survey validation, and commit. The lock record is fully populated and synced under an unpredictable pending name, then atomically published with a non-replacing hard link, so contenders never observe a live empty or partial record. Dead-process and old corrupt lock records are recovered only after bounded, no-follow inspection; live or ambiguous contention fails closed.

The run directory is local and ignored by default. Export reads only a Survey canonical reviewed projection, validates it with Surface, scans it for portable disclosure, and fails closed when the prepared artifact, event stream, or resolution state is invalid. Disclosure scanning covers root-anchored POSIX paths and cross-platform path forms plus a maintained credential corpus including GitHub token families and AWS access-key and secret-key shapes.

A review round is bound to the queue it was decided against. The queue digest is taken once, when the round opens, and every later write carries it forward rather than recomputing it; every read re-derives the digest and refuses a queue that no longer matches. A digest a mutating writer refreshes would not be a binding, and a session record rebuilt from the queue it is checking can only agree with itself.

Export additionally checks the decided queue against an artifact it was not derived from. Before, Survey received envelope-derived items while the results came from the persisted queue, so its canonical-result check compared two independent origins; projecting the decided queue is the right authority but removes that second origin, so it is restored explicitly and widened from the selected candidate to the whole item.

That check asks whether the stored queue is the *same set* as the attesting side, not merely whether each thing still in it is well-formed. A first round's queue is the whole extraction, so item names must match the envelope's exactly in both directions: a check that only walks what is present cannot notice what was removed, and dropping an item leaves every survivor valid. An empty queue certifies nothing and is refused while the run has extracted proposals, whether it was emptied or simply recorded no changes. An item carrying neither extraction nor recheck provenance, and a queue mixing the two, are refused rather than trusted.

Reload applies the same check before anyone reviews the queue. Opening a run and appending a decision both check the stored queue against its extraction import (a recheck round against the envelope), and the run view hands Survey's workbench the import record so the workbench checks the queue too instead of showing it as unverified. The import record is rebuilt from the stored envelope and task rather than kept as a second copy that could disagree with them. This attests the queue against the stored envelope; the envelope itself is bound to the run at creation (see the fieldwork#164 amendment below). An empty queue is served unchecked, since an emptied first round cannot be told from a recheck round with nothing to re-decide, and export still refuses it.

Which observation a recheck candidate came from decides which attestation applies, so it is never read off a single mutable label. It is derived from agreement between the item's transition identity, the candidate's Lookout observation id, the round block, and the candidate's role — which Lookout assigns as `current`→prior observation and `proposed`→current observation, and which the decision itself depends on. Candidates on the current-observation side must match this run's own extracted proposals, or match none when they record an absence.

Integrity inside a run directory is therefore agreement between artifacts written by different steps, not a cryptographic root: the prepared bytes must match the artifact identity the envelope records, the envelope must match the digest `run.json` recorded for it at creation, and the queue must agree with the envelope. Two parts have no in-run artifact to agree with, and both are functions of a snapshot this run never extracted: a recheck round's *prior*-observation candidates, and the recheck round's item set. Both are covered only by the queue binding, which a consistent rewrite of `run.json` could keep intact. That gap is accepted and disclosed; closing it needs the prior observation to carry an attestation this run can check on its own ([issue #65](https://github.com/kontourai/fieldwork/issues/65)).

`npm run check:guards` fault-injects each of these checks and requires the suite covering it to fail, so "load-bearing" is reproducible rather than asserted. It rewrites tracked source and restores it from git, so it is run directly rather than as part of `verify`.

Persisted Survey JSON is checked structurally before it reaches Survey replay, then Fieldwork invokes Survey's server-session event validation and apply derivation for semantic validation. This structural adapter is intentionally narrow and temporary: [Survey issue #188](https://github.com/kontourai/survey/issues/188) requests reusable unknown-input validators so Survey can own the entire nested ReviewItem, queue snapshot, and event boundary.

Task target capacity and review-item capacity are separate bounds. A task may
declare at most 128 target fields while one field may yield repeated or
alternative grounded proposals; stored Survey snapshots therefore admit up to
10,000 ReviewItems inside a 32 MiB structured-artifact ceiling. The loopback
Workbench uses Survey's bounded presentation window rather than mounting the
complete snapshot at once.

`fieldwork inspect` rebinds the stored prepared bytes through Survey's canonical
read-only inspector export. Prepared text and excerpts are redacted by default
and require separate explicit disclosure flags. This artifact never represents
a review decision or reviewed trust output.

## Amendment (fieldwork#79, survey 2.4.0)

The queue binding and the whole-extraction rule described above are now
Survey's exports, not local code (kontourai/survey#213, adopted in
[fieldwork#79](https://github.com/kontourai/fieldwork/issues/79)): the stored
round digest is carried into Survey's `ReviewQueueBinding` at every read and
enforced through `deriveServerReviewSessionApplyResult`'s `binding` option,
and export's set-equality/byte-equality/empty-queue refusals run through
`assertReviewQueueAgainstExtractionImport`. The rules themselves are
unchanged — they moved down a layer so every consumer inherits them.

What stayed local is exactly what Survey's consumer guide names the caller's
storage obligation: this file's storage bindings (prepared-bytes/digest/ref
agreement on every read), the recheck observation dispatch and its
current-side attestation, and the disclosed fieldwork#65 gap. Survey's
cross-check attests queue-to-record consistency only; a writer who edits the
stored envelope's proposals and re-derives the queue from the edited record
presents a self-consistent pair Survey blesses, which is why `readRun`'s
prepared-bytes binding and the envelope-side checks above remain this repo's.

`npm run check:guards` was re-pointed with the swap: the collapsed local
guards became call-site injections (self-agreement, call deletion,
binding-not-passed) plus a pinned refusal for the empty-queue rule, and the
matrix adopted Survey's stricter attribution rule — an injection that fails
to compile fails the matrix; only a red test run counts as a catch.

## Amendment (fieldwork#148, fieldwork#149)

Review decisions are attributed by the host, not the client. Survey's session
model takes one actor and one time per round from the queue snapshot, and its
initial state is a constant placeholder, so every decision used to carry the
same synthetic reviewer and date. The loopback server now stamps each event it
appends with the host-configured reviewer (or the reserved `unattributed`
actor kind when none is configured), its own clock, and a review mode
(`individual`, `batch`, or `agent`) on the event's producer channel, and
ignores the actor and time the client sent. The append-only prefix check sets
that stamp aside, because the browser's copy of earlier events never learns
it. Export re-derives each result through Survey's own result builder under
the stamped actor and time until Survey replay reads them
(kontourai/survey#234). Events stored before stamping are left as stored and
exported as `legacy-synthetic-actor`.

The unit of an export is the claim, not the run. Checks about the round's
integrity (attestation, grounded extraction, valid history, coverage, excerpt
agreement, size) still refuse the whole export. Checks about one claim
(undecided, resolved onto an absence, contested by a differing accepted value,
on a field another item still leaves undecided, not projectable) exclude that
claim and list it with a typed reason. A round
with no exportable claim is still refused.

## Amendment (fieldwork#164, fieldwork#165)

The stored extraction is bound to the run when the run is created.
`run.json` records `extraction.envelopeDigest`, the SHA-256 of the envelope's
canonical JSON, and every read (opening, appending a decision, export, and the
metadata-only reads of the reviewed-source facade) refuses an envelope that no
longer matches it (`RUN_ENVELOPE_MISMATCH`). Before this, a proposal deleted
from the envelope, with the queue and its digest rebuilt to match, was served
as verified and exported: deleting one value of a conflict made the other read
as uncontested.

Survey's import now receives the prepared text, at creation and on every read
that has it. Survey checks each excerpt against its `chars:` span, leaves a
proposal that does not match out of the queue, records it on its claim slot as
an excluded rival, and marks the import `verified`. `run.json` records the
import status Survey wrote at creation as `extraction.importStatus`. A read
with the prepared text re-derives the status and must agree
(`RUN_EXTRACTION_MISMATCH`). A metadata-only read has no text, so it rebuilds
the import from the bound status, which Survey still checks for coherence
with the envelope. This keeps those reads off the prepared bytes.

Export's grounding policy now sets `requireVerifiedExcerpts` and
`refuseExcludedRivals`. An excluded rival is unverifiable, not disproven, and
the reviewer could never choose it, so the claim it contests is not allowed as
grounded. The claim is still exported, with an `excluded-rival-unresolved` gap.
`refuseChosenOverRivals` stays off, because a rival the reviewer saw and chose
against is a decision. A first round no longer refuses the whole export on an
excerpt mismatch, since Survey has already excluded the proposal. A recheck
round still refuses, because its current-side candidates are matched against
the envelope's proposals directly.

Runs created before the binding carry no `extraction` field. Verifying the
excerpts changes the items an import builds, so their stored queues could never
attest against a verified import. They are not re-bound: binding now would
bless whatever envelope the run holds today. They open against the unverified
import they were built from, so the source and its extraction can still be
inspected, but they are served with a `reviewBlocked` notice
(`unbound-envelope`) and the review queue is not shown. Decisions are
refused (`RUN_ENVELOPE_UNBOUND`), and so is export (`EXPORT_UNBOUND_ENVELOPE`).
Removing the binding from a bound run therefore closes it rather than
unlocking it.

A field whose every proposal fails the excerpt check has no review item left
for Survey to record the exclusion on, so it would drop out of the export
while the round read as complete. Export refuses it instead
(`EXPORT_EXCERPT_MISMATCH`, naming the field), as it did before Survey verified
excerpts. A claim the review accepted but whose grounding is refused, such as
one contested by an excluded rival, is listed under
`reviewRound.groundingRefused`; when the refusal is an unresolved rival value
it is also stated as `disputed` in the bundle. The CLI exits 3 for it, as for a
partial export, and the reviewed-source facade describes it with
`review.state: "grounding-refused"`.

A Lookout 0.7 prior observation stored from a partial run has no incomplete
marker, so it no longer matches the selected prior run, and every recheck of
that source is refused with `RECHECK_CONFLICT` (reason
`prior-observation-unmarked-incomplete`). Re-running the source does not touch
the observation store. The recovery is to recheck with a new, empty
`--observation-root`, or to move the source's directory out of the current one;
the prior is then re-established from the selected run with its marker.
Fieldwork does not delete observation history itself, because that store is
Lookout's continuity record and other checks may depend on it.

What remains: `run.json` and the envelope are both local files. A writer who
edits the envelope and also rewrites the bound digest, the bound status, the
queue and the queue's digest consistently is not detected. That is the same
class of gap as fieldwork#65, and closing it needs an attestation rooted
outside the run directory.
