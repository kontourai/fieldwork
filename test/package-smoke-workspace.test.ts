import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { withPackageSmokeWorkspace } from "../scripts/package-smoke-workspace.mjs";

test("package smoke removes its owned workspace after a successful operation", () => {
  let workspace = "";

  const result = withPackageSmokeWorkspace((createdWorkspace) => {
    workspace = createdWorkspace;
    writeFileSync(`${workspace}/consumer.txt`, "fixture");
    return "complete";
  });

  assert.equal(result, "complete");
  assert.equal(existsSync(workspace), false);
});

test("package smoke removes its owned workspace after an operation throws", () => {
  let workspace = "";
  const failure = new Error("consumer fixture failed");

  assert.throws(() => withPackageSmokeWorkspace((createdWorkspace) => {
    workspace = createdWorkspace;
    writeFileSync(`${workspace}/consumer.txt`, "fixture");
    throw failure;
  }), failure);
  assert.equal(existsSync(workspace), false);
});

test("package smoke preserves the operation diagnostic when cleanup also fails", () => {
  let workspace = "";
  const failure = new Error("consumer fixture failed");
  const cleanupFailure = new Error("cleanup failed");

  try {
    assert.throws(() => withPackageSmokeWorkspace(
      (createdWorkspace) => {
        workspace = createdWorkspace;
        throw failure;
      },
      () => { throw cleanupFailure; }
    ), failure);
  } finally {
    if (workspace) rmSync(workspace, { force: true, recursive: true });
  }
});
