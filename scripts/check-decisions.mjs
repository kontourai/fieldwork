import { existsSync, readFileSync } from "node:fs";
for (const path of ["CONTEXT.md", "docs/decisions/application-boundary.md", "docs/decisions/local-run-artifacts.md", "docs/decisions/deterministic-fixture-oracles.md", "docs/decisions/runtime-binding.md", "docs/decisions/source-acquisition-and-replay.md"]) { if (!existsSync(path) || !readFileSync(path, "utf8").trim()) throw new Error(`Required decision/context artifact missing: ${path}`); }
console.log("decision documentation passed");
