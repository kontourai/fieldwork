import { FieldworkSourceCheckReceiptStore } from "../../src/source-check-receipts.js";

const [root, mode, boundaryText] = process.argv.slice(2);
if (!root || !mode) throw new Error("Missing child arguments");
const head = "a".repeat(64);
const next = "b".repeat(64);
const capture = {
  sourceId: "source-a",
  snapshotRef: "capture-a",
  url: "https://example.invalid/a",
  bodyHash: "c".repeat(64),
  fetchedAt: "2026-08-26T10:00:00.000Z",
  integrity: "body-and-identity" as const,
};
const park = async (phase: string): Promise<never> => {
  process.send?.({ phase });
  await new Promise(() => { process.on("message", () => undefined); });
  throw new Error("Unreachable");
};
const store = new FieldworkSourceCheckReceiptStore(root, {
  ...(mode === "crash-finalize" && Number(boundaryText) === 3
    ? { afterPointerPublication: () => park("finalize-3") }
    : {}),
});
const pending = await store.begin("source-a", {
  pointerToken: await store.currentPointerToken("source-a"),
  proposalHeadId: head,
  admittedAcquisition: capture,
}, async () => mode === "crash-begin" ? park("begin-locked") : head);

if (mode === "compete") {
  process.send?.({ phase: "pending" });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
}
let calls = 0;
const result = await store.finalize(pending, {
  checkedAt: "2026-08-26T10:01:00.000Z",
  outcome: "changed",
  priorProposalHeadId: head,
  resultProposalHeadId: next,
  priorCapture: capture,
  currentCapture: { ...capture, snapshotRef: "capture-b", bodyHash: "d".repeat(64) },
}, async () => {
  if (mode === "crash-finalize" && ++calls === Number(boundaryText)) {
    return park(`finalize-${calls}`);
  }
  return next;
});
process.send?.({ phase: "result", result });
process.disconnect?.();
