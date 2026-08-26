import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FieldworkSourceCheckReceiptStore } from "../src/source-check-receipts.js";

test("a later pending source-check generation prevents an older completion becoming current", async () => {
  const store = new FieldworkSourceCheckReceiptStore(await mkdtemp(join(tmpdir(), "fieldwork-source-check-receipts-")));
  const head = "a".repeat(64);
  const first = await store.begin("source-a", head, "2026-08-26T10:00:00.000Z");
  const second = await store.begin("source-a", head, "2026-08-26T10:01:00.000Z");
  assert.equal(await store.finalize(first, { outcome: "changed", resultProposalHeadId: "old-head" }), false);
  assert.equal(await store.readCurrent("source-a"), null, "pending never falls back to an old current receipt");
  assert.equal(await store.finalize(second, { outcome: "unchanged-304", priorProposalHeadId: head, resultProposalHeadId: head, capture: { sourceId: "source-a", url: "https://example.invalid/a", fetchedAt: "2026-08-26T10:01:00.000Z", bodyHash: "a".repeat(64), integrity: "body-and-identity" } }), true);
  const current = await store.readCurrent("source-a", head);
  assert.equal(current?.generation, 2);
  assert.equal(current?.resultProposalHeadId, head);
  assert.doesNotMatch(JSON.stringify(current), /secret-body|headers|warning|credential|\/Users\//i);
});

test("receipt reads fail closed on corrupt pointer state and never rewrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldwork-source-check-corrupt-"));
  const store = new FieldworkSourceCheckReceiptStore(root);
  const head = "b".repeat(64);
  await store.begin("source-b", head, "2026-08-26T10:00:00.000Z");
  const [directory] = await readdir(root);
  const pointer = join(root, directory!, "pointer.json");
  await writeFile(pointer, "{", "utf8");
  await assert.rejects(() => store.begin("source-b", head, "2026-08-26T10:01:00.000Z"));
  assert.equal(await (await import("node:fs/promises")).readFile(pointer, "utf8"), "{");
});
