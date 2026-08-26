import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
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

test("a real public Forage exact reference beyond the former internal cap starts a receipt generation", async () => {
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
});

test("a newer pending generation fences an old completion and changed receipts bind the resulting head", async () => {
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
});

test("corrupt pointers and source-directory symlinks fail closed without private paths", async () => {
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
});
