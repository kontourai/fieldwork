import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function removeOwnedWorkspace(workspace) {
  rmSync(workspace, { force: true, maxRetries: 3, recursive: true });
}

export function withPackageSmokeWorkspace(run, removeWorkspace = removeOwnedWorkspace) {
  const workspace = mkdtempSync(join(tmpdir(), "fieldwork-package-"));
  let operationFailed = false;

  try {
    return run(workspace);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      removeWorkspace(workspace);
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError;
    }
  }
}
