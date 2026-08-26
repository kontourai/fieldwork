import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES } from "../src/fieldwork-limits.js";
import { FieldworkSourceCheckReceiptStore, type SourceCheckStorageHooks } from "../src/source-check-receipts.js";

const source = "source-a", head = "a".repeat(64), next = "b".repeat(64);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const capture = () => ({ sourceId: source, snapshotRef: "capture-a", url: "https://example.invalid/a", bodyHash: "c".repeat(64), fetchedAt: "2026-08-26T10:00:00.000Z", integrity: "body-and-identity" as const });
const completion = () => ({ checkedAt: "2026-08-26T10:01:00.000Z", outcome: "changed" as const, priorProposalHeadId: head, resultProposalHeadId: next, priorCapture: capture(), currentCapture: { ...capture(), snapshotRef: "capture-b", bodyHash: "d".repeat(64) } });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-storage-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FieldworkSourceCheckReceiptStore(root);
  const pending = await store.begin(source, { pointerToken: null, proposalHeadId: head, admittedAcquisition: capture() }, async () => head);
  const directory = join(root, hash(source));
  return { root, directory, store, pending, pointer: join(directory, "pointer.json") };
}
async function receiptPath(directory: string) {
  const names = (await readdir(directory)).filter((name) => /^receipt-.*\.json$/.test(name));
  assert.equal(names.length, 1);
  return join(directory, names[0]!);
}

for (const kind of ["pointer", "receipt"] as const) {
  for (const phase of ["afterReadOpen", "afterReadStat"] as const) {
    test(`${kind} growth at ${phase} fails closed with hook executed`, async (t) => {
      const f = await fixture(t);
      await f.store.finalize(f.pending, completion(), async () => next);
      const path = kind === "pointer" ? f.pointer : await receiptPath(f.directory);
      let injections = 0;
      const hooks: SourceCheckStorageHooks = {
        [phase]: async (actual: "pointer" | "receipt" | "lock") => {
          if (actual === kind && injections++ === 0) await appendFile(path, Buffer.alloc(FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES + 1, 32));
        },
      };
      const result = await new FieldworkSourceCheckReceiptStore(f.root, hooks).readCurrent(source, async () => next);
      assert.ok(injections >= 1, "real file growth was injected");
      assert.equal(result.kind, "corrupt");
    });
  }
  test(`${kind} MAX+1 bytes are rejected even when JSON is otherwise valid`, async (t) => {
    const f = await fixture(t);
    await f.store.finalize(f.pending, completion(), async () => next);
    const path = kind === "pointer" ? f.pointer : await receiptPath(f.directory);
    const bytes = await readFile(path);
    await appendFile(path, Buffer.alloc(FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES + 1 - bytes.length, 32));
    assert.equal((await lstat(path)).size, FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES + 1);
    let opened = 0;
    const store = new FieldworkSourceCheckReceiptStore(f.root, { afterReadOpen: async (actual) => { if (actual === kind) opened++; } });
    assert.equal((await store.readCurrent(source, async () => next)).kind, "corrupt");
    assert.ok(opened >= 1);
  });
  for (const replacement of ["regular", "symlink"] as const) {
    test(`${kind} pathname ${replacement} swap after open rejects detached inode`, async (t) => {
      const f = await fixture(t);
      await f.store.finalize(f.pending, completion(), async () => next);
      const path = kind === "pointer" ? f.pointer : await receiptPath(f.directory);
      let injections = 0;
      const store = new FieldworkSourceCheckReceiptStore(f.root, {
        afterReadOpen: async (actual) => {
          if (actual !== kind || injections++ !== 0) return;
          await rename(path, `${path}.detached`);
          if (replacement === "symlink") await symlink(`${path}.detached`, path);
          else await writeFile(path, await readFile(`${path}.detached`));
        },
      });
      assert.equal((await store.readCurrent(source, async () => next)).kind, "corrupt");
      assert.ok(injections >= 1);
    });
  }
}

test("immutable publication exposes complete temporary bytes and never replaces a competing final inode", async (t) => {
  const f = await fixture(t);
  let injections = 0;
  let final = "";
  const collision = "competing immutable record";
  const store = new FieldworkSourceCheckReceiptStore(f.root, {
    beforeImmutableLink: async () => {
      injections++;
      const names = (await readdir(f.directory)).filter((name) => /^receipt-.*\.pending$/.test(name));
      assert.equal(names.length, 1);
      const temp = join(f.directory, names[0]!);
      const bytes = await readFile(temp, "utf8");
      assert.deepEqual(JSON.parse(bytes), { version: 1, sourceId: source, generation: 1, ...completion() });
      assert.equal((await lstat(temp)).mode & 0o777, 0o600);
      final = join(f.directory, `receipt-1-${hash(bytes)}.json`);
      await assert.rejects(() => lstat(final), { code: "ENOENT" });
      await writeFile(final, collision, { flag: "wx" });
    },
  });
  assert.equal((await store.finalize(f.pending, completion(), async () => next)).kind, "corrupt");
  assert.equal(injections, 1);
  assert.equal(await readFile(final, "utf8"), collision);
  assert.equal((await f.store.readCurrent(source, async () => next)).kind, "pending");
  assert.deepEqual((await readdir(f.directory)).filter((name) => name.endsWith(".pending")), []);
});

test("lock publication exposes a populated temporary owner and does not replace a live competing owner", async (t) => {
  const f = await fixture(t);
  const lock = join(f.directory, ".lock");
  const competing = JSON.stringify({ pid: process.pid, createdAt: Date.now(), marker: "other" });
  let injections = 0, heads = 0;
  const store = new FieldworkSourceCheckReceiptStore(f.root, {
    beforeLockLink: async () => {
      const names = (await readdir(f.directory)).filter((name) => name.startsWith(".lock.") && name.endsWith(".pending"));
      assert.equal(names.length, 1);
      const temp = join(f.directory, names[0]!);
      const record: { pid: number; createdAt: number } = JSON.parse(await readFile(temp, "utf8"));
      assert.equal(record.pid, process.pid);
      assert.ok(Number.isFinite(record.createdAt));
      assert.equal((await lstat(temp)).mode & 0o777, 0o600);
      if (injections++ === 0) {
        await assert.rejects(() => lstat(lock), { code: "ENOENT" });
        await writeFile(lock, competing, { flag: "wx" });
      }
    },
  });
  const result = await store.finalize(f.pending, completion(), async () => { heads++; return next; });
  assert.ok(injections >= 1);
  assert.equal(heads, 0, "the transaction never acquired the competing owner's lock");
  assert.equal(result.kind, "busy");
  assert.equal(await readFile(lock, "utf8"), competing);
  assert.deepEqual((await readdir(f.directory)).filter((name) => name.endsWith(".pending")), []);
});

for (const phase of ["afterReadOpen", "afterReadStat"] as const) {
  test(`lock recovery growth at ${phase} remains bounded and preserves ambiguous owner`, async (t) => {
    const f = await fixture(t);
    const lock = join(f.directory, ".lock");
    await writeFile(lock, "{");
    const aged = new Date(Date.now() - 120_000);
    await utimes(lock, aged, aged);
    let injections = 0;
    const hooks: SourceCheckStorageHooks = {
      [phase]: async (kind: "pointer" | "receipt" | "lock") => {
        if (kind === "lock" && injections++ === 0) await appendFile(lock, Buffer.alloc(FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES + 1, 32));
      },
    };
    assert.equal((await new FieldworkSourceCheckReceiptStore(f.root, hooks).finalize(f.pending, completion(), async () => next)).kind, "busy");
    assert.equal(injections, 1);
    assert.equal((await lstat(lock)).size, FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES + 2);
  });
}

test("unchanged-hash admits a fresh exact capture without advancing the proposal head", async (t) => {
  const f = await fixture(t);
  const fresh = { ...capture(), snapshotRef: "fresh-same-body-capture", fetchedAt: "2026-08-26T10:01:00.000Z" };
  const result = await f.store.finalize(f.pending, { ...completion(), outcome: "unchanged-hash", resultProposalHeadId: head, currentCapture: fresh }, async () => head);
  assert.equal(result.kind, "available");
  const read = await new FieldworkSourceCheckReceiptStore(f.root).readCurrent(source, async () => head);
  assert.equal(read.kind, "available");
  if (read.kind === "available") {
    assert.equal(read.receipt.priorCapture.snapshotRef, "capture-a");
    assert.equal(read.receipt.currentCapture.snapshotRef, fresh.snapshotRef);
  }
});

test("pending acquisition baseline rejects portable disclosure before persisting", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.pointer);
  await assert.rejects(() => f.store.begin(source, {
    pointerToken: f.pending.pointerToken,
    proposalHeadId: head,
    admittedAcquisition: { ...capture(), snapshotRef: "/home/example/raw-source.txt" },
  }, async () => head), (error: unknown) => {
    assert.ok(error instanceof Error && "kind" in error);
    assert.equal(error.kind, "corrupt");
    return true;
  });
  assert.deepEqual(await readFile(f.pointer), before);
});

test("pending pointer write is bounded even for an oversized allowed URL field", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.pointer);
  await assert.rejects(() => f.store.begin(source, {
    pointerToken: f.pending.pointerToken,
    proposalHeadId: head,
    admittedAcquisition: { ...capture(), url: `https://example.invalid/${"x".repeat(FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES)}` },
  }, async () => head));
  assert.ok((await readFile(f.pointer)).equals(before), "a rejected oversize pending write cannot poison existing state");
});

test("completed receipt must agree with durable pointer prior acquisition baseline", async (t) => {
  const f = await fixture(t);
  await f.store.finalize(f.pending, completion(), async () => next);
  const pointer: { baseline: { admittedAcquisition: { snapshotRef: string } } } = JSON.parse(await readFile(f.pointer, "utf8"));
  pointer.baseline.admittedAcquisition.snapshotRef = "different-admitted-prior";
  await writeFile(f.pointer, JSON.stringify(pointer));
  assert.equal((await f.store.readCurrent(source, async () => next)).kind, "corrupt");
});
