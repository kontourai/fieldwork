import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const work = mkdtempSync(join(tmpdir(), "fieldwork-package-"));
execFileSync("npm", ["pack", "--pack-destination", work], { stdio: "inherit" });
const tarball = join(work, readdirSync(work).find((name) => name.endsWith(".tgz")));
execFileSync("npm", ["install", "--prefix", work, tarball], { stdio: "inherit" });
const installed = join(work, "node_modules/@kontourai/fieldwork");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
for (const obsolete of ["dist/runtime.js", "dist/runtime.d.ts"]) {
  try {
    readFileSync(join(installed, obsolete));
    throw new Error(`obsolete build artifact was packed: ${obsolete}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("obsolete build artifact")) throw error;
  }
}
for (const dependency of ["@kontourai/ui", "react", "react-dom"]) {
  if (manifest.dependencies?.[dependency]) throw new Error(`${dependency} must remain a bundled-browser build input`);
}
const stdout = execFileSync(join(work, "node_modules/.bin/fieldwork"), ["run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--root", join(work, "runs"), "--json"], { cwd: installed, encoding: "utf8" });
const run = JSON.parse(stdout);
if (!run.ok) throw new Error("Installed package CLI did not complete the packaged generic example");
const probe = `import { openRun } from "@kontourai/fieldwork"; const service = await openRun(${JSON.stringify(run.runDirectory)}); try { const pageResponse = await fetch(service.baseUrl + "/"); const page = await pageResponse.text(); const asset = page.match(/src=\"([^\"]+\\.js)\"/)?.[1]; if (!asset) throw new Error("installed browser did not declare a JavaScript asset"); const assetResponse = await fetch(new URL(asset, service.baseUrl)); const body = await assetResponse.text(); if (!assetResponse.ok || !assetResponse.headers.get("content-type")?.startsWith("text/javascript") || body.length < 100) throw new Error("installed JavaScript asset response was invalid"); } finally { await service.close(); }`;
execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { cwd: work, stdio: "inherit" });
writeFileSync(join(work, "consumer.mts"), `import {
  FIELDWORK_LIMITS, acquireFieldwork, fieldworkAcquisitionResultSchema,
  fieldworkBatchRunResultSchema, fieldworkRunResultSchema, fieldworkRunViewSchema,
  fieldworkTaskSchema, openRun,
  parseFieldworkTask, preparedArtifactViewSchema, reviewedExport,
  reviewedExportSchema, reviewMutationResponseSchema, runFieldwork, runFieldworkBatch,
  recheckFieldwork,
  type FieldworkRunViewV1, type FieldworkSourceAdapters, type FieldworkTask,
  type FieldworkLookoutSource, type FieldworkRecheckResult, type ReviewedExportV1
} from "@kontourai/fieldwork";
import { fieldworkHostDescriptor } from "@kontourai/fieldwork/host-descriptor";
import {
  createProfileRuntimeBinding, fieldworkStoredExecutionSchema,
  type FieldworkRuntimeBinding
} from "@kontourai/fieldwork/runtime";
const task: FieldworkTask = parseFieldworkTask({});
const view: FieldworkRunViewV1 = fieldworkRunViewSchema.parse({});
const reviewed: ReviewedExportV1 = reviewedExportSchema.parse({});
void [FIELDWORK_LIMITS, fieldworkTaskSchema, preparedArtifactViewSchema, reviewMutationResponseSchema, fieldworkHostDescriptor, task, view, reviewed];
const runtime: FieldworkRuntimeBinding = createProfileRuntimeBinding({
  profiles: ["codex:gpt-5"], budget: { maxAttempts: 1 }
});
const adapters: FieldworkSourceAdapters = {
  pdf: { id: "consumer-pdf-v1", extract: { extract: () => ({ text: "", pageOffsets: [0] }) } },
  image: { id: "consumer-ocr-v1", extract: { extract: async () => ({ text: "" }) } }
};
void fieldworkStoredExecutionSchema;
void [fieldworkAcquisitionResultSchema, fieldworkBatchRunResultSchema, fieldworkRunResultSchema];
void acquireFieldwork({ url: "https://example.com", snapshotRoot: "snapshots" });
void runFieldwork({ taskPath: "task.json", sourcePath: "source.txt" });
void runFieldwork({ taskPath: "task.json", sourcePath: "source.pdf", runtime, sourceAdapters: adapters });
void runFieldworkBatch({ taskPath: "task.json", sources: [{ id: "one", sourcePath: "source.txt" }] });
const lookoutSource: FieldworkLookoutSource = {
  id: "example", url: "https://example.com", cadenceHint: "manual",
  kind: "web-page", renderPolicy: "never", targetSchema: task.spec.traverse.targetSchema
};
const recheck: Promise<FieldworkRecheckResult> = recheckFieldwork({
  source: lookoutSource, priorRunDirectory: "run", taskPath: "task.json",
  acquisition: { check: async () => ({
    sourceId: "example", sourceUrl: "https://example.com", checkedAt: new Date().toISOString(),
    warnings: [], kind: "unchanged-304", snapshotRef: "forage-snapshot:example"
  }) }
});
void recheck;
void openRun("run");
void reviewedExport("run");
`);
writeFileSync(join(work, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    strict: true, skipLibCheck: false, noEmit: true, types: []
  },
  include: ["consumer.mts"]
}, null, 2));
execFileSync(join(process.cwd(), "node_modules/.bin/tsc"), ["-p", join(work, "tsconfig.json")], { cwd: work, stdio: "inherit" });
console.log("pack/install/bin smoke passed");
