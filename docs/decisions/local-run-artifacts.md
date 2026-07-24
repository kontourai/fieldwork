# Local run artifacts

Status: accepted

A run retains the exact prepared text required to inspect Traverse `chars:` locators, its verified artifact identity, a text-free portable extraction envelope, and append-only Survey review events. The filenames are pinned by the versioned `run.json` schema. Reads reject symlinks and realpath escapes and bind the actual prepared bytes to the digest, length, artifact ref, source/snapshot ref, and Traverse envelope before review or export.

An identical deterministic run reuses an existing valid directory without rewriting its events or revision. New files use exclusive unpredictable temporary names and atomic rename. Review mutation takes a canonical-directory lock and holds it across read, revision/prefix compare-and-swap, Survey validation, and commit. The lock record is fully populated and synced under an unpredictable pending name, then atomically published with a non-replacing hard link, so contenders never observe a live empty or partial record. Dead-process and old corrupt lock records are recovered only after bounded, no-follow inspection; live or ambiguous contention fails closed.

The run directory is local and ignored by default. Export reads only a Survey canonical reviewed projection, validates it with Surface, scans it for portable disclosure, and fails closed when the prepared artifact, event stream, or resolution state is invalid. Disclosure scanning covers root-anchored POSIX paths and cross-platform path forms plus a maintained credential corpus including GitHub token families and AWS access-key and secret-key shapes.

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
