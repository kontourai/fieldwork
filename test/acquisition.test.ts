import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { crawl, type CrawlManifest } from "@kontourai/forage";
import { acquireFieldworkWith } from "../src/acquisition.js";
import { runFieldwork } from "../src/fieldwork.js";
import { tempRoot } from "./helpers.js";

const genericTask = join("examples", "generic", "task.json");

type FixturePage = { status?: number; contentType?: string; body: string };

// A loopback-only HTTP server standing in for the "small page set" the issue
// asks for: real bytes over a real socket, no external network.
async function startFixtureServer(pages: Record<string, FixturePage>): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    const page = pages[request.url ?? "/"];
    if (!page) { response.writeHead(404); response.end(); return; }
    response.writeHead(page.status ?? 200, { "content-type": page.contentType ?? "text/html" });
    response.end(page.body);
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

// forage's crawl() accepts CrawlPolicy.egress.testOnlyAllowedLoopbackOrigins
// (see node_modules/@kontourai/forage README "Smoke-testing against a local
// fixture") but acquireFieldworkWith's own policy construction never forwards
// an `egress` override, so there is no way to opt a loopback origin in through
// FieldworkAcquisitionOptions. This wrapper is real forage `crawl` — same
// frontier, fetch, and snapshot-store code the production `acquireFieldwork`
// runs — with only the test-only escape hatch layered on, exactly as forage's
// own docs demonstrate for its own tests.
function realCrawlWithLoopbackAllowed(origin: string): typeof crawl {
  return (seed, policy) => crawl(seed, {
    ...policy,
    egress: { guarded: true, testOnlyAllowedLoopbackOrigins: [origin] },
    politeness: { delayMs: 0 },
  });
}

test("acquireFieldworkWith runs a real forage crawl against a loopback fixture and a run consumes the acquired snapshot", async () => {
  const fixture = await startFixtureServer({
    "/": { body: `<html><body><p>Status: Active</p><a href="/next">Next</a></body></html>` },
    "/next": { body: `<html><body><p>Status: Pending</p></body></html>` },
  });
  const snapshotRoot = await tempRoot("acquire-loopback-snapshots");
  const runRoot = await tempRoot("acquire-loopback-run");
  try {
    const acquired = await acquireFieldworkWith(
      { url: `${fixture.origin}/`, snapshotRoot, maxPages: 5, maxDepth: 1 },
      realCrawlWithLoopbackAllowed(fixture.origin),
    );

    assert.equal(acquired.truncated, false);
    assert.equal(acquired.warningCount, 0);
    assert.equal(acquired.pages.length, 2);
    assert.deepEqual(acquired.pages.map((page) => [page.status, page.depth, page.rendered]), [
      [200, 0, false],
      [200, 1, false],
    ]);
    assert.ok(acquired.pages.every((page) => page.sourceRef.startsWith("forage-snapshot:")));

    // The result stays portable — no raw page body leaks into it.
    assert.doesNotMatch(JSON.stringify(acquired), /Status: Active|Status: Pending/);

    const run = await runFieldwork({
      taskPath: genericTask,
      snapshotRef: acquired.pages[0]!.sourceRef,
      snapshotRoot,
      root: runRoot,
    });
    const envelope = JSON.parse(await readFile(join(run.runDirectory, "extraction-envelope.json"), "utf8"));
    assert.equal(envelope.result.proposals[0].candidateValue, "Active");
  } finally {
    await fixture.close();
  }
});

test("acquireFieldworkWith's real crawl denies a non-allowlisted loopback origin and surfaces forage's classified egress error", async () => {
  const fixture = await startFixtureServer({
    "/": { body: "<html><body><p>Status: Active</p></body></html>" },
  });
  const snapshotRoot = await tempRoot("acquire-egress-denied");
  let manifest: CrawlManifest | undefined;
  // Passes the policy through unmodified — this is exactly what the exported
  // acquireFieldwork() does (acquireFieldworkWith(options, crawl)); the only
  // addition is capturing the manifest so the test can inspect the raw,
  // classified warning forage's crawl records for the denial.
  const capturingRealCrawl: typeof crawl = async (seed, policy) => {
    manifest = await crawl(seed, policy);
    return manifest;
  };

  try {
    const acquired = await acquireFieldworkWith(
      { url: `${fixture.origin}/`, snapshotRoot, maxPages: 1 },
      capturingRealCrawl,
    );

    assert.equal(acquired.pages.length, 0);
    assert.equal(acquired.truncated, false);
    assert.ok(acquired.warningCount >= 1);
    assert.ok(manifest, "the real crawl should have run and been captured");
    // Both the robots.txt preflight and the page fetch itself go through the
    // same guarded egress and are independently denied; the page-fetch denial
    // carries forage's classified EgressPolicyErrorCode (egress.d.ts) for an
    // un-allowlisted loopback origin on a nonstandard port.
    const pageFetchWarning = manifest!.warnings.find((warning) => warning.includes("INVALID_PORT"));
    assert.ok(
      pageFetchWarning,
      `expected a classified INVALID_PORT egress denial, got: ${JSON.stringify(manifest!.warnings)}`,
    );
    assert.match(pageFetchWarning!, /egress-denied/);
    assert.match(pageFetchWarning!, /Server egress rejected \(INVALID_PORT\) for 127\.0\.0\.1/);
  } finally {
    await fixture.close();
  }
});
