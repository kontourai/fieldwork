import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Veritas evidence invokes the non-recursive static gate", async () => {
  const map = JSON.parse(await readFile(".veritas/repo-map.json", "utf8"));
  assert.equal(map.evidence.evidenceChecks[0].command, "npm run verify:static");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.doesNotMatch(packageJson.scripts["verify:static"], /check:veritas/);
});

test("package metadata keeps browser build inputs out of runtime dependencies", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.license, "Apache-2.0");
  for (const dependency of ["@kontourai/ui", "react", "react-dom"]) {
    assert.equal(packageJson.dependencies[dependency], undefined);
    assert.equal(typeof packageJson.devDependencies[dependency], "string");
  }
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /runDirectory/);
  assert.doesNotMatch(readme, /\.fieldwork\/runs\/<run-resource>/);
});
