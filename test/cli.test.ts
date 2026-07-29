import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { tempRoot } from "./helpers.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);

// A loopback-only HTTP server for the CLI's "acquire" verb: real bytes over a
// real socket, no external network. The default guarded egress policy denies
// nonstandard-port loopback origins (see @kontourai/forage's README), and the
// CLI's `acquire` command has no flag that opts a loopback origin in (unlike
// acquireFieldworkWith's injectable `acquire` parameter used in
// test/acquisition.test.ts) — so this exercises the real crawl path denying
// the request, not a successful fetch.
async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body><p>Status: Active</p></body></html>");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

test("CLI returns a typed JSON run contract", async () => {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--root", await tempRoot("cli"), "--json"]);
  const result = JSON.parse(stdout); assert.equal(result.ok, true); assert.match(result.runResource, /^fieldwork-run:v1:/);
});

test("CLI writes a portable redacted static inspection artifact", async () => {
  const root = await tempRoot("cli-inspect");
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--root", root, "--json"]);
  const run = JSON.parse(stdout);
  const outputPath = join(root, "inspection.json");
  await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "inspect", run.runDirectory, "--output", outputPath, "--json"]);
  const artifact = await readFile(outputPath, "utf8");
  assert.match(artifact, /ExtractionInspectorExport/);
  assert.match(artifact, /\[redacted\]/);
  assert.doesNotMatch(artifact, /Status: Active/);
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

test("CLI acquire requires --url", async () => {
  await assert.rejects(
    () => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "acquire", "--json"]),
    (error: any) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "INVALID_ARGUMENT");
      assert.match(result.error.message, /acquire requires --url/);
      return true;
    },
  );
});

test("CLI acquire runs a real forage crawl and returns a typed acquisition result", async () => {
  const fixture = await startFixtureServer();
  try {
    const { stdout } = await exec(process.execPath, [
      "--import", "tsx", "src/cli.ts", "acquire",
      "--url", `${fixture.origin}/`,
      "--snapshot-root", await tempRoot("cli-acquire-snapshots"),
      "--max-pages", "1",
      "--json",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.kind, "FieldworkAcquisitionResult");
    // The CLI wires the real, non-injectable acquireFieldwork() (default
    // guarded egress, no loopback allowlist available from the CLI surface),
    // so the real crawl runs against our real fixture server and is denied by
    // forage's SSRF guard rather than fetching a page.
    assert.equal(result.pages.length, 0);
    assert.ok(result.warningCount >= 1);
  } finally {
    await fixture.close();
  }
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

test("CLI rejects a non-positive-integer --max-chunks before touching the runtime", async () => {
  await assert.rejects(
    () => exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--task", "examples/generic/task.json", "--source", "examples/generic/source.txt", "--runtime", "opencode:zai/glm-5", "--max-chunks", "0", "--json"]),
    (error: any) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "INVALID_ARGUMENT");
      assert.match(result.error.message, /--max-chunks/);
      return true;
    },
  );
});

test("CLI default (non --json) run output is still JSON and surfaces outcome, not only the --json path", async () => {
  // fieldwork#50 background: every existing CLI assertion passed --json, so a
  // shape that only leaked on the default pretty-printed path would have gone
  // unnoticed. This exercises the CLI's default output path directly.
  const { stdout } = await exec(process.execPath, [
    "--import", "tsx", "src/cli.ts", "run",
    "--task", "examples/generic/task.json",
    "--source", "examples/generic/source.txt",
    "--root", await tempRoot("cli-default-output"),
  ]);
  assert.match(stdout, /\n {2}"outcome": \{\n {4}"status": "success"\n {2}\}/, "default output must be the pretty-printed (non-compact) form, and outcome must be visible in it");
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(result.outcome, { status: "success" });
});
