#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { failure } from "./contracts.js";
import { reviewedExport, runFieldwork } from "./fieldwork.js";
import { openRun } from "./server.js";
import { createDatumRuntimeBinding, createProfileRuntimeBinding, type FieldworkRuntimeBinding } from "./runtime-contracts.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  try {
    if (command === "run") {
      const taskPath = flag(args, "--task"), sourcePath = flag(args, "--source"), root = flag(args, "--root");
      if (!taskPath || !sourcePath) throw Object.assign(new Error("run requires --task <file> and --source <file>"), { code: "INVALID_ARGUMENT" });
      const runtime = runtimeBinding(args);
      return output({ ok: true, ...(await runFieldwork({ taskPath, sourcePath, root, ...(runtime ? { runtime } : {}) })) }, has(args, "--json"));
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
    output(failure("USAGE", "fieldwork run|open|export; use README.md for the public contract"), true); process.exitCode = 2;
  } catch (error) {
    output(failure((error as { code?: string }).code ?? "FIELDWORK_ERROR", error instanceof Error ? error.message : "Unexpected failure"), true); process.exitCode = 1;
  }
}
function flag(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function flags(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
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
  if (datumRole) {
    return createDatumRuntimeBinding({
      role: datumRole,
      budget,
      maxOutputTokens,
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

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}
void main(process.argv.slice(2));
