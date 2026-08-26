/**
 * Fieldwork-owned, content-free acquisition check receipts.  This is not a
 * Lookout store: Lookout owns proposal continuity; this small store records
 * which authenticated acquisition attempt is the source's current witness.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type SourceCheckOutcome = "unchanged-304" | "unchanged-hash" | "changed" | "error" | "extraction-failure";
export interface SourceCheckReceiptV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly generation: number;
  readonly status: "pending" | "current" | "failed";
  readonly checkedAt: string;
  readonly outcome?: SourceCheckOutcome;
  readonly priorProposalHeadId?: string;
  readonly resultProposalHeadId?: string;
  readonly priorCaptureRef?: string;
  readonly currentCaptureRef?: string;
  readonly capture?: { readonly sourceId: string; readonly url: string; readonly fetchedAt: string; readonly bodyHash: string; readonly snapshotDigest?: string; readonly integrity: "snapshot-envelope" | "body-and-identity" };
}
interface Pointer { version: 1; sourceId: string; generation: number; receipt: string; status: SourceCheckReceiptV1["status"]; boundLookoutHeadId?: string }

export class FieldworkSourceCheckReceiptStore {
  constructor(private readonly root: string) {}
  async begin(sourceId: string, checkedAt: string): Promise<SourceCheckReceiptV1> {
    return this.lock(sourceId, async () => {
      const dir = this.dir(sourceId); await mkdir(dir, { recursive: true });
      const previous = await this.pointer(sourceId);
      const receipt: SourceCheckReceiptV1 = { version: 1, sourceId, generation: (previous?.generation ?? 0) + 1, status: "pending", checkedAt };
      const name = `${receipt.generation}-${randomUUID()}.json`;
      await this.write(join(dir, name), receipt);
      await this.write(join(dir, "pointer.json"), { version: 1, sourceId, generation: receipt.generation, receipt: name, status: "pending" } satisfies Pointer);
      return receipt;
    });
  }
  async finalize(receipt: SourceCheckReceiptV1, input: Omit<SourceCheckReceiptV1, "version" | "sourceId" | "generation" | "status" | "checkedAt">): Promise<boolean> {
    return this.lock(receipt.sourceId, async () => {
      const pointer = await this.pointer(receipt.sourceId);
      if (!pointer || pointer.generation !== receipt.generation || pointer.status !== "pending") return false;
      const completed: SourceCheckReceiptV1 = { ...receipt, ...input, status: input.outcome === "error" || input.outcome === "extraction-failure" ? "failed" : "current" };
      await this.write(join(this.dir(receipt.sourceId), pointer.receipt), completed);
      await this.write(join(this.dir(receipt.sourceId), "pointer.json"), { ...pointer, status: completed.status, ...(completed.resultProposalHeadId ? { boundLookoutHeadId: completed.resultProposalHeadId } : {}) });
      return true;
    });
  }
  async readCurrent(sourceId: string): Promise<SourceCheckReceiptV1 | null> {
    const pointer = await this.pointer(sourceId); if (!pointer || pointer.status !== "current") return null;
    try { const receipt = JSON.parse(await readFile(join(this.dir(sourceId), pointer.receipt), "utf8")) as SourceCheckReceiptV1;
      return receipt.version === 1 && receipt.sourceId === sourceId && receipt.generation === pointer.generation && receipt.status === "current" ? receipt : null;
    } catch { return null; }
  }
  private dir(sourceId: string) { return join(resolve(this.root), createHash("sha256").update(sourceId).digest("hex")); }
  private async pointer(sourceId: string): Promise<Pointer | null> { try { return JSON.parse(await readFile(join(this.dir(sourceId), "pointer.json"), "utf8")) as Pointer; } catch { return null; } }
  private async write(path: string, value: unknown): Promise<void> { const temp = `${path}.${randomUUID()}.pending`; await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temp, path); }
  private async lock<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const dir = this.dir(sourceId); await mkdir(dir, { recursive: true }); const lock = join(dir, ".lock");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { await mkdir(lock, { mode: 0o700 }); try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); } }
      catch (error: unknown) { if ((error as { code?: string }).code !== "EEXIST") throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    throw new Error("Source check receipt lock is unavailable");
  }
}
