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
        return output({
          ok: true,
          ...(await runFieldworkBatch({
            taskPath,
            root,
            sources: sources.map((source, index) => ({
              id: `source-${index + 1}`,
              ...(source.kind === "path"
                ? { sourcePath: source.value }
                : { snapshotRef: source.value, ...(snapshotRoot ? { snapshotRoot } : {}) }),
            })),
            ...(runtime ? { runtime } : {}),
          })),
        }, has(args, "--json"));
      }
      const source = sources[0]!;
      return output({
        ok: true,
        ...(await runFieldwork({
          taskPath,
          root,
          ...(source.kind === "path"
            ? { sourcePath: source.value }
            : { snapshotRef: source.value, ...(snapshotRoot ? { snapshotRoot } : {}) }),
          ...(runtime ? { runtime } : {}),
        })),
      }, has(args, "--json"));
    }
    if (command === "acquire") {
      const url = flag(args, "--url");
      if (!url) invalid("acquire requires --url <https-url>");
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
      const registry = await loadRegistry(flag(args, "--registry"));
      const source = registry.get(sourceId);
      if (!source) invalid(`registered source not found: ${sourceId}`);
      const selectedSnapshotRoot = snapshotRoot ?? resolve(".kontourai/lookout/snapshots");
      const store = createLookoutSnapshotStore(selectedSnapshotRoot);
      const runtime = runtimeBinding(args);
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
      const run = args.find((value) => !value.startsWith("--"));
      if (!run) throw Object.assign(new Error("open requires <run>"), { code: "INVALID_ARGUMENT" });
      const service = await openRun(resolve(run), Number(flag(args, "--port") ?? 0));
      output({ ok: true, url: service.url, loopbackOnly: true }, has(args, "--json"));
      process.once("SIGINT", () => void service.close().then(() => process.exit(0)));
      return;
    }
    if (command === "export") {
      const run = args.find((value) => !value.startsWith("--")), outputPath = flag(args, "--output");
      if (!run || !outputPath) throw Object.assign(new Error("export requires <run> --output <file>"), { code: "INVALID_ARGUMENT" });
      const artifact = await reviewedExport(resolve(run));
      await mkdir(dirname(resolve(outputPath)), { recursive: true }); await writeFile(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      return output({ ok: true, output: outputPath }, has(args, "--json"));
    }
    output(failure("USAGE", "fieldwork acquire|run|recheck|open|export; use README.md for the public contract"), true); process.exitCode = 2;
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
function has(args: string[], name: string): boolean { return args.includes(name); }
function output(value: unknown, json: boolean): void { process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`); }

function runtimeBinding(args: string[]): FieldworkRuntimeBinding | undefined {
  const profiles = flags(args, "--runtime");
  const datumRole = flag(args, "--datum-role");
  if (profiles.includes("fixture")) {
    if (profiles.length !== 1 || datumRole) invalid("fixture cannot be combined with another runtime");
    return undefined;
  }
  if (profiles.length && datumRole) invalid("--runtime and --datum-role are mutually exclusive");
  if (!profiles.length && !datumRole) return undefined;
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
  const maxProviderCalls = optionalPositiveInteger(args, "--max-provider-calls");
  if (datumRole) {
    return createDatumRuntimeBinding({
      role: datumRole,
      budget,
      maxOutputTokens,
      concurrency,
      ...(maxProviderCalls === undefined ? {} : { maxProviderCalls }),
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
    ...(maxProviderCalls === undefined ? {} : { maxProviderCalls }),
    ...(maxTokensPerAttempt === undefined ? {} : { maxTokensPerAttempt }),
    cwd: process.cwd(),
    ...(allowPrompted ? {
      allowPromptedStructuredOutput: true,
      minimumStructuredToolsFidelity: "prompted" as const,
    } : {}),
    ...(estimatedUsdPer1kTokens === undefined ? {} : { estimatedUsdPer1kTokens }),
  });
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
