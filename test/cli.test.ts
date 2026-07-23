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
