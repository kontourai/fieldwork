# Fieldwork

Fieldwork is a local, credential-free review application for grounded extraction. It proposes fields through Traverse, sends the proposal envelope to Survey for review, and exports a Surface-validated reviewed trust bundle only after server-owned review is complete.

## Quickstart

Requires Node 22.

```sh
npm install
npm run build
npm exec -- fieldwork run --task examples/generic/task.json --source examples/generic/source.txt --json
# Copy runDirectory from the JSON response:
npm exec -- fieldwork open /path/from/runDirectory
```

Review an item in the loopback browser, then export it:

```sh
npm exec -- fieldwork export /path/from/runDirectory --output reviewed.json --json
```

The checked-in provider is deterministic and offline; no credential, network, or private configuration is required.

## Sources and replay

`fieldwork run` accepts a local file with `--source`, or an exact Forage snapshot with `--snapshot` and `--snapshot-root`. Repeated source arguments create an ordered batch of independent runs; each source keeps its own extraction and review authority, and one source failure does not discard successful siblings.

```sh
# Acquire SSRF-checked web snapshots, then replay an exact returned sourceRef:
npm exec -- fieldwork acquire --url https://example.com \
  --snapshot-root .fieldwork/sources --max-pages 20 --max-depth 2 --json
npm exec -- fieldwork run --task task.json \
  --snapshot 'forage-source:v1:…' --snapshot-root .fieldwork/sources --json

# Ordered, failure-contained multi-source execution:
npm exec -- fieldwork run --task task.json \
  --source first.txt --source second.vtt --json
```

Forage owns acquisition policy, SSRF-safe fetching, content-addressed snapshots, and exact replay resolution. Fieldwork selects the application-owned snapshot store and returns portable snapshot references rather than source bodies or machine paths. Traverse owns HTML, transcript, PDF, and image preparation and locator grounding. Programmatic PDF and image runs require explicit host-supplied parser/OCR adapters; their bounded identifiers participate in run identity. The CLI fails with a typed adapter-required error when those capabilities are absent.

## Source rechecks and review rounds

Register a source with Lookout, then recheck it against an existing Fieldwork run:

```sh
npm exec -- fieldwork recheck \
  --source-id example-home --registry lookout.json \
  --prior-run .fieldwork/runs/run-… --task task.json \
  --snapshot-root .fieldwork/sources --json
```

When `--snapshot-root` is omitted for a recheck, Fieldwork uses its own local
`.fieldwork/lookout/snapshots` store. Hosts may always supply a different
application-owned path.

Lookout owns conditional source checks, proposal-observation continuity, concurrent-writer exclusion, and semantic proposal comparison. Fieldwork supplies the extraction capability and owns the application policy:

- unchanged source bytes skip Traverse and the selected model runtime;
- an unavailable source preserves the previous run and review history;
- task or preparation identity changes are reported separately from source semantics;
- changed source bytes with stable proposals create no review work;
- added, removed, moved, value-changed, or provenance-changed evidence creates a new Survey review round in a new run.

The prior run is immutable. A new round carries exact old and new snapshot references, observation identities, locators, excerpts, values, and extraction times. Replaying the same observation pair yields the same transition and item identities. Fieldwork persists proposal observations under the selected observation root and rejects a stale concurrent writer with `RECHECK_CONFLICT`.

## Runtime choice

The task file does not name a provider or runtime. Choose execution when the run starts, so the same task can move between a credential-free fixture, an already-authenticated local harness, a Datum-resolved SDK target, or a host-supplied Relay runtime.

```sh
# Native structured output through local harness authentication:
npm exec -- fieldwork run --task task.json --source source.txt --runtime codex:gpt-5 --json
npm exec -- fieldwork run --task task.json --source source.txt --runtime claude-code:sonnet --json

# Ordered local fallback:
npm exec -- fieldwork run --task task.json --source source.txt \
  --runtime codex:gpt-5 --runtime claude-code:sonnet \
  --max-attempts 4 --concurrency 2 --max-provider-calls 8 --json

# OpenCode exposes prompted rather than native schema enforcement, so opt in:
npm exec -- fieldwork run --task task.json --source source.txt \
  --runtime opencode:zai/glm-5 --allow-prompted-structured-output --json
```

Direct SDK mode resolves a role through Datum. It currently supports `anthropic-compatible` targets, requires the optional `@anthropic-ai/sdk` peer, and requires both a cost ceiling and an explicit rate assumption; other provider kinds can be supplied through the typed Relay runtime API.

```sh
npm install @anthropic-ai/sdk
npm exec -- fieldwork run --task task.json --source source.txt \
  --datum-role extraction-default \
  --max-cost-usd 1 --max-tokens-per-attempt 12000 \
  --estimated-usd-per-1k-tokens 0.003 --json
```

Relay owns invocation portability, Dispatch owns ordered fallback and durable authorization-wide capacity, and Traverse still owns the extraction prompt, schema, proposal interpretation, and exact grounding. Runtime selection participates in run identity. Before a provider launch, Dispatch records a crash-safe reservation under the Fieldwork run root; a successful attempt settles measured usage, while a failed or interrupted launch stays conservatively reserved until an explicit reconciliation. A restarted process cannot silently replay the same invocation. Attempt capacity is always durable. Token and cost ceilings additionally require `--max-tokens-per-attempt`; cost ceilings also require an explicit rate and native output-limit fidelity for every candidate.

Portable Dispatch receipts are stored in `run.json`; they retain candidate, model-runtime, capability fidelity, usage, failure category, reservation state, and estimated-cost evidence without request content, credentials, raw diagnostics, or the machine-local ledger path. Provider-reported and estimated costs remain distinct. Elapsed time remains a per-session measured limit rather than durable capacity.

`--concurrency` bounds chunk-level work in flight; completed chunks are normalized back into source order, and stored receipts are ordered by deterministic invocation sequence rather than scheduler completion. `--batch-size` asks Traverse to group chunks when the selected primary Relay runtime truthfully exposes a provider-native batch operation; the runtime's declared maximum still caps it. Dispatch authorizes and reserves every launched item before the one physical call, preserves positional outcomes, and applies explicit item-local fallback without relabeling concurrent single calls as batching. `--max-provider-calls` counts physical Traverse operations and stops later waves while retaining already grounded results as a typed partial result. One item can still use multiple Dispatch fallback attempts, so durable `--max-attempts` remains the model-launch ceiling. Cancellation likewise retains completed work. A failed chunk is preserved as a classified provider failure while successful chunks remain reviewable.

## Examples

- `examples/vendor-obligations`: extracts an agreement obligation and deadline for a vendor-management follow-up.
- `examples/incident-postmortem`: extracts incident timeline, impact, root cause, and corrective action into a review queue.
- `examples/grant-eligibility`: extracts eligibility, required materials, deadline, and evaluation criterion from a synthetic RFP.
- `examples/ordered-relationships`: extracts ordered entities, attributes, and a relationship from meeting notes.
- `examples/medication-review`: extracts synthetic medication, dose, route, frequency, reason, and negation evidence.
- `examples/multilingual-alignment`: extracts Japanese and Spanish values with exact character locators.
- `examples/schema-first`: exercises enum, JSON array, boolean, number, string, and JSON object field declarations.
- `examples/occurrence-resolution`: covers repeated mentions, punctuation, spacing, and source-order selection metadata.
- `examples/document-sections`: keeps two record sections ordered within one prepared source.
- `examples/long-form-groundwork`: provides a CI-sized repeated-section fixture for locator and occurrence groundwork.

Each is verified through the same `run → Survey events → reviewed export` contract, including its expected claims. The seven corpus fixtures carry checked-in comparison-neutral `oracle.json` files that freeze typed values, proposal order, exact excerpts and `chars:` offsets, occurrence metadata, diagnostics and warnings posture, deterministic replay metadata, and reviewed claim evidence.

The separate `conformance/long-input` tier deterministically assembles a 25,018-character source from a compact checked-in specification. Its independent oracle proves three default Traverse chunk calls, one deduplicated proposal in the overlap region, a late-document proposal, exact full-prepared-text locators, Survey review, and grounded export. Run it with `npm run test:conformance`.

The provider conformance tier additionally proves a single routed physical batch with positional item fallback and durable batch receipts, two-call bounded concurrency, out-of-order completion with source-ordered proposals and invocation-ordered receipts, exact locators across three chunks, classified partial provider failure with conservative reservation, physical-call ceilings, and cancellation before launch. These are deterministic mechanics tests, not live-provider quality evidence.

The `conformance/formats` tier freezes an ordered batch of replayable HTML, WebVTT, PDF-layout, and OCR snapshots plus one format-local failure. Its oracle proves exact prepared text and locators, independent snapshot and child-run authority, PDF page/element/table-cell inspection, explicit OCR posture, Survey review, portable Surface output, and redacted failure diagnostics. A browser baseline verifies that the shared Survey inspector visibly presents the PDF region while the Fieldwork shell remains themed by `@kontourai/ui`.

The replay-and-drift tier additionally freezes unchanged-source provider skipping, unavailable-source preservation, task drift, cosmetic source changes with stable proposals, changed/moved/removed evidence, deterministic semantic replay, portable old/new observations, and concurrent continuity conflicts. These deterministic tiers do not establish provider-native batching or live-provider quality. Those evidence tiers remain explicit in [issue #9](https://github.com/kontourai/fieldwork/issues/9). Run a small example by passing its `task.json` and `source.txt` to `fieldwork run`.

## Boundaries

Forage owns safe acquisition and immutable source snapshots. Traverse owns extraction proposals and verifies each `chars:` locator against the exact prepared text. Fieldwork persists that prepared text and its digest locally, and rejects a mismatched artifact. Survey owns review items, decisions, replay, canonical reviewed input, and the accessible Review Workbench and extraction inspector. Fieldwork mounts those shared Survey surfaces rather than implementing a second decision UI. `@kontourai/ui` supplies the application shell, visual tokens, and theme layer. The loopback server validates and persists Workbench-produced Survey events before deriving review state. Surface validates the final trust bundle.

Run directories contain the literal files `run.json`, `prepared.txt`, and `extraction-envelope.json`. Fieldwork validates their versioned schemas, rejects symlinks and containment escapes, and binds the actual prepared bytes back to the Traverse digest, length, ref, source ref, and portable envelope before review or export. An identical rerun reuses a valid run and preserves its event history; it fails closed without rewriting an invalid collision.

Portable export rejects any root-anchored POSIX path plus home-relative, Windows, UNC, and file-URI machine paths; credential names and maintained credential-value families including GitHub tokens and AWS access keys/secrets; private suite references; and raw diagnostics. Portable resource refs such as `fieldwork-source:v1:…` and `chars:…` remain valid. Local source text stays in the run directory; export is a reviewed trust artifact, not a source archive.

## Public contracts

`fieldwork run --task <file> (--source <file> | --snapshot <ref>)… [--snapshot-root <dir>] [--root <dir>] [--json]` creates one stable run or an ordered batch result. `fieldwork acquire --url <url> --snapshot-root <dir> [--json]` returns portable exact snapshot references. `fieldwork open <run> [--port <port>]` binds only `127.0.0.1` and prints a launch URL whose fragment carries a random per-launch capability. Browser API requests send that capability in a header. The server allowlists loopback Host values; requires same-origin `Origin` plus `application/json` for review mutations; bounds bodies and timeouts; and returns stable public error codes without local paths. Do not share the launch URL.

Review writes use a canonical run-directory storage lock held across read, prefix/revision comparison, Survey validation, and atomic commit. Its content-free PID record is fully written and synced before atomic, non-replacing publication, so no empty or partial live lock is exposed. Concurrent stale writers receive `REVIEW_CONFLICT`. A dead owning process or old corrupt bounded record is recovered without following links; live or ambiguous contention fails closed as `REVIEW_BUSY`.

`fieldwork export <run> --output <file> [--json]` refuses unresolved, stale, malformed, tampered, or ungrounded review state.

`fieldwork inspect <run> --output <file> [--include-prepared-text] [--include-excerpts] [--json]` writes a canonical read-only inspection artifact. Prepared text and excerpts are redacted unless each disclosure is explicitly requested. The artifact is independent of review disposition and contains no provider credentials, raw diagnostics, or machine paths.

The typed TypeScript API exports `acquireFieldwork`, `runFieldwork`, `runFieldworkBatch`, `recheckFieldwork`, `openRun`, `inspectionExport`, `reviewedExport`, task validation, `fieldworkHostDescriptor`, source adapter types, and versioned Fieldwork-owned acquisition, batch, recheck, run, view, mutation, prepared-artifact, and reviewed-export contracts. `createFieldworkApplication()` is the executable host facade: it launches runs, opens and reads a selected run, publishes content-free lifecycle events, accepts bounded title/theme/HTTP(S) navigation presentation, optionally permits one exact validated HTTP(S) embedding origin while denying framing by default, returns the Surface-validated reviewed output, and closes its sessions. The CLI and standalone loopback browser use the same underlying operations, and a host never imports Fieldwork internals. `recheckFieldwork` accepts an injected Lookout-compatible acquisition capability, so tests and hosts can retain their own registry and network authority. `@kontourai/fieldwork/runtime` exports the runtime-binding factories and stored-execution schema; programmatic callers may supply any Relay `ModelRuntime`, including SDK or framework adapters already owned by their host. The transport schemas validate their full advertised JSON shape. Survey inspector, snapshot, item, event, and apply sections remain explicitly opaque JSON at this public boundary; Fieldwork validates their persisted structure internally and delegates semantic replay/apply validation to Survey rather than republishing Survey's declaration graph or business vocabulary. No host dependency is required.

## Limits

Fieldwork accepts task files up to 256 KiB, source text up to 2 MiB, mutation bodies up to 16 MiB, stored structured artifacts up to 32 MiB, 128 projections/target fields, 10,000 Survey review items, 10,000 review events, 4,096 characters per general task string, and 512 characters per extraction pattern. Review-item capacity is intentionally separate from target-field capacity because a provider may ground repeated or alternative proposals for one field. Deterministic patterns intentionally support only a literal label followed by one line-bounded capture, for example `Status: ([^\n]+)`. Lookarounds, backreferences, nested/repeated groups, and arbitrary regular expressions are rejected.

## Verification

Run `npm run verify` for type, unit, example, long-input, provider, and document-format conformance; CLI and API behavior; rendered keyboard accessibility; browser visual/conflict checks; build; pack/install/bin smoke; content-boundary and decision checks; and Veritas readiness. Install Chromium first with `npx playwright install chromium` when it is not already available.

Pixel snapshots are controlled-renderer evidence, not a portable Linux-distro
contract. The default browser suite compares the committed macOS baselines.
Release runners set `FIELDWORK_VISUAL_SNAPSHOTS=0`; they still execute every
browser journey and its accessibility, interaction, responsive geometry,
persistence, security, and content assertions while avoiding font-package
rendering noise.

`npm audit` currently reports three linked moderate development-only entries under `@kontourai/veritas@1.5.3` through `@modelcontextprotocol/sdk` and `@hono/node-server`. npm offers only an incompatible Veritas `0.3.0` downgrade, so Fieldwork does not apply it. `npm audit --omit=dev` is clean. The packed runtime does not install Veritas, Playwright, Vite, tsx, `@kontourai/ui`, React, or React DOM; the latter three are bundled browser build inputs. This is an explicit upstream tooling residual, not a zero-advisory claim.

## License

Apache-2.0.
