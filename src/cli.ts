#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { failure } from "./contracts.js";
import { reviewedExport, runFieldwork } from "./fieldwork.js";
import { openRun } from "./server.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  try {
    if (command === "run") {
      const taskPath = flag(args, "--task"), sourcePath = flag(args, "--source"), root = flag(args, "--root");
      if (!taskPath || !sourcePath) throw Object.assign(new Error("run requires --task <file> and --source <file>"), { code: "INVALID_ARGUMENT" });
      return output({ ok: true, ...(await runFieldwork({ taskPath, sourcePath, root })) }, has(args, "--json"));
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
function has(args: string[], name: string): boolean { return args.includes(name); }
function output(value: unknown, json: boolean): void { process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`); }
void main(process.argv.slice(2));
