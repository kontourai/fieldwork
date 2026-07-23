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

This CI corpus is groundwork over one prepared source per run. It does not exercise source chunking, a full long document, multiple-document batching, out-of-order model emissions, chunk-boundary recovery, multipass extraction, or a live provider. Those parity lanes remain open in [issue #9](https://github.com/kontourai/fieldwork/issues/9). Run an example by passing its `task.json` and `source.txt` to `fieldwork run`.

## Boundaries

Traverse owns extraction proposals and verifies each `chars:` locator against the exact prepared text. Fieldwork persists that prepared text and its digest locally, and rejects a mismatched artifact. Survey owns review items, decisions, replay, canonical reviewed input, and the accessible Review Workbench and extraction inspector. Fieldwork mounts those shared Survey surfaces rather than implementing a second decision UI. `@kontourai/ui` supplies the application shell, visual tokens, and theme layer. The loopback server validates and persists Workbench-produced Survey events before deriving review state. Surface validates the final trust bundle.

Run directories contain the literal files `run.json`, `prepared.txt`, and `extraction-envelope.json`. Fieldwork validates their versioned schemas, rejects symlinks and containment escapes, and binds the actual prepared bytes back to the Traverse digest, length, ref, source ref, and portable envelope before review or export. An identical rerun reuses a valid run and preserves its event history; it fails closed without rewriting an invalid collision.

Portable export rejects any root-anchored POSIX path plus home-relative, Windows, UNC, and file-URI machine paths; credential names and maintained credential-value families including GitHub tokens and AWS access keys/secrets; private suite references; and raw diagnostics. Portable resource refs such as `fieldwork-source:v1:…` and `chars:…` remain valid. Local source text stays in the run directory; export is a reviewed trust artifact, not a source archive.

## Public contracts

`fieldwork run --task <file> --source <file> [--root <dir>] [--json]` creates a stable resource reference. `fieldwork open <run> [--port <port>]` binds only `127.0.0.1` and prints a launch URL whose fragment carries a random per-launch capability. Browser API requests send that capability in a header. The server allowlists loopback Host values; requires same-origin `Origin` plus `application/json` for review mutations; bounds bodies and timeouts; and returns stable public error codes without local paths. Do not share the launch URL.

Review writes use a canonical run-directory storage lock held across read, prefix/revision comparison, Survey validation, and atomic commit. Its content-free PID record is fully written and synced before atomic, non-replacing publication, so no empty or partial live lock is exposed. Concurrent stale writers receive `REVIEW_CONFLICT`. A dead owning process or old corrupt bounded record is recovered without following links; live or ambiguous contention fails closed as `REVIEW_BUSY`.

`fieldwork export <run> --output <file> [--json]` refuses unresolved, stale, malformed, tampered, or ungrounded review state.

The typed TypeScript API exports `runFieldwork`, `openRun`, `reviewedExport`, task validation, `fieldworkHostDescriptor`, and versioned Fieldwork-owned run, view, mutation, prepared-artifact, and reviewed-export contracts and schemas. The transport schemas validate their full advertised JSON shape. Survey inspector, snapshot, item, event, and apply sections remain explicitly opaque JSON at this public boundary; Fieldwork validates their persisted structure internally and delegates semantic replay/apply validation to Survey rather than republishing Survey's declaration graph or business vocabulary. The descriptor is a documentation/fixture seam for a future host; no host dependency is required.

## Limits

Fieldwork accepts task files up to 256 KiB, source text up to 2 MiB, mutation bodies up to 1 MiB, 128 projections/target fields, 10,000 review events, 4,096 characters per general task string, and 512 characters per extraction pattern. Deterministic patterns intentionally support only a literal label followed by one line-bounded capture, for example `Status: ([^\n]+)`. Lookarounds, backreferences, nested/repeated groups, and arbitrary regular expressions are rejected.

## Verification

Run `npm run verify` for type, unit, CLI, API, rendered keyboard accessibility, browser visual/conflict, build, pack/install/bin, content-boundary, decision, and Veritas checks. Install Chromium first with `npx playwright install chromium` when it is not already available.

`npm audit` currently reports three linked moderate development-only entries under `@kontourai/veritas@1.5.3` through `@modelcontextprotocol/sdk` and `@hono/node-server`. npm offers only an incompatible Veritas `0.3.0` downgrade, so Fieldwork does not apply it. `npm audit --omit=dev` is clean. The packed runtime does not install Veritas, Playwright, Vite, tsx, `@kontourai/ui`, React, or React DOM; the latter three are bundled browser build inputs. This is an explicit upstream tooling residual, not a zero-advisory claim.

## License

Apache-2.0.
