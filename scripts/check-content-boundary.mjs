import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const files = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--cached"], { encoding: "utf8" }).split("\n").filter(Boolean).filter((path) => !path.startsWith(".kontourai/") && !path.startsWith(".veritas/") && path !== ".gitignore" && path !== "scripts/check-content-boundary.mjs" && !path.startsWith("node_modules/"));
const forbidden = [/\/Users\//, /\.kontourai\//, /(?:api[_-]?key|authorization|secret|password)\s*[:=]/i];
const retiredCorpusClaims = [/examples\/multiple-documents/, /examples\/long-document-shard/, /target\.(?:outOfOrder|chunkEdge)/];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (forbidden.some((rule) => rule.test(content))) throw new Error(`Content-boundary violation: ${file}`);
  if (retiredCorpusClaims.some((rule) => rule.test(content))) throw new Error(`Retired corpus claim remains: ${file}`);
}
console.log(`content boundary passed for ${files.length} public files`);
