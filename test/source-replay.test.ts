import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  crawl,
  createFilesystemSnapshotStore,
  type Snapshot,
} from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { acquireFieldworkWith } from "../src/acquisition.js";
import { runFieldwork, runFieldworkBatch } from "../src/fieldwork.js";

const fixture = resolve("examples/generic");

test("an exact Forage snapshot replays offline even after a newer capture exists", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-snapshots-"));
  const runRoot = await mkdtemp(join(tmpdir(), "fieldwork-snapshot-runs-"));
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const original = snapshot("capture-1", "<main><p>Status: Active</p></main>", "2026-07-20T10:00:00.000Z", {
    "Content-Type": "text/html; charset=utf-8",
  });
  const newer = snapshot("capture-1", "<main><p>Status: Pending</p></main>", "2026-07-21T10:00:00.000Z", {
    "content-type": "text/html; charset=utf-8",
  });
  await store.put(original);
  const ref = buildSnapshotSourceRef(original);
  await store.put(newer);

  const result = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    snapshotRef: ref,
    snapshotRoot,
    root: runRoot,
  });
  const envelope = JSON.parse(await readFile(join(result.runDirectory, "extraction-envelope.json"), "utf8"));
  const prepared = await readFile(join(result.runDirectory, "prepared.txt"), "utf8");

  assert.equal(envelope.source.ref, ref);
  assert.equal(envelope.source.snapshotRef, ref);
  assert.equal(envelope.result.preparedArtifact.sourceSnapshotRef, ref);
  assert.equal(envelope.result.proposals[0].candidateValue, "Active");
  assert.match(prepared, /Status: Active/);
  assert.doesNotMatch(prepared, /Pending/);
});

test("Fieldwork acquisition persists Forage snapshots but returns only portable page metadata", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-acquire-"));
  const runRoot = await mkdtemp(join(tmpdir(), "fieldwork-acquire-run-"));
  const captured = snapshot("acquired-page", "<p>Status: Active</p>", "2026-07-20T10:00:00.000Z", {
    "content-type": "text/html",
  });
  const sourceRef = buildSnapshotSourceRef(captured);
  const fakeCrawl: typeof crawl = async (seed, policy) => {
    await policy?.store?.put(captured);
    return {
      seed: seed.url,
      pages: [{
        url: captured.url,
        status: 200,
        body: captured.body,
        snapshot: captured,
        sourceRef,
        depth: 0,
        rendered: false,
        warnings: [],
      }],
      truncated: false,
      warnings: [],
    };
  };
  const acquired = await acquireFieldworkWith({
    url: captured.url,
    snapshotRoot,
    maxPages: 1,
  }, fakeCrawl);

  assert.deepEqual(acquired.pages, [{
    sourceRef,
    status: 200,
    depth: 0,
    rendered: false,
    warningCount: 0,
  }]);
  assert.doesNotMatch(JSON.stringify(acquired), /Status: Active|snapshotRoot|source\.txt/);
  const replay = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    snapshotRef: acquired.pages[0]!.sourceRef,
    snapshotRoot,
    root: runRoot,
  });
  assert.equal(replay.proposalCount, 1);
});

test("snapshot replay fails closed for a missing or altered exact reference", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-snapshot-missing-"));
  const missingRunRoot = await mkdtemp(join(tmpdir(), "fieldwork-snapshot-missing-run-"));
  const invalidRunRoot = await mkdtemp(join(tmpdir(), "fieldwork-snapshot-invalid-run-"));
  const original = snapshot("capture-2", "Status: Active", "2026-07-20T10:00:00.000Z");
  const ref = buildSnapshotSourceRef(original);

  await assert.rejects(
    () => runFieldwork({
      taskPath: join(fixture, "task.json"),
      snapshotRef: ref,
      snapshotRoot,
      root: missingRunRoot,
    }),
    /snapshot replay failed: snapshot-not-found/i,
  );
  await assert.rejects(
    () => runFieldwork({
      taskPath: join(fixture, "task.json"),
      snapshotRef: `${ref}tampered`,
      snapshotRoot,
      root: invalidRunRoot,
    }),
    /snapshot replay failed: invalid-reference/i,
  );
});

test("local and replayed WebVTT sources ground against cleaned transcript text", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-transcript-"));
  const sourcePath = join(root, "source.vtt");
  await writeFile(sourcePath, "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nStatus: Active\n", "utf8");
  const result = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath,
    root,
  });
  const envelope = JSON.parse(await readFile(join(result.runDirectory, "extraction-envelope.json"), "utf8"));
  assert.equal(envelope.result.proposals[0].candidateValue, "Active");
  assert.equal(await readFile(join(result.runDirectory, "prepared.txt"), "utf8"), "Status: Active");
});

test("PDF and image adapters are explicit and participate in run identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-binary-adapters-"));
  const pdf = join(root, "source.pdf");
  const image = join(root, "source.png");
  await writeFile(pdf, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  await writeFile(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  await assert.rejects(
    () => runFieldwork({ taskPath: join(fixture, "task.json"), sourcePath: pdf, root }),
    /PDF text adapter/,
  );
  await assert.rejects(
    () => runFieldwork({ taskPath: join(fixture, "task.json"), sourcePath: image, root }),
    /OCR adapter/,
  );

  const pdfResult = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: pdf,
    root,
    sourceAdapters: {
      pdf: { id: "fixture-pdf-v1", extract: { extract: () => ({ text: "Status: Active", pageOffsets: [0] }) } },
    },
  });
  const imageResult = await runFieldwork({
    taskPath: join(fixture, "task.json"),
    sourcePath: image,
    root,
    sourceAdapters: {
      image: { id: "fixture-ocr-v1", extract: { extract: async () => ({ text: "Status: Active" }) } },
    },
  });
  assert.notEqual(pdfResult.runResource, imageResult.runResource);
  assert.equal(await readFile(join(pdfResult.runDirectory, "prepared.txt"), "utf8"), "Status: Active");
  assert.equal(await readFile(join(imageResult.runDirectory, "prepared.txt"), "utf8"), "Status: Active");
});

test("multi-source execution preserves input order and contains source-local failures", async () => {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "fieldwork-batch-snapshots-"));
  const runRoot = await mkdtemp(join(tmpdir(), "fieldwork-batch-runs-"));
  const local = join(runRoot, "local.txt");
  await writeFile(local, "Status: Pending", "utf8");
  const store = createFilesystemSnapshotStore({ root: snapshotRoot });
  const captured = snapshot("batch-page", "Status: Active", "2026-07-20T10:00:00.000Z");
  await store.put(captured);
  const validRef = buildSnapshotSourceRef(captured);
  const missingRef = buildSnapshotSourceRef(
    snapshot("missing-page", "Status: Missing", "2026-07-20T10:00:00.000Z"),
  );

  const batch = await runFieldworkBatch({
    taskPath: join(fixture, "task.json"),
    root: runRoot,
    sources: [
      { id: "captured", snapshotRef: validRef, snapshotRoot },
      { id: "missing", snapshotRef: missingRef, snapshotRoot },
      { id: "local", sourcePath: local },
    ],
  });

  assert.deepEqual(batch.items.map((item) => [item.id, item.ok]), [
    ["captured", true],
    ["missing", false],
    ["local", true],
  ]);
  assert.equal(batch.succeeded, 2);
  assert.equal(batch.failed, 1);
  assert.deepEqual(batch.items[1], {
    id: "missing",
    ok: false,
    error: { code: "SNAPSHOT_REPLAY_FAILED", message: "Exact snapshot replay failed" },
  });
  assert.doesNotMatch(JSON.stringify(batch.items[1]), new RegExp(snapshotRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

function snapshot(
  sourceId: string,
  body: string,
  fetchedAt: string,
  headers?: Record<string, string>,
): Snapshot {
  return {
    sourceId,
    url: `https://example.invalid/${sourceId}`,
    status: 200,
    fetchedAt,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    ...(headers ? { headers } : {}),
  };
}
