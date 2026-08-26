import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  FieldworkSourceCheckReceiptStore,
  type Receipt,
} from "../src/source-check-receipts.js";

const source = "source-a";
const head = "a".repeat(64);
const next = "b".repeat(64);
const checkedAt = "2026-08-26T10:01:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const capture = () => ({
  sourceId: source,
  snapshotRef: "capture-a",
  url: "https://example.invalid/a",
  bodyHash: "c".repeat(64),
  fetchedAt: "2026-08-26T10:00:00.000Z",
  integrity: "body-and-identity" as const,
});
const completion = () => ({
  checkedAt,
  outcome: "changed" as const,
  priorProposalHeadId: head,
  resultProposalHeadId: next,
  priorCapture: capture(),
  currentCapture: { ...capture(), snapshotRef: "capture-b", bodyHash: "d".repeat(64) },
});
async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-storage-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext) {
  const root = await temporary(t);
  const store = new FieldworkSourceCheckReceiptStore(root);
  const baseline = { pointerToken: null, proposalHeadId: head, admittedAcquisition: capture() };
  const pending = await store.begin(source, baseline, async () => head);
  const directory = join(root, hash(source));
  return { root, store, baseline, pending, directory, pointer: join(directory, "pointer.json") };
}
function typedFailure(kind: string) {
  return (error: unknown) => {
    assert.ok(error !== null && typeof error === "object" && "kind" in error);
    assert.equal(error.kind, kind);
    assert.ok(error instanceof Error);
    assert.equal(error.message, kind);
    assert.equal("cause" in error, false);
    assert.equal("path" in error, false);
    return true;
  };
}

test("begin freezes caller baseline before awaits and retains its acquisition authority", async (t) => {
  const f = await fixture(t);
  f.baseline.admittedAcquisition.snapshotRef = "substituted-after-begin";
  assert.equal(f.pending.baseline.admittedAcquisition.snapshotRef, "capture-a");
  const result = await f.store.finalize(f.pending, completion(), async () => next);
  assert.equal(result.kind, "available");
});

test("restart finalization cannot substitute the durable pending acquisition baseline", async (t) => {
  const f = await fixture(t);
  const substituted = { ...capture(), snapshotRef: "unadmitted-capture" };
  const forged = { ...f.pending, baseline: { ...f.pending.baseline, admittedAcquisition: substituted } };
  const result = await new FieldworkSourceCheckReceiptStore(f.root).finalize(forged, {
    ...completion(), priorCapture: substituted,
  }, async () => next);
  assert.equal(result.kind, "superseded");
  assert.equal((await f.store.readCurrent(source, async () => next)).kind, "pending");
});

test("begin snapshots acquisition before its first head callback", async (t) => {
  const store = new FieldworkSourceCheckReceiptStore(await temporary(t));
  const baseline = { pointerToken: null, proposalHeadId: head, admittedAcquisition: capture() };
  const pending = await store.begin(source, baseline, async () => {
    baseline.admittedAcquisition.snapshotRef = "mutated-during-begin";
    return head;
  });
  assert.equal(pending.baseline.admittedAcquisition.snapshotRef, "capture-a");
});

test("finalize freezes nested captures before the first head-read await", async (t) => {
  const f = await fixture(t);
  const input = completion();
  let calls = 0;
  const result = await f.store.finalize(f.pending, input, async () => {
    if (++calls === 1) input.currentCapture.snapshotRef = "injected-after-validation";
    return next;
  });
  assert.equal(result.kind, "available");
  const read = await f.store.readCurrent(source, async () => next);
  assert.equal(read.kind, "available");
  if (read.kind === "available") assert.equal(read.receipt.currentCapture.snapshotRef, "capture-b");
});

const invalidCompletions: Array<[string, () => Omit<Receipt, "version" | "sourceId" | "generation">]> = [
  ["unknown body field", () => ({ ...completion(), body: "arbitrary source text" })],
  ["credential URL userinfo", () => ({ ...completion(), currentCapture: { ...capture(), url: "https://user:password@example.invalid/a" } })],
  ["snapshot-envelope without digest", () => ({ ...completion(), currentCapture: { ...capture(), integrity: "snapshot-envelope" } })],
  ["legacy integrity with invented envelope digest", () => ({ ...completion(), currentCapture: { ...capture(), snapshotDigest: "e".repeat(64) } })],
  ["cross-source capture", () => ({ ...completion(), currentCapture: { ...capture(), sourceId: "another-source" } })],
  ["304 changing capture", () => ({ ...completion(), outcome: "unchanged-304", resultProposalHeadId: head })],
  ["unchanged hash with different body", () => ({ ...completion(), outcome: "unchanged-hash", resultProposalHeadId: head })],
  ["unchanged check advancing proposal head", () => ({ ...completion(), outcome: "unchanged-hash", currentCapture: capture() })],
];
for (const [name, make] of invalidCompletions) {
  test(`strict completion admission rejects ${name} before publishing`, async (t) => {
    const f = await fixture(t);
    const before = await readFile(f.pointer);
    const input = make();
    assert.equal((await f.store.finalize(f.pending, input, async () => input.resultProposalHeadId)).kind, "corrupt");
    assert.deepEqual(await readFile(f.pointer), before);
    assert.deepEqual((await readdir(f.directory)).filter((name) => name.startsWith("receipt-")), []);
  });
}

for (const target of ["root", "source"] as const) {
  test(`metadata read rejects ${target} directory symlink without writes`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.store.finalize(f.pending, completion(), async () => next)).kind, "available");
    const holder = await temporary(t);
    const alias = target === "root" ? join(holder, "alias") : holder;
    await symlink(target === "root" ? f.root : f.directory, target === "root" ? alias : join(holder, hash(source)));
    const before = await readdir(holder);
    assert.equal((await new FieldworkSourceCheckReceiptStore(alias).readCurrent(source, async () => next)).kind, "corrupt");
    assert.deepEqual(await readdir(holder), before);
  });
}

test("missing metadata read never creates a root", async (t) => {
  const absent = join(await temporary(t), "absent");
  assert.deepEqual(await new FieldworkSourceCheckReceiptStore(absent).readCurrent(source, async () => head), { kind: "missing" });
  await assert.rejects(() => lstat(absent), { code: "ENOENT" });
});

test("pointer unknown fields are corrupt and never treated as absence", async (t) => {
  const f = await fixture(t);
  const pointer: Record<string, unknown> = JSON.parse(await readFile(f.pointer, "utf8"));
  pointer.body = "unadmitted text";
  await writeFile(f.pointer, JSON.stringify(pointer));
  const before = await readFile(f.pointer);
  assert.equal((await f.store.readCurrent(source, async () => head)).kind, "corrupt");
  await assert.rejects(() => f.store.begin(source, { ...f.baseline, pointerToken: f.pending.pointerToken }, async () => head), typedFailure("corrupt"));
  assert.deepEqual(await readFile(f.pointer), before);
});

test("immutable target collision cannot overwrite corrupt existing bytes", async (t) => {
  const f = await fixture(t);
  const bytes = JSON.stringify({ version: 1, sourceId: source, generation: f.pending.generation, ...completion() });
  const target = join(f.directory, `receipt-${f.pending.generation}-${hash(bytes)}.json`);
  await writeFile(target, "");
  assert.equal((await f.store.finalize(f.pending, completion(), async () => next)).kind, "corrupt");
  assert.equal(await readFile(target, "utf8"), "");
  assert.equal((await f.store.readCurrent(source, async () => next)).kind, "pending");
});

test("final-component receipt symlink is rejected without following external metadata", async (t) => {
  const f = await fixture(t);
  await f.store.finalize(f.pending, completion(), async () => next);
  const names = (await readdir(f.directory)).filter((name) => /^receipt-.*\.json$/.test(name));
  assert.equal(names.length, 1);
  const target = join(f.directory, names[0]!);
  const outside = join(await temporary(t), "receipt.json");
  await writeFile(outside, await readFile(target));
  await unlink(target);
  await symlink(outside, target);
  assert.equal((await f.store.readCurrent(source, async () => next)).kind, "corrupt");
});

test("release does not unlink a replacement lock inode", async (t) => {
  const f = await fixture(t);
  const lock = join(f.directory, ".lock");
  const replacement = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
  let calls = 0;
  await f.store.finalize(f.pending, completion(), async () => {
    if (++calls === 1) { await unlink(lock); await writeFile(lock, replacement); }
    return next;
  });
  assert.equal(await readFile(lock, "utf8"), replacement);
});

test("oversized completion cannot publish success or change pending pointer", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.pointer);
  const input = { ...completion(), body: "x".repeat(20_000) };
  assert.equal((await f.store.finalize(f.pending, input, async () => next)).kind, "corrupt");
  assert.deepEqual(await readFile(f.pointer), before);
});

test("currentPointerToken normalizes malformed JSON without repairing it", async (t) => {
  const f = await fixture(t);
  await writeFile(f.pointer, "{");
  await assert.rejects(() => f.store.currentPointerToken(source), typedFailure("corrupt"));
  assert.equal(await readFile(f.pointer, "utf8"), "{");
});

test("filesystem EACCES is unavailable and path-free on token reads", async (t) => {
  const f = await fixture(t);
  await chmod(f.pointer, 0);
  try {
    await assert.rejects(() => readFile(f.pointer), { code: "EACCES" });
    await assert.rejects(() => f.store.currentPointerToken(source), typedFailure("unavailable"));
  } finally { await chmod(f.pointer, 0o600); }
});

test("a head provider throwing null returns unavailable rather than rejecting", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.finalize(f.pending, completion(), async () => { throw null; }), { kind: "unavailable" });
});

test("operation EEXIST never reruns a transaction body", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await f.store.finalize(f.pending, completion(), async () => {
    calls++;
    throw Object.assign(new Error("head unavailable"), { code: "EEXIST" });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: "unavailable" });
});

test("generation overflow leaves the last valid pointer untouched", async (t) => {
  const f = await fixture(t);
  const pointer: Record<string, unknown> = JSON.parse(await readFile(f.pointer, "utf8"));
  pointer.generation = Number.MAX_SAFE_INTEGER;
  await writeFile(f.pointer, JSON.stringify(pointer));
  const before = await readFile(f.pointer);
  await assert.rejects(() => f.store.begin(source, {
    pointerToken: f.pending.pointerToken, proposalHeadId: head, admittedAcquisition: capture(),
  }, async () => head), typedFailure("corrupt"));
  assert.deepEqual(await readFile(f.pointer), before);
});

test("finalize rechecks the exact published pointer after its last head await", async (t) => {
  const f = await fixture(t);
  const pendingBytes = await readFile(f.pointer);
  let calls = 0;
  const result = await f.store.finalize(f.pending, completion(), async () => {
    if (++calls === 3) await writeFile(f.pointer, pendingBytes);
    return next;
  });
  assert.equal(calls, 3, "exercise the post-publication head fence");
  assert.equal(result.kind, "unavailable");
});

for (const boundary of [1, 2, 3]) {
  test(`external head advance at finalize fence ${boundary} is unavailable`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const result = await f.store.finalize(f.pending, completion(), async () => ++calls >= boundary ? "f".repeat(64) : next);
    assert.equal(result.kind, "unavailable");
    assert.notEqual((await f.store.readCurrent(source, async () => "f".repeat(64))).kind, "available");
  });
}

test("deferred reader detects external head advancement during its first await", async (t) => {
  const f = await fixture(t);
  await f.store.finalize(f.pending, completion(), async () => next);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let actual = next;
  let calls = 0;
  const reading = f.store.readCurrent(source, async () => {
    const observed = actual;
    if (++calls === 1) { enter(); await released; }
    return observed;
  });
  await entered;
  actual = "f".repeat(64);
  release();
  assert.equal((await reading).kind, "unavailable");
});

function child(t: TestContext, root: string, mode: string, boundary = 0) {
  const processChild = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./helpers/source-check-process.ts", import.meta.url)), root, mode, String(boundary)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  processChild.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  processChild.on("message", (message: unknown) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => processChild.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); await exited; });
  const message = () => Promise.race([
    messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>((resolve) => waiters.push(resolve)),
    exited.then((result) => { throw new Error(`Child exited before IPC: ${JSON.stringify(result)} ${stderr}`); }),
  ]);
  return { processChild, message, exited };
}

test("a real competing process cannot publish an older pending generation", { timeout: 10_000 }, async (t) => {
  const root = await temporary(t);
  const c = child(t, root, "compete");
  assert.deepEqual(await c.message(), { phase: "pending" });
  const store = new FieldworkSourceCheckReceiptStore(root);
  await store.begin(source, { pointerToken: await store.currentPointerToken(source), proposalHeadId: head, admittedAcquisition: capture() }, async () => head);
  c.processChild.send("continue");
  assert.deepEqual(await c.message(), { phase: "result", result: { kind: "superseded" } });
  assert.deepEqual(await c.exited, { code: 0, signal: null });
  assert.equal((await store.readCurrent(source, async () => next)).kind, "pending");
});

test("live process lock stays owned while another source proceeds", { timeout: 10_000 }, async (t) => {
  const root = await temporary(t);
  const c = child(t, root, "crash-begin");
  assert.deepEqual(await c.message(), { phase: "begin-locked" });
  const lock = join(root, hash(source), ".lock");
  const before = await readFile(lock);
  const store = new FieldworkSourceCheckReceiptStore(root);
  await assert.rejects(() => store.begin(source, { pointerToken: null, proposalHeadId: head, admittedAcquisition: capture() }, async () => head), typedFailure("busy"));
  assert.deepEqual(await readFile(lock), before);
  const other = await store.begin("source-b", { pointerToken: null, proposalHeadId: head, admittedAcquisition: { ...capture(), sourceId: "source-b" } }, async () => head);
  assert.equal(other.sourceId, "source-b");
  c.processChild.kill("SIGKILL");
  assert.deepEqual(await c.exited, { code: null, signal: "SIGKILL" });
});

for (const phase of [0, 1, 2, 3]) {
  test(`SIGKILL restart at publication phase ${phase} retains conservative state and recovers dead lock`, { timeout: 10_000 }, async (t) => {
    const root = await temporary(t);
    const c = child(t, root, phase === 0 ? "crash-begin" : "crash-finalize", phase);
    assert.deepEqual(await c.message(), { phase: phase === 0 ? "begin-locked" : `finalize-${phase}` });
    c.processChild.kill("SIGKILL");
    assert.deepEqual(await c.exited, { code: null, signal: "SIGKILL" });
    const store = new FieldworkSourceCheckReceiptStore(root);
    const result = await store.readCurrent(source, async () => next);
    assert.equal(result.kind, phase === 0 ? "missing" : phase === 3 ? "available" : "pending");
    const directory = join(root, hash(source));
    const receipts = (await readdir(directory)).filter((name) => /^receipt-.*\.json$/.test(name));
    assert.equal(receipts.length, phase >= 2 ? 1 : 0);
    for (const name of receipts) {
      const bytes = await readFile(join(directory, name), "utf8");
      assert.ok(bytes.length > 0);
      assert.equal(name, `receipt-1-${hash(bytes)}.json`);
    }
    const aged = new Date(Date.now() - 120_000);
    await utimes(join(directory, ".lock"), aged, aged);
    const restartHead = phase === 3 ? next : head;
    const pending = await store.begin(source, { pointerToken: await store.currentPointerToken(source), proposalHeadId: restartHead, admittedAcquisition: phase === 3 ? completion().currentCapture : capture() }, async () => restartHead);
    assert.equal(pending.generation, phase === 0 ? 1 : 2);
  });
}
