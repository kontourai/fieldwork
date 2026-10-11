# Reference

This page lists the `fieldwork` command-line surface and the package entry points. The [README](../README.md) explains what each result means; read its [public contracts](../README.md#public-contracts) for the export, inspection, and loopback-server guarantees.

## Command line

```text
fieldwork <acquire|run|recheck|open|inspect|export> [options]
```

Every command writes one JSON object to standard output. Without `--json` it is pretty-printed; with `--json` it is printed on one line. A failure is always printed on one line as `{ "ok": false, "error": { "code", "message" } }`.

| Exit status | Meaning |
| --- | --- |
| `0` | The command succeeded. A partial run still exits `0` with `ok: true` and `complete: false`, because the run is real and reviewable. So does a batch whose children all ran, even if some are partial. |
| `1` | The command failed. `error.code` is a typed code such as `INVALID_ARGUMENT`, `RECHECK_CONFLICT`, or `RUNTIME_INVOCATION_FAILED`. |
| `2` | Unknown or missing command (`USAGE`). |
| `3` | `export` wrote a partial export, or one with a claim whose grounding was refused. Or `run` completed a batch in which at least one source failed: the batch is still printed with `ok: true` and `complete: false`, successful children keep their runs, and the failed children are listed in `items` with `ok: false`. |

`open`, `inspect`, and `export` take one run directory, before or after their options: `fieldwork open --port 5 <run>` and `fieldwork open <run> --port 5` are the same. An option missing its value, an option the command does not take, a repeated option, or a second positional argument fails with `INVALID_ARGUMENT`.

Unless a root is given, Fieldwork keeps local state under `.fieldwork/` in the current directory: runs in `.fieldwork/runs`, and acquired snapshots in `.fieldwork/sources`.

## fieldwork run

Extracts proposals from one or more sources and persists a reviewable run.

```sh
fieldwork run --task <file> (--source <file> | --snapshot <ref>)... [options]
```

| Option | Meaning |
| --- | --- |
| `--task <file>` | Required. The task file (`kind: FieldworkTask`). See the files under `examples/` for complete tasks. |
| `--source <file>` | A local source file. Repeatable. |
| `--snapshot <ref>` | An exact Forage snapshot reference, as returned by `acquire`. Repeatable, and may be mixed with `--source`. |
| `--snapshot-root <dir>` | Where `--snapshot` references are resolved. Default `.fieldwork/sources`. |
| `--root <dir>` | The run root. Default `.fieldwork/runs`. |
| `--json` | Print the result on one line. |

At least one `--source` or `--snapshot` is required. With one source the result is a single run; with more than one, it is an ordered batch of independent child runs, one per source. The result carries `ok: true` and `complete`, which is `false` for a partial run, or for a batch unless every source ran and read its whole source. A batch in which any source failed exits `3`.

The runtime options below choose how extraction runs. With none, or with `--runtime fixture` alone, Fieldwork uses its offline deterministic provider, which has no limits to apply, so passing any limit option, `--role`, or `--allow-prompted-structured-output` fails with `INVALID_ARGUMENT`.

### Runtime options

| Option | Default | Meaning |
| --- | --- | --- |
| `--runtime <profile>` | none | A Relay runtime profile such as `codex:gpt-5` or `claude-code:sonnet`. Repeat it for ordered fallback. `fixture` selects the offline provider and cannot be combined with another runtime. |
| `--datum-role <role>` | none | Resolve the runtime through a Datum role instead. Mutually exclusive with `--runtime`. Requires `--max-cost-usd` and `--estimated-usd-per-1k-tokens`. |
| `--role <name>` | `fieldwork-extraction` | The role name recorded for `--runtime` profiles. |
| `--allow-prompted-structured-output` | off | Accept runtimes that only offer prompted, rather than native, structured output (for example `opencode:...`). |
| `--max-attempts <n>` | `16` | Durable ceiling on model launches. |
| `--max-elapsed-ms <n>` | `600000` | Elapsed-time limit for the session. |
| `--max-total-tokens <n>` | none | Token ceiling. Requires `--max-tokens-per-attempt`. |
| `--max-cost-usd <n>` | none | Estimated-cost ceiling. Requires `--estimated-usd-per-1k-tokens` and `--max-tokens-per-attempt`. |
| `--max-tokens-per-attempt <n>` | none | Declared worst-case total tokens for one attempt. |
| `--estimated-usd-per-1k-tokens <n>` | none | The explicit rate used to estimate cost. |
| `--max-output-tokens <n>` | `2048` | Output-token limit per call. |
| `--concurrency <n>` | `1` | Chunk-level work in flight. |
| `--batch-size <n>` | `1` | Requested chunks per physical call, honoured only when the primary runtime offers native batching. |
| `--max-provider-calls <n>` | none | Ceiling on physical Traverse provider operations. |
| `--max-chunks <n>` | Traverse's own (`40`) | Ceiling on prepared chunks. A source that crosses it produces a partial run with reason `max-chunks`. |

The limit options, and their defaults, apply only when `--runtime <profile>` (other than `fixture`) or `--datum-role` is given; without either, each is refused with `INVALID_ARGUMENT` rather than ignored. `--role` and `--allow-prompted-structured-output` apply only to `--runtime` profiles and are refused with `--datum-role`. When the limit options apply, integer options must be positive integers, and `--max-cost-usd` and `--estimated-usd-per-1k-tokens` must be positive numbers; anything else fails with `INVALID_ARGUMENT`. The [runtime choice](../README.md#runtime-choice) section of the README explains how these limits are enforced.

## fieldwork acquire

Fetches web pages through Forage and stores them as exact snapshots.

```sh
fieldwork acquire --url <url> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--url <url>` | required | The starting URL, `http` or `https`. Forage refuses any other scheme. |
| `--snapshot-root <dir>` | `.fieldwork/sources` | The snapshot store. |
| `--max-pages <n>` | `20` | Maximum pages to acquire (positive integer). |
| `--max-depth <n>` | `2` | Maximum link depth (zero or more). |
| `--discovery <mode>` | `links` | `links`, `sitemap`, or `both`. |
| `--render <mode>` | `never` | `never`, `on-shell`, or `always`. |
| `--json` | | Print the result on one line. |

Pass a returned snapshot reference to `run --snapshot`.

## fieldwork recheck

Checks a registered source again and, when its evidence moved, opens a new review round in a new run. The prior run is never modified.

```sh
fieldwork recheck --source-id <id> --prior-run <run> --task <file> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--source-id <id>` | required | A source registered in the Lookout registry. |
| `--prior-run <run>` | required | The run directory to compare against. |
| `--task <file>` | required | The task file. |
| `--registry <file>` | Lookout's default | The Lookout registry file. |
| `--snapshot-root <dir>` | `.fieldwork/lookout/snapshots` | The Lookout snapshot store. |
| `--root <dir>` | `.fieldwork/runs` | The run root for the new run. |
| `--observation-root <dir>` | `<root>/.lookout-observations` | Where proposal observations are stored. |
| `--json` | | Print the result on one line. |

Recheck accepts the same [runtime options](#runtime-options) as `run`. The README's [source rechecks](../README.md#source-rechecks-and-review-rounds) section describes each outcome.

## fieldwork open

Serves the review workbench for one run on `127.0.0.1`.

```sh
fieldwork open <run> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--port <port>` | a free port | The loopback port, an integer from `0` to `65535`; `0` picks a free port. Anything else fails with `INVALID_ARGUMENT`. |
| `--theme <theme>` | the shell default | `dark` or `light`. |
| `--reviewer <id>` | none | The reviewer every accepted decision is stamped with. Without it, decisions are recorded as `unattributed`. |
| `--reviewer-kind <kind>` | `human` | `human` or `agent`. Requires `--reviewer`. |
| `--json` | | Print the result on one line. |

It prints `{ "ok": true, "url": ..., "loopbackOnly": true }` and keeps serving until it receives `SIGINT` (Ctrl-C), which closes the server. The URL fragment carries a per-launch capability, so do not share it.

## fieldwork inspect

Writes a read-only inspection artifact for a run.

```sh
fieldwork inspect <run> --output <file> [--include-prepared-text] [--include-excerpts] [--json]
```

Prepared text and excerpts are redacted unless the matching flag is given. The result includes `reviewBlocked` when the run cannot be reviewed.

## fieldwork export

Writes the reviewed export for a run.

```sh
fieldwork export <run> --output <file> [--json]
```

The output is a `ReviewedExport` whose `bundle` is a Surface trust bundle. When some claims were left out, or an accepted claim's grounding was refused, the file is still written, the result lists `excluded` and `groundingRefused`, and the command exits `3`. Claims whose structure Surface cannot check are listed under `groundingUnchecked` without changing the exit status.

## Package entry points

| Import | Contents |
| --- | --- |
| `@kontourai/fieldwork` | `runFieldwork`, `runFieldworkBatch`, `acquireFieldwork`, `recheckFieldwork`, `openRun`, `inspectionExport`, `reviewedExport`, `createFieldworkApplication`, `parseFieldworkTask`, `fieldworkHostDescriptor`, `FIELDWORK_LIMITS`, and the versioned transport schemas (`fieldworkTaskSchema`, `fieldworkRunResultSchema`, `reviewedExportSchema`, and others). It also re-exports `createProfileRuntimeBinding`, `createDatumRuntimeBinding`, and `fieldworkStoredExecutionSchema` from `/runtime`, and the `parseReviewedWebSource*` parsers and `reviewedWebSource*Schema` schemas from `/reviewed-web-source-contract`. |
| `@kontourai/fieldwork/runtime` | `createProfileRuntimeBinding`, `createDatumRuntimeBinding`, `validateRuntimeBinding`, and `fieldworkStoredExecutionSchema`. |
| `@kontourai/fieldwork/host-descriptor` | `fieldworkHostDescriptor`, the static discovery descriptor for hosts. |
| `@kontourai/fieldwork/reviewed-web-source-contract` | Pure parsers and schemas for reviewed web source responses, such as `parseReviewedWebSourceDescriptor` and `parseReviewedWebSourceCurrentness`. |

The package requires Node 22 or newer. `@anthropic-ai/sdk` is declared as an optional peer dependency in `package.json`.
