import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSnapshotSourceRef, parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import {
  FieldworkSourceCheckReceiptStore,
  type Baseline,
  type Capture,
} from "../src/source-check-receipts.js";

const headA = "a".repeat(64),
  headB = "b".repeat(64);
const capture = (
  sourceId = "source-a",
  snapshotRef = "snapshot-a",
): Capture => ({
  sourceId,
  snapshotRef,
  url: "https://example.invalid/a",
  fetchedAt: "2026-08-26T10:00:00.000Z",
  bodyHash: "c".repeat(64),
  integrity: "body-and-identity",
});
async function begin(
  store: FieldworkSourceCheckReceiptStore,
  sourceId = "source-a",
  head = headA,
) {
  const baseline: Baseline = {
    pointerToken: await store.currentPointerToken(sourceId),
    proposalHeadId: head,
    admittedAcquisition: capture(sourceId),
  };
  return store.begin(sourceId, baseline, async () => head);
}

test("a real public Forage exact reference beyond the former internal cap starts a receipt generation and v1 reader rejects mismatched records", async () => {
  const sourceId = "source-a";
  const body = "fixture";
  const snapshot = {
    sourceId,
    url: `https://example.test/${"a".repeat(7_943)}`,
    status: 200,
    fetchedAt: "2026-08-26T10:00:00.000Z",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": "text/plain" },
  };
  const snapshotRef = buildSnapshotSourceRef(snapshot);
  const parsed = parseSnapshotSourceRef(snapshotRef);
  assert.ok(parsed);
  assert.equal(snapshotRef.length, 8_192);
  const store = new FieldworkSourceCheckReceiptStore(
    await mkdtemp(join(tmpdir(), "fieldwork-source-check-long-ref-")),
  );

  const admittedAcquisition: Capture = {
    sourceId,
    snapshotRef,
    url: parsed.url,
    bodyHash: parsed.bodyHash,
    fetchedAt: parsed.fetchedAt,
    snapshotDigest: parsed.snapshotDigest,
    integrity: "snapshot-envelope",
  };
  const pending = await store.begin(sourceId, {
    pointerToken: null,
    proposalHeadId: headA,
    admittedAcquisition,
  }, async () => headA);

  assert.equal(pending.generation, 1);
  const finalized = await store.finalize(pending, {
    checkedAt: "2026-08-26T10:01:00.000Z",
    outcome: "unchanged-hash",
    priorProposalHeadId: headA,
    resultProposalHeadId: headA,
    priorCapture: admittedAcquisition,
    currentCapture: admittedAcquisition,
  }, async () => headA);
  assert.equal(finalized.kind, "available");
  // Existing v1 bytes remain readable through the compatibility API, but lack
  // owner witnesses and cannot be promoted into the v2 currentness path.
  assert.deepEqual(await store.readCurrentWithWitness(sourceId), { kind: "legacy" });
  await assertReaderMismatches(1);
});

test("a newer pending generation fences an old completion, changed receipts bind the resulting head, and v2 reader rejects mismatched records", async () => {
  const store = new FieldworkSourceCheckReceiptStore(
    await mkdtemp(join(tmpdir(), "fieldwork-source-check-receipts-")),
  );
  const first = await begin(store);
  const second = await begin(store);
  const old = await store.finalize(
    first,
    {
      checkedAt: "2026-08-26T10:01:00.000Z",
      outcome: "changed",
      priorProposalHeadId: headA,
      resultProposalHeadId: headB,
      priorCapture: capture(),
      currentCapture: capture(),
    },
    async () => headB,
  );
  assert.equal(old.kind, "superseded");
  assert.equal(
    (await store.readCurrent("source-a", async () => headA)).kind,
    "pending",
  );
  const done = await store.finalize(
    second,
    {
      checkedAt: "2026-08-26T10:01:00.000Z",
      outcome: "changed",
      priorProposalHeadId: headA,
      resultProposalHeadId: headB,
      priorCapture: capture(),
      currentCapture: capture(),
    },
    async () => headB,
  );
  assert.equal(done.kind, "available");
  const current = await store.readCurrent("source-a", async () => headB);
  assert.equal(current.kind, "available");
  if (current.kind === "available")
    assert.equal(current.receipt.resultProposalHeadId, headB);
  await assertReaderMismatches(2);
});

test("corrupt pointers, dangling current receipts, and source-directory symlinks fail closed without private paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-source-check-corrupt-"));
  const store = new FieldworkSourceCheckReceiptStore(root);
  await begin(store);
  const [directory] = await readdir(root);
  const pointer = join(root, directory!, "pointer.json");
  await writeFile(pointer, "{");
  const result = await store.readCurrent("source-a", async () => headA);
  assert.deepEqual(result, { kind: "corrupt" });
  assert.doesNotMatch(
    JSON.stringify(result),
    /fieldwork-source-check-corrupt|\//i,
  );
  const outside = await mkdtemp(join(tmpdir(), "fieldwork-outside-"));
  const linkRoot = await mkdtemp(join(tmpdir(), "fieldwork-link-root-"));
  const sourceDir = createHash("sha256").update("source-a").digest("hex");
  await symlink(outside, join(linkRoot, sourceDir));
  const linked = new FieldworkSourceCheckReceiptStore(linkRoot);
  await assert.rejects(() =>
    linked.begin(
      "source-a",
      {
        pointerToken: null,
        proposalHeadId: headA,
        admittedAcquisition: capture(),
      },
      async () => headA,
    ),
  );
  await assertDanglingCurrentReceipt();
});

async function readerFixture(version: 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-source-check-reader-"));
  const store = new FieldworkSourceCheckReceiptStore(root);
  const prior: Capture = {
    ...capture(), snapshotRef: "capture-a", snapshotDigest: "d".repeat(64), integrity: "snapshot-envelope",
  };
  const current: Capture = {
    ...prior, snapshotRef: "capture-b", bodyHash: "e".repeat(64), fetchedAt: "2026-08-26T10:01:00.000Z", snapshotDigest: "f".repeat(64),
  };
  const pending = await store.begin("source-a", {
    pointerToken: null, proposalHeadId: headA, admittedAcquisition: prior,
  }, async () => headA);
  const common = {
    checkedAt: "2026-08-26T10:02:00.000Z", outcome: "changed" as const,
    priorProposalHeadId: headA, resultProposalHeadId: headB, priorCapture: prior, currentCapture: current,
  };
  const completed = await store.finalize(pending, version === 1 ? common : {
    ...common,
    acquisitionHead: {
      format: "forage.source-head-witness/v1" as const, sourceId: "source-a",
      headSnapshotRef: { sourceId: "source-a", url: current.url, bodyHash: current.bodyHash, fetchedAt: current.fetchedAt, snapshotDigest: current.snapshotDigest! },
      token: "1".repeat(64),
    },
    proposalHead: { kind: "lookout.proposal-head-witness/v1" as const, version: 1 as const, sourceId: "source-a", observationId: headB, token: "2".repeat(64) },
    proposalHeadSnapshotRef: current.snapshotRef,
  }, async () => headB);
  assert.equal(completed.kind, "available");
  const directory = join(root, createHash("sha256").update("source-a").digest("hex"));
  const [receipt] = (await readdir(directory)).filter((name) => name.startsWith("receipt-"));
  return { root, store, directory, pointer: join(directory, "pointer.json"), receipt: join(directory, receipt!) };
}

async function assertDanglingCurrentReceipt() {
  const f = await readerFixture(2);
  const current = await f.store.readCurrentWithWitness("source-a");
  assert.equal(current.kind, "available");
  assert.ok(current.kind === "available");
  await unlink(f.receipt);
  const read = await f.store.readCurrentWithWitness("source-a");
  assert.deepEqual(read, { kind: "corrupt" });
  const compared = await f.store.compareCurrentWitness(current.witness);
  assert.deepEqual(compared, { kind: "corrupt" });
  assert.doesNotMatch(JSON.stringify({ read, compared }), /fieldwork-source-check-reader|\//i);
}

async function assertReaderMismatches(version: 1 | 2) {
  for (const mutate of [
    (receipt: Record<string, unknown>) => { receipt.sourceId = "source-b"; },
    (receipt: Record<string, unknown>) => { receipt.generation = 2; },
    (receipt: Record<string, unknown>) => { receipt.priorProposalHeadId = headB; },
  ]) {
    const f = await readerFixture(version);
    const pointer = JSON.parse(await readFile(f.pointer, "utf8"));
    const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
    mutate(receipt);
    const bytes = Buffer.from(JSON.stringify(receipt));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const replacement = join(f.directory, `receipt-${pointer.generation}-${digest}.json`);
    await writeFile(replacement, bytes);
    await unlink(f.receipt);
    pointer.receipt = replacement.slice(f.directory.length + 1);
    pointer.receiptDigest = digest;
    await writeFile(f.pointer, JSON.stringify(pointer));
    const result = await f.store.readCurrentWithWitness("source-a");
    assert.deepEqual(result, { kind: "corrupt" });
    assert.doesNotMatch(JSON.stringify(result), /fieldwork-source-check-reader|\//i);
  }
}
