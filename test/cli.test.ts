import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tempRoot } from "./helpers.js";
const exec = promisify(execFile);

test("CLI returns a typed JSON run contract", async () => {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--root", await tempRoot("cli"), "--json"]);
  const result = JSON.parse(stdout); assert.equal(result.ok, true); assert.match(result.runResource, /^fieldwork-run:v1:/);
});

test("CLI returns typed failure for missing arguments", async () => {
  await assert.rejects(() => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--json"]), (error: any) => { assert.match(error.stdout, /INVALID_ARGUMENT/); return true; });
});

test("CLI accepts an explicit fixture binding without changing the task", async () => {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--root", await tempRoot("cli-fixture"), "--runtime", "fixture", "--json"]);
  assert.equal(JSON.parse(stdout).ok, true);
});

test("CLI runs repeated sources as one ordered batch result", async () => {
  const root = await tempRoot("cli-batch");
  const { stdout } = await exec(process.execPath, [
    "--import", "tsx", "src/cli.ts", "run",
    "--task", "examples/generic/task.json",
    "--source", "examples/generic/source.txt",
    "--source", "examples/generic/source.txt",
    "--root", root,
    "--json",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "FieldworkBatchRunResult");
  assert.deepEqual(result.items.map((item: { id: string; ok: boolean }) => [item.id, item.ok]), [
    ["source-1", true],
    ["source-2", true],
  ]);
});

test("CLI refuses unenforceable SDK cost ceilings before reading Datum configuration", async () => {
  await assert.rejects(
    () => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--datum-role", "extraction-default", "--max-cost-usd", "1", "--json"]),
    (error: any) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "INVALID_ARGUMENT");
      assert.match(result.error.message, /estimated-usd-per-1k-tokens/);
      return true;
    },
  );
});

test("CLI requires explicit prompted structured-output opt-in for OpenCode", async () => {
  await assert.rejects(
    () => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--runtime", "opencode:zai/glm-5", "--json"]),
    (error: any) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "FIELDWORK_ERROR");
      assert.match(result.error.message, /explicit prompted-output opt-in/);
      return true;
    },
  );
});
