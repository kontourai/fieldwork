# Local run artifacts

Status: accepted

A run retains the exact prepared text required to inspect Traverse `chars:` locators, its verified artifact identity, a text-free portable extraction envelope, and append-only Survey review events. The filenames are pinned by the versioned `run.json` schema. Reads reject symlinks and realpath escapes and bind the actual prepared bytes to the digest, length, artifact ref, source/snapshot ref, and Traverse envelope before review or export.

An identical deterministic run reuses an existing valid directory without rewriting its events or revision. New files use exclusive unpredictable temporary names and atomic rename. Review mutation takes a canonical-directory lock and holds it across read, revision/prefix compare-and-swap, Survey validation, and commit. The lock record is fully populated and synced under an unpredictable pending name, then atomically published with a non-replacing hard link, so contenders never observe a live empty or partial record. Dead-process and old corrupt lock records are recovered only after bounded, no-follow inspection; live or ambiguous contention fails closed.

The run directory is local and ignored by default. Export reads only a Survey canonical reviewed projection, validates it with Surface, scans it for portable disclosure, and fails closed when the prepared artifact, event stream, or resolution state is invalid. Disclosure scanning covers root-anchored POSIX paths and cross-platform path forms plus a maintained credential corpus including GitHub token families and AWS access-key and secret-key shapes.

A review round is bound to the queue it was decided against. The queue digest is taken once, when the round opens, and every later write carries it forward rather than recomputing it; every read re-derives the digest and refuses a queue that no longer matches. A digest a mutating writer refreshes would not be a binding, and a session record rebuilt from the queue it is checking can only agree with itself.

Export additionally checks the decided queue against an artifact it was not derived from. Before, Survey received envelope-derived items while the results came from the persisted queue, so its canonical-result check compared two independent origins; projecting the decided queue is the right authority but removes that second origin, so it is restored explicitly and widened from the selected candidate to the whole item.

That check asks whether the stored queue is the *same set* as the attesting side, not merely whether each thing still in it is well-formed. A first round's queue is the whole extraction, so item names must match the envelope's exactly in both directions: a check that only walks what is present cannot notice what was removed, and dropping an item leaves every survivor valid. An empty queue certifies nothing and is refused while the run has extracted proposals, whether it was emptied or simply recorded no changes. An item carrying neither extraction nor recheck provenance, and a queue mixing the two, are refused rather than trusted.

Which observation a recheck candidate came from decides which attestation applies, so it is never read off a single mutable label. It is derived from agreement between the item's transition identity, the candidate's Lookout observation id, the round block, and the candidate's role — which Lookout assigns as `current`→prior observation and `proposed`→current observation, and which the decision itself depends on. Candidates on the current-observation side must match this run's own extracted proposals, or match none when they record an absence.

Integrity inside a run directory is therefore agreement between artifacts written by different steps, not a cryptographic root: the envelope is bound to the prepared bytes by digest, and the queue must agree with both. Two parts have no in-run artifact to agree with, and both are functions of a snapshot this run never extracted: a recheck round's *prior*-observation candidates, and the recheck round's item set. Both are covered only by the queue binding, which a consistent rewrite of `run.json` could keep intact. That gap is accepted and disclosed; closing it needs the prior observation to carry an attestation this run can check on its own ([issue #65](https://github.com/kontourai/fieldwork/issues/65)).

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
