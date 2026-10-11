#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { failure } from "./contracts.js";
import { acquireFieldwork } from "./acquisition.js";
import { reviewedExport, runFieldwork, runFieldworkBatch } from "./fieldwork.js";
import { openRun } from "./server.js";
import { createDatumRuntimeBinding, createProfileRuntimeBinding, type FieldworkRuntimeBinding } from "./runtime-contracts.js";
import { createCheckRunner, createLookoutSnapshotStore, loadRegistry } from "@kontourai/lookout";
import { recheckFieldwork } from "./recheck.js";
import { inspectionExport } from "./inspection.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  try {
    if (command === "run") {
      const taskPath = flag(args, "--task"), sources = sourceArguments(args);
      const snapshotRoot = flag(args, "--snapshot-root");
      const root = flag(args, "--root");
      if (!taskPath || sources.length === 0) {
        throw Object.assign(
          new Error("run requires --task <file> and at least one --source <file> or --snapshot <ref>"),
          { code: "INVALID_ARGUMENT" },
        );
      }
      const runtime = runtimeBinding(args);
      if (sources.length > 1) {
        const batch = await runFieldworkBatch({
          taskPath,
          root,
          sources: sources.map((source, index) => ({
            id: `source-${index + 1}`,
            ...(source.kind === "path"
              ? { sourcePath: source.value }
              : { snapshotRef: source.value, ...(snapshotRoot ? { snapshotRoot } : {}) }),
          })),
          ...(runtime ? { runtime } : {}),
        });
        // Complete only when every source ran and read its whole source.
        const complete = batch.items.every((item) => item.ok && item.run.outcome.status === "success");
        output({ ok: true, complete, ...batch }, has(args, "--json"));
        // A partial child is a real, reviewable run, like a partial single
        // run, and keeps exit 0. A failed child produced no run at all, so the
        // batch is still printed but exits 3, as a partial export does, so a
        // script cannot mistake it for every source having run.
        if (batch.items.some((item) => !item.ok)) process.exitCode = 3;
        return;
      }
      const source = sources[0]!;
      // `ok` says the run was extracted and persisted; `complete` says whether
      // it read the whole source. A partial run is a real, reviewable run, so
      // it is not a failure, but it must never read as complete.
      const result = await runFieldwork({
        taskPath,
        root,
        ...(source.kind === "path"
          ? { sourcePath: source.value }
          : { snapshotRef: source.value, ...(snapshotRoot ? { snapshotRoot } : {}) }),
        ...(runtime ? { runtime } : {}),
      });
      return output({ ok: true, complete: result.outcome.status === "success", ...result }, has(args, "--json"));
    }
    if (command === "acquire") {
      const url = flag(args, "--url");
      // Forage owns the scheme policy and accepts http and https; say so rather
      // than promise a stricter rule Fieldwork does not apply.
      if (!url) invalid("acquire requires --url <url> (http or https)");
      const discovery = enumFlag(args, "--discovery", ["links", "sitemap", "both"] as const);
      const render = enumFlag(args, "--render", ["never", "on-shell", "always"] as const);
      return output({
        ok: true,
        ...(await acquireFieldwork({
          url,
          snapshotRoot: flag(args, "--snapshot-root"),
          maxPages: positiveInteger(args, "--max-pages", 20),
          maxDepth: nonnegativeInteger(args, "--max-depth", 2),
          ...(discovery === undefined ? {} : { discovery }),
          ...(render === undefined ? {} : { render }),
        })),
      }, has(args, "--json"));
    }
    if (command === "recheck") {
      const sourceId = flag(args, "--source-id");
      const priorRunDirectory = flag(args, "--prior-run");
      const taskPath = flag(args, "--task");
      const snapshotRoot = flag(args, "--snapshot-root");
      if (!sourceId || !priorRunDirectory || !taskPath) {
        invalid("recheck requires --source-id <id> --prior-run <run> --task <file>");
      }
      // Settle the runtime options before reading the registry, so a refused
      // option is reported as such rather than masked by a registry error.
      const runtime = runtimeBinding(args);
      const registry = await loadRegistry(flag(args, "--registry"));
      const source = registry.get(sourceId);
      if (!source) invalid(`registered source not found: ${sourceId}`);
      const selectedSnapshotRoot = snapshotRoot ?? resolve(".fieldwork/lookout/snapshots");
      const store = createLookoutSnapshotStore(selectedSnapshotRoot);
      return output({
        ok: true,
        ...(await recheckFieldwork({
          source,
          priorRunDirectory: resolve(priorRunDirectory),
          taskPath,
          acquisition: createCheckRunner({ store }),
          snapshotRoot: selectedSnapshotRoot,
          ...(flag(args, "--root") === undefined ? {} : { root: flag(args, "--root") }),
          ...(flag(args, "--observation-root") === undefined ? {} : {
            observationRoot: flag(args, "--observation-root"),
          }),
          ...(runtime === undefined ? {} : { runtime }),
        })),
      }, has(args, "--json"));
    }
    if (command === "open") {
      const parsed = runCommandArguments("open", args, ["--port", "--theme", "--reviewer", "--reviewer-kind"], ["--json"]);
      const run = parsed.run;
      if (!run) invalid("open requires <run>");
      const theme = enumFlag(parsed.values, "--theme", ["dark", "light"] as const);
      const reviewerId = flag(parsed.values, "--reviewer");
      const reviewerKind = enumFlag(parsed.values, "--reviewer-kind", ["human", "agent"] as const);
      if (reviewerKind !== undefined && reviewerId === undefined) invalid("--reviewer-kind requires --reviewer <id>");
      const service = await openRun(resolve(run), {
        port: portFlag(parsed.values),
        ...(reviewerId === undefined ? {} : { reviewer: { id: reviewerId, kind: reviewerKind ?? "human" } }),
        ...(theme === undefined ? {} : {
          presentation: {
            apiVersion: "fieldwork.kontourai.io/v1",
            kind: "FieldworkHostPresentation",
            eyebrow: "Fieldwork",
            title: "Grounded review",
            theme,
            navigation: [],
          },
        }),
      });
      output({ ok: true, url: service.url, loopbackOnly: true }, has(args, "--json"));
      process.once("SIGINT", () => void service.close().then(() => process.exit(0)));
      return;
    }
    if (command === "export") {
      const parsed = runCommandArguments("export", args, ["--output"], ["--json"]);
      const run = parsed.run, outputPath = flag(parsed.values, "--output");
      if (!run || !outputPath) invalid("export requires <run> --output <file>");
      const artifact = await reviewedExport(resolve(run));
      await mkdir(dirname(resolve(outputPath)), { recursive: true }); await writeFile(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      // A partial export, or one stating an accepted claim its grounding
      // refused, is written but never silently: it is reported with what was
      // left out or contested, and exits 3 so a script cannot mistake it for
      // a complete, grounded one.
      // A claim whose structure Surface cannot check (an array or object
      // value) is reported separately and does not change the exit status:
      // nothing disputes it, and every run of such a task would otherwise exit 3.
      const scope = artifact.reviewRound as { complete?: boolean; excluded?: unknown[]; groundingRefused?: unknown[]; groundingUnchecked?: unknown[] } | undefined;
      const contested = scope?.groundingRefused ?? [];
      const unchecked = scope?.groundingUnchecked ?? [];
      const uncheckedSummary = unchecked.length === 0 ? {} : { groundingUnchecked: unchecked };
      if (scope?.complete === false || contested.length > 0) {
        output({
          ok: true, output: outputPath, complete: scope?.complete !== false, excluded: scope?.excluded ?? [],
          ...(contested.length === 0 ? {} : { groundingRefused: contested }), ...uncheckedSummary,
        }, has(args, "--json"));
        process.exitCode = 3;
        return;
      }
      return output({ ok: true, output: outputPath, complete: true, ...uncheckedSummary }, has(args, "--json"));
    }
    if (command === "inspect") {
      const parsed = runCommandArguments("inspect", args, ["--output"], ["--json", "--include-prepared-text", "--include-excerpts"]);
      const run = parsed.run, outputPath = flag(parsed.values, "--output");
      if (!run || !outputPath) invalid("inspect requires <run> --output <file>");
      const artifact = await inspectionExport(resolve(run), {
        includePreparedText: has(args, "--include-prepared-text"),
        includeExcerpts: has(args, "--include-excerpts"),
      });
      await mkdir(dirname(resolve(outputPath)), { recursive: true });
      await writeFile(resolve(outputPath), `${artifact}\n`, "utf8");
      const blocked = (JSON.parse(artifact) as { spec?: { reviewBlocked?: unknown } }).spec?.reviewBlocked;
      return output({ ok: true, output: outputPath, ...(blocked === undefined ? {} : { reviewBlocked: blocked }) }, has(args, "--json"));
    }
    output(failure("USAGE", "fieldwork acquire|run|recheck|open|inspect|export; use README.md for the public contract"), true); process.exitCode = 2;
  } catch (error) {
    output(failure((error as { code?: string }).code ?? "FIELDWORK_ERROR", error instanceof Error ? error.message : "Unexpected failure"), true); process.exitCode = 1;
  }
}
function flag(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function flags(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
}
function sourceArguments(args: string[]): Array<{ kind: "path" | "snapshot"; value: string }> {
  const sources: Array<{ kind: "path" | "snapshot"; value: string }> = [];
  args.forEach((value, index) => {
    const next = args[index + 1];
    if (!next) return;
    if (value === "--source") sources.push({ kind: "path", value: next });
    if (value === "--snapshot") sources.push({ kind: "snapshot", value: next });
  });
  return sources;
}
// `open`, `inspect` and `export` take one positional run directory among their
// options. Each option is known to take a value or not, so a value is never
// mistaken for the run, and an option this command does not know is refused
// rather than guessed at. Returns the run and the options as name/value pairs
// that `flag` and `enumFlag` read.
function runCommandArguments(
  command: string,
  args: string[],
  valueOptions: readonly string[],
  booleanOptions: readonly string[],
): { run: string | undefined; values: string[] } {
  const positionals: string[] = [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    if (booleanOptions.includes(value)) continue;
    if (!valueOptions.includes(value)) invalid(`${command} does not accept ${value}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) invalid(`${value} requires a value`);
    if (seen.has(value)) invalid(`${value} may be given only once`);
    seen.add(value);
    values.push(value, next);
    index += 1;
  }
  if (positionals.length > 1) invalid(`${command} takes one <run>, got ${positionals.length} positional arguments`);
  return { run: positionals[0], values };
}

function portFlag(args: string[]): number {
  const value = flag(args, "--port");
  if (value === undefined) return 0;
  // Decimal digits only: Number() would read "", " " as 0 and "0x50" as 80.
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) invalid("--port must be an integer from 0 to 65535");
  return Number(value);
}

function has(args: string[], name: string): boolean { return args.includes(name); }
function output(value: unknown, json: boolean): void { process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`); }

function runtimeBinding(args: string[]): FieldworkRuntimeBinding | undefined {
  const profiles = flags(args, "--runtime");
  const datumRole = flag(args, "--datum-role");
  if (profiles.includes("fixture")) {
    if (profiles.length !== 1 || datumRole) invalid("fixture cannot be combined with another runtime");
    refuseRuntimeOnlyOptions(args);
    return undefined;
  }
  if (profiles.length && datumRole) invalid("--runtime and --datum-role are mutually exclusive");
  if (!profiles.length && !datumRole) {
    refuseRuntimeOnlyOptions(args);
    return undefined;
  }
  if (datumRole) {
    const profileOnly = profileOnlyOptions.find((name) => has(args, name));
    if (profileOnly !== undefined) invalid(`${profileOnly} applies only to --runtime profiles, not --datum-role`);
  }
  const estimatedUsdPer1kTokens = optionalPositiveNumber(args, "--estimated-usd-per-1k-tokens");
  const maxCostUsd = optionalPositiveNumber(args, "--max-cost-usd");
  if (maxCostUsd !== undefined && estimatedUsdPer1kTokens === undefined) {
    invalid("--max-cost-usd requires --estimated-usd-per-1k-tokens so the ceiling is enforceable");
  }
  if (datumRole && (maxCostUsd === undefined || estimatedUsdPer1kTokens === undefined)) {
    invalid("--datum-role requires --max-cost-usd and --estimated-usd-per-1k-tokens");
  }
  const maxTotalTokens = optionalPositiveInteger(args, "--max-total-tokens");
  const maxTokensPerAttempt = optionalPositiveInteger(args, "--max-tokens-per-attempt");
  if ((maxTotalTokens !== undefined || maxCostUsd !== undefined) && maxTokensPerAttempt === undefined) {
    invalid("--max-total-tokens and --max-cost-usd require --max-tokens-per-attempt");
  }
  const budget = {
    maxAttempts: positiveInteger(args, "--max-attempts", 16),
    maxElapsedMs: positiveInteger(args, "--max-elapsed-ms", 600_000),
    ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
  const maxOutputTokens = positiveInteger(args, "--max-output-tokens", 2_048);
  const concurrency = positiveInteger(args, "--concurrency", 1);
  const batchSize = positiveInteger(args, "--batch-size", 1);
  const maxProviderCalls = optionalPositiveInteger(args, "--max-provider-calls");
  const maxChunks = optionalPositiveInteger(args, "--max-chunks");
  if (datumRole) {
    return createDatumRuntimeBinding({
      role: datumRole,
      budget,
      maxOutputTokens,
      concurrency,
      batchSize,
      ...(maxProviderCalls === undefined ? {} : { maxProviderCalls }),
      ...(maxChunks === undefined ? {} : { maxChunks }),
      ...(maxTokensPerAttempt === undefined ? {} : { maxTokensPerAttempt }),
      estimatedUsdPer1kTokens: estimatedUsdPer1kTokens!,
      resolve: { cwd: process.cwd() },
    });
  }
  const allowPrompted = has(args, "--allow-prompted-structured-output");
  return createProfileRuntimeBinding({
    profiles,
    role: flag(args, "--role") ?? "fieldwork-extraction",
    budget,
    maxOutputTokens,
    concurrency,
    batchSize,
    ...(maxProviderCalls === undefined ? {} : { maxProviderCalls }),
    ...(maxChunks === undefined ? {} : { maxChunks }),
    ...(maxTokensPerAttempt === undefined ? {} : { maxTokensPerAttempt }),
    cwd: process.cwd(),
    ...(allowPrompted ? {
      allowPromptedStructuredOutput: true,
      minimumStructuredToolsFidelity: "prompted" as const,
    } : {}),
    ...(estimatedUsdPer1kTokens === undefined ? {} : { estimatedUsdPer1kTokens }),
  });
}

const profileOnlyOptions = ["--role", "--allow-prompted-structured-output"] as const;
const runtimeOnlyOptions = [
  "--max-attempts",
  "--max-elapsed-ms",
  "--max-total-tokens",
  "--max-tokens-per-attempt",
  "--max-cost-usd",
  "--estimated-usd-per-1k-tokens",
  "--max-output-tokens",
  "--concurrency",
  "--batch-size",
  "--max-provider-calls",
  "--max-chunks",
  ...profileOnlyOptions,
] as const;

// The offline provider has no limits to apply. Refuse them rather than ignore
// them, so a caller never believes a ceiling is in force when it is not.
function refuseRuntimeOnlyOptions(args: string[]): void {
  const inapplicable = runtimeOnlyOptions.find((name) => has(args, name));
  if (inapplicable !== undefined) {
    invalid(`${inapplicable} applies only to a model runtime; pass --runtime <profile> or --datum-role <role>`);
  }
}

function positiveInteger(args: string[], name: string, fallback: number): number {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) invalid(`${name} must be a positive integer`);
  return Number(value);
}

function optionalPositiveNumber(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) invalid(`${name} must be a positive number`);
  return parsed;
}

function optionalPositiveInteger(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) invalid(`${name} must be a positive integer`);
  return Number(value);
}

function nonnegativeInteger(args: string[], name: string, fallback: number): number {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) invalid(`${name} must be a nonnegative integer`);
  return Number(value);
}

function enumFlag<const Values extends readonly string[]>(
  args: string[],
  name: string,
  values: Values,
): Values[number] | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!values.includes(value)) invalid(`${name} must be one of ${values.join(", ")}`);
  return value;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}
void main(process.argv.slice(2));
