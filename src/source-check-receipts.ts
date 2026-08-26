import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SourceHeadWitness } from "@kontourai/forage";
import type { ProposalHeadWitnessV1 } from "@kontourai/lookout";
import { FIELDWORK_CAPTURE_REF_MAX_CHARS, FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES } from "./fieldwork-limits.js";
import { assertPortableOutput } from "./run-store.js";

const MAX = FIELDWORK_SOURCE_CHECK_RECORD_MAX_BYTES;
const HASH = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^receipt-([1-9][0-9]*)-([a-f0-9]{64})\.json$/;
type Failure =
  | "missing"
  | "pending"
  | "superseded"
  | "busy"
  | "corrupt"
  | "unavailable";
export type Outcome =
  | "unchanged-304"
  | "unchanged-hash"
  | "changed"
  | "error"
  | "extraction-failure";
export interface Capture {
  readonly sourceId: string;
  readonly snapshotRef: string;
  readonly url: string;
  readonly bodyHash: string;
  readonly fetchedAt: string;
  readonly snapshotDigest?: string;
  readonly integrity: "snapshot-envelope" | "body-and-identity";
}
export interface Receipt {
  readonly version: 1;
  readonly sourceId: string;
  readonly generation: number;
  readonly checkedAt: string;
  readonly outcome: Outcome;
  readonly priorProposalHeadId: string;
  readonly resultProposalHeadId: string;
  readonly priorCapture: Capture;
  readonly currentCapture: Capture;
}
/** Private v2 receipt: owner witnesses are intentionally never exported by Fieldwork. */
export interface ReceiptV2 extends Omit<Receipt, "version"> {
  readonly version: 2;
  readonly acquisitionHead: SourceHeadWitness;
  readonly proposalHead: ProposalHeadWitnessV1;
  /** The verified Lookout head's actual proposal snapshot, not an acquisition alias. */
  readonly proposalHeadSnapshotRef: string;
}
export type StoredReceipt = Receipt | ReceiptV2;
type ReceiptCompletion =
  | Omit<Receipt, "version" | "sourceId" | "generation">
  | Omit<ReceiptV2, "version" | "sourceId" | "generation">;
interface PhysicalIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly ctimeNs: string;
  readonly size: string;
}
export interface CurrentWitness {
  readonly kind: "fieldwork.source-check-receipt-witness/v1";
  readonly sourceId: string;
  readonly generation: number;
  readonly receiptDigest: string;
  readonly receiptName: string;
  readonly pointerDigest: string;
  readonly root: PhysicalIdentity;
  readonly source: PhysicalIdentity;
  readonly pointer: PhysicalIdentity;
  readonly receipt: PhysicalIdentity;
  /** Opaque binding of immutable bytes, pointer bytes, and opened identities. */
  readonly token: string;
}
export interface Baseline {
  readonly pointerToken: string | null;
  readonly proposalHeadId: string;
  readonly admittedAcquisition: Capture;
}
export interface Pending {
  readonly sourceId: string;
  readonly generation: number;
  readonly pointerToken: string;
  readonly baseline: Baseline;
}
export type Result = { readonly kind: Failure } | {
  readonly kind: "available";
  readonly receipt: StoredReceipt;
};
export type CurrentReadResult = { readonly kind: Failure } | {
  readonly kind: "available";
  readonly receipt: ReceiptV2;
  readonly witness: CurrentWitness;
} | { readonly kind: "legacy" };
export type CurrentWitnessComparison = { readonly kind: "matches" | Failure };
export type ReadHead = () => Promise<string | null>;
export interface SourceCheckStorageHooks {
  afterReadOpen?(kind: "pointer" | "receipt" | "lock"): Promise<void>;
  afterReadStat?(kind: "pointer" | "receipt" | "lock"): Promise<void>;
  beforeImmutableLink?(): Promise<void>;
  beforeLockLink?(): Promise<void>;
  /** Test-only crash boundary after the completed pointer is durable. */
  afterPointerPublication?(): Promise<void>;
}
interface Pointer {
  version: 1;
  sourceId: string;
  generation: number;
  state: "pending" | "current" | "failed";
  token: string;
  baseline: Baseline;
  receipt?: string;
  receiptDigest?: string;
}

export class FieldworkSourceCheckReceiptStore {
  public constructor(
    private readonly root: string,
    private readonly hooks: SourceCheckStorageHooks = {},
  ) {}
  public async currentPointerToken(sourceId: string): Promise<string | null> {
    try {
      validId(sourceId);
      return (await this.pointer(sourceId, true))?.token ?? null;
    } catch (e) {
      throw typed(e);
    }
  }
  public async begin(
    sourceId: string,
    value: Baseline,
    readHead: ReadHead,
  ): Promise<Pending> {
    try {
      const baseline = copy(value);
      validBaseline(sourceId, baseline);
      return await this.lock(sourceId, async () => {
        const old = await this.pointer(sourceId, true);
        if (
          (old?.token ?? null) !== baseline.pointerToken ||
          await checkedHead(readHead) !== baseline.proposalHeadId
        ) throw new StoreError("superseded");
        const generation = (old?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) throw new StoreError("corrupt");
        const pointer: Pointer = {
          version: 1,
          sourceId,
          generation,
          state: "pending",
          token: randomUUID(),
          baseline,
        };
        await this.replace(this.pointerPath(sourceId), pointer);
        if (
          await checkedHead(readHead) !== baseline.proposalHeadId ||
          !samePointer(await this.pointer(sourceId, false), pointer)
        ) throw new StoreError("superseded");
        return copy({
          sourceId,
          generation,
          pointerToken: pointer.token,
          baseline,
        });
      });
    } catch (e) {
      throw typed(e);
    }
  }
  public async finalize(
    inputPending: Pending,
    input: ReceiptCompletion,
    readHead: ReadHead,
  ): Promise<Result> {
    const pending = copy(inputPending);
    const complete = copy(input);
    try {
      validPending(pending);
      const receipt: StoredReceipt = {
        version: isV2Completion(complete) ? 2 : 1,
        sourceId: pending.sourceId,
        generation: pending.generation,
        ...complete,
      } as StoredReceipt;
      validReceipt(receipt);
      return await this.lock(pending.sourceId, async () => {
        const pointer = await this.pointer(pending.sourceId, false);
        if (
          !pointer || pointer.state !== "pending" ||
          pointer.generation !== pending.generation ||
          pointer.token !== pending.pointerToken ||
          !same(pointer.baseline, pending.baseline)
        ) return { kind: "superseded" };
        if (
          receipt.priorProposalHeadId !== pointer.baseline.proposalHeadId ||
          !same(receipt.priorCapture, pointer.baseline.admittedAcquisition)
        ) return { kind: "superseded" };
        if (await checkedHead(readHead) !== receipt.resultProposalHeadId) {
          return { kind: "unavailable" };
        }
        const bytes = Buffer.from(JSON.stringify(receipt));
        if (bytes.length > MAX) throw new StoreError("corrupt");
        const digest = sha(bytes),
          name = `receipt-${receipt.generation}-${digest}.json`;
        await this.immutable(join(this.dir(pending.sourceId), name), bytes);
        // The immutable write is intentionally between the two owner witness
        // comparisons.  Pointer integrity is rechecked here without causing a
        // third owner comparison; the post-publication compare below is the
        // completion as-of fence.
        if (!samePointer(await this.pointer(pending.sourceId, false), pointer)) return { kind: "unavailable" };
        const published: Pointer = {
          ...pointer,
          state: receipt.outcome === "error" ||
              receipt.outcome === "extraction-failure"
            ? "failed"
            : "current",
          receipt: name,
          receiptDigest: digest,
        };
        await this.replace(this.pointerPath(pending.sourceId), published);
        await this.hooks.afterPointerPublication?.();
        if (await checkedHead(readHead) !== receipt.resultProposalHeadId ||
          !samePointer(await this.pointer(pending.sourceId, false), published)) return { kind: "unavailable" };
        return { kind: "available", receipt };
      });
    } catch (e) {
      return failed(e);
    }
  }
  public async readCurrent(
    sourceId: string,
    readHead: ReadHead,
  ): Promise<Result> {
    try {
      validId(sourceId);
      const pointer = await this.pointer(sourceId, true);
      if (!pointer) return { kind: "missing" };
      if (pointer.state === "pending") return { kind: "pending" };
      if (
        pointer.state !== "current" || !pointer.receipt ||
        !pointer.receiptDigest
      ) return { kind: "unavailable" };
      const observed = await checkedHead(readHead);
      const receipt = await this.receipt(sourceId, pointer);
      if (
        receipt.priorProposalHeadId !== pointer.baseline.proposalHeadId ||
        !same(receipt.priorCapture, pointer.baseline.admittedAcquisition)
      ) throw new StoreError("corrupt");
      if (
        observed !== receipt.resultProposalHeadId ||
        await checkedHead(readHead) !== observed ||
        !samePointer(await this.pointer(sourceId, false), pointer)
      ) return { kind: "unavailable" };
      return { kind: "available", receipt };
    } catch (e) {
      return failed(e);
    }
  }
  /** Metadata-only v2 read: it never locks, repairs, creates, or calls an owner. */
  public async readCurrentWithWitness(sourceId: string): Promise<CurrentReadResult> {
    try {
      validId(sourceId);
      const before = await this.readDirectoryIdentities(sourceId);
      const pointerFile = await this.readDetailed(this.pointerPath(sourceId), "pointer");
      const pointer = JSON.parse(pointerFile.bytes.toString());
      validPointer(pointer, sourceId);
      if (pointer.state === "pending") return { kind: "pending" };
      if (pointer.state !== "current" || !pointer.receipt || !pointer.receiptDigest) return { kind: "unavailable" };
      const receiptFile = await this.readDetailed(join(this.dir(sourceId), pointer.receipt), "receipt");
      if (sha(receiptFile.bytes) !== pointer.receiptDigest) throw new StoreError("corrupt");
      let receipt: unknown;
      try { receipt = JSON.parse(receiptFile.bytes.toString()); } catch { throw new StoreError("corrupt"); }
      validReceipt(receipt);
      // A v1 receipt is retained for compatibility/history, but never proves
      // currentness.  Callers may begin a fresh v2 check from owner heads.
      if (!isReceiptV2(receipt)) return { kind: "legacy" };
      const match = NAME.exec(pointer.receipt);
      if (!match || Number(match[1]) !== pointer.generation || match[2] !== pointer.receiptDigest ||
        receipt.generation !== pointer.generation || receipt.sourceId !== sourceId) throw new StoreError("corrupt");
      const after = await this.readDirectoryIdentities(sourceId);
      if (!sameIdentity(before.root, after.root) || !sameIdentity(before.source, after.source)) return { kind: "unavailable" };
      const unsigned: Omit<CurrentWitness, "token"> = {
        kind: "fieldwork.source-check-receipt-witness/v1", sourceId,
        generation: pointer.generation, receiptDigest: pointer.receiptDigest,
        receiptName: pointer.receipt, pointerDigest: sha(pointerFile.bytes),
        root: before.root, source: before.source, pointer: pointerFile.identity,
        receipt: receiptFile.identity,
      };
      const witness = { ...unsigned, token: witnessToken(unsigned) };
      return { kind: "available", receipt, witness };
    } catch (e) {
      if (code(e) === "ENOENT") return { kind: "missing" };
      return { kind: typed(e).kind };
    }
  }
  /** Compare a private local witness without reading either owner or writing storage. */
  public async compareCurrentWitness(witness: CurrentWitness): Promise<CurrentWitnessComparison> {
    if (!validCurrentWitness(witness)) return { kind: "corrupt" };
    const current = await this.readCurrentWithWitness(witness.sourceId);
    if (current.kind !== "available") return { kind: current.kind === "legacy" ? "unavailable" : current.kind };
    return current.witness.token === witness.token ? { kind: "matches" } : { kind: "superseded" };
  }
  private dir(sourceId: string) {
    return join(resolve(this.root), sha(Buffer.from(sourceId)));
  }
  private pointerPath(sourceId: string) {
    return join(this.dir(sourceId), "pointer.json");
  }
  private async ensure(sourceId: string) {
    const root = resolve(this.root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertDirectory(root);
    const dir = this.dir(sourceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await assertDirectory(dir);
    return dir;
  }
  private async pointer(
    sourceId: string,
    absent: boolean,
  ): Promise<Pointer | null> {
    try {
      await this.readDirectories(sourceId);
      const pointer = JSON.parse(
        (await this.read(this.pointerPath(sourceId), "pointer")).toString(),
      );
      validPointer(pointer, sourceId);
      return pointer;
    } catch (e) {
      if (absent && code(e) === "ENOENT") return null;
      throw e;
    }
  }
  private async readDirectories(sourceId: string) {
    await assertDirectory(resolve(this.root));
    await assertDirectory(this.dir(sourceId));
  }
  private async receipt(sourceId: string, pointer: Pointer): Promise<StoredReceipt> {
    if (
      !pointer.receipt || !pointer.receiptDigest || !NAME.test(pointer.receipt)
    ) throw new StoreError("corrupt");
    const bytes = await this.read(
      join(this.dir(sourceId), pointer.receipt),
      "receipt",
    );
    if (sha(bytes) !== pointer.receiptDigest) throw new StoreError("corrupt");
    let receipt: unknown;
    try {
      receipt = JSON.parse(bytes.toString());
    } catch {
      throw new StoreError("corrupt");
    }
    validReceipt(receipt);
    const match = NAME.exec(pointer.receipt);
    if (
      !match || Number(match[1]) !== pointer.generation ||
      match[2] !== pointer.receiptDigest ||
      (receipt as StoredReceipt).generation !== pointer.generation ||
      (receipt as StoredReceipt).sourceId !== sourceId
    ) throw new StoreError("corrupt");
    return receipt as StoredReceipt;
  }
  private async readDirectoryIdentities(sourceId: string) {
    return { root: await directoryIdentity(resolve(this.root)), source: await directoryIdentity(this.dir(sourceId)) };
  }
  private async read(
    path: string,
    kind: "pointer" | "receipt" | "lock",
  ): Promise<Buffer> {
    return (await this.readDetailed(path, kind)).bytes;
  }
  private async readDetailed(
    path: string,
    kind: "pointer" | "receipt" | "lock",
  ): Promise<{ bytes: Buffer; identity: PhysicalIdentity }> {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await this.hooks.afterReadOpen?.(kind);
      const before = await handle.stat();
      await this.hooks.afterReadStat?.(kind);
      if (!before.isFile() || before.size > MAX) {
        throw new StoreError("corrupt");
      }
      const out = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await handle.read(out, 0, out.length, 0);
      const after = await handle.stat();
      const named = await lstat(path);
      if (
        bytesRead > MAX || bytesRead > before.size ||
        after.size !== before.size || named.isSymbolicLink() ||
        !sameFile(before, after) || !sameFile(before, named)
      ) throw new StoreError("corrupt");
      return { bytes: out.subarray(0, bytesRead), identity: identity(named) };
    } finally {
      await handle.close();
    }
  }
  private async replace(path: string, value: Pointer) {
    await this.ensure(value.sourceId);
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX) throw new StoreError("corrupt");
    const temp = `${path}.${randomUUID()}.pending`;
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }
  private async immutable(path: string, bytes: Buffer) {
    await assertDirectory(path.slice(0, path.lastIndexOf("/")));
    const temp = `${path}.${randomUUID()}.pending`;
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.hooks.beforeImmutableLink?.();
      await link(temp, path);
    } catch (e) {
      if (code(e) !== "EEXIST") throw e;
      const old = await this.read(path, "receipt");
      if (!old.equals(bytes)) throw new StoreError("corrupt");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  private async lock<T>(sourceId: string, body: () => Promise<T>): Promise<T> {
    const path = join(await this.ensure(sourceId), ".lock");
    for (let attempt = 0; attempt < 5; attempt++) {
      const temp = `${path}.${randomUUID()}.pending`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        );
        await handle.sync();
        await this.hooks.beforeLockLink?.();
        try {
          await link(temp, path);
        } catch (e) {
          if (code(e) !== "EEXIST") throw e;
          await recover(path, this);
          continue;
        }
        const owner = await handle.stat();
        try {
          return await body();
        } finally {
          await handle.close();
          handle = undefined;
          await unlinkOwned(path, owner);
        }
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
      }
    }
    throw new StoreError("busy");
  }
}
class StoreError extends Error {
  public constructor(readonly kind: Failure) {
    super(kind);
  }
}
function code(e: unknown) {
  return e && typeof e === "object" && "code" in e
    ? (e as NodeJS.ErrnoException).code
    : undefined;
}
function typed(e: unknown) {
  return e instanceof StoreError ? e : new StoreError(
    code(e) === "EACCES" || code(e) === "EPERM" ? "unavailable" : "corrupt",
  );
}
function failed(e: unknown): Result {
  return { kind: typed(e).kind };
}
function checkedHead(read: ReadHead) {
  return read().catch(() => {
    throw new StoreError("unavailable");
  });
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function sha(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function samePointer(a: Pointer | null, b: Pointer) {
  return a !== null && same(a, b);
}
function sameFile(
  a: Pick<Stats, "dev" | "ino">,
  b: Pick<Stats, "dev" | "ino">,
) {
  return a.dev === b.dev && a.ino === b.ino;
}
function identity(stat: Pick<Stats, "dev" | "ino" | "ctimeMs" | "size">): PhysicalIdentity {
  return {
    dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(Math.trunc(stat.ctimeMs * 1_000_000)), size: String(stat.size),
  };
}
function sameIdentity(a: PhysicalIdentity, b: PhysicalIdentity) {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.size === b.size;
}
async function directoryIdentity(path: string): Promise<PhysicalIdentity> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StoreError("corrupt");
  return identity(stat);
}
function witnessToken(value: Omit<CurrentWitness, "token">) {
  return sha(Buffer.from(JSON.stringify(value)));
}
function validCurrentWitness(value: unknown): value is CurrentWitness {
  if (!exact(value, ["kind", "sourceId", "generation", "receiptDigest", "receiptName", "pointerDigest", "root", "source", "pointer", "receipt", "token"])) return false;
  const w = value as CurrentWitness;
  try { validId(w.sourceId); } catch { return false; }
  return w.kind === "fieldwork.source-check-receipt-witness/v1" &&
    Number.isSafeInteger(w.generation) && w.generation > 0 && HASH.test(w.receiptDigest) && HASH.test(w.pointerDigest) &&
    typeof w.receiptName === "string" && NAME.test(w.receiptName) && typeof w.token === "string" && HASH.test(w.token) &&
    [w.root, w.source, w.pointer, w.receipt].every((item) =>
      !!item && [item.dev, item.ino, item.ctimeNs, item.size].every((part) => typeof part === "string" && /^[0-9]+$/.test(part)));
}
async function assertDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StoreError("corrupt");
  }
}
function exact(value: unknown, allowed: string[]) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}
function validId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)
  ) throw new StoreError("corrupt");
}
function validCapture(value: unknown, sourceId: string) {
  if (
    !exact(value, [
      "sourceId",
      "snapshotRef",
      "url",
      "bodyHash",
      "fetchedAt",
      "snapshotDigest",
      "integrity",
    ])
  ) throw new StoreError("corrupt");
  const c = value as Capture;
  let url: URL;
  try {
    url = new URL(c.url);
  } catch {
    throw new StoreError("corrupt");
  }
  if (
    c.sourceId !== sourceId || typeof c.snapshotRef !== "string" ||
    c.snapshotRef.length === 0 ||
    c.snapshotRef.length > FIELDWORK_CAPTURE_REF_MAX_CHARS ||
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password || !HASH.test(c.bodyHash) || typeof c.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(c.fetchedAt)) ||
    !["snapshot-envelope", "body-and-identity"].includes(c.integrity) ||
    (c.integrity === "snapshot-envelope"
      ? !HASH.test(c.snapshotDigest ?? "")
      : c.snapshotDigest !== undefined)
  ) throw new StoreError("corrupt");
}
function validBaseline(source: string, value: unknown) {
  if (
    !exact(value, ["pointerToken", "proposalHeadId", "admittedAcquisition"])
  ) throw new StoreError("corrupt");
  const b = value as Baseline;
  validId(source);
  if (
    (b.pointerToken !== null &&
      (typeof b.pointerToken !== "string" || !UUID.test(b.pointerToken))) ||
    !HASH.test(b.proposalHeadId)
  ) throw new StoreError("corrupt");
  validCapture(b.admittedAcquisition, source);
  assertPortableOutput(b.admittedAcquisition);
}
function validPending(value: unknown) {
  if (!exact(value, ["sourceId", "generation", "pointerToken", "baseline"])) {
    throw new StoreError("corrupt");
  }
  const p = value as Pending;
  validBaseline(p.sourceId, p.baseline);
  if (
    !Number.isSafeInteger(p.generation) || p.generation < 1 ||
    !UUID.test(p.pointerToken)
  ) throw new StoreError("corrupt");
}
function validPointer(value: unknown, source: string) {
  if (
    !exact(value, [
      "version",
      "sourceId",
      "generation",
      "state",
      "token",
      "baseline",
      "receipt",
      "receiptDigest",
    ])
  ) throw new StoreError("corrupt");
  const p = value as Pointer;
  if (
    p.version !== 1 || p.sourceId !== source ||
    !Number.isSafeInteger(p.generation) || p.generation < 1 ||
    !["pending", "current", "failed"].includes(p.state) || !UUID.test(p.token)
  ) throw new StoreError("corrupt");
  validBaseline(source, p.baseline);
  if (
    (p.state === "current" &&
      (!p.receipt || !p.receiptDigest || !HASH.test(p.receiptDigest))) ||
    (p.receipt !== undefined && typeof p.receipt !== "string")
  ) throw new StoreError("corrupt");
}
function validReceipt(value: unknown) {
  if (
    !exact(value, [
      "version",
      "sourceId",
      "generation",
      "checkedAt",
      "outcome",
      "priorProposalHeadId",
      "resultProposalHeadId",
      "priorCapture",
      "currentCapture",
      "acquisitionHead",
      "proposalHead",
      "proposalHeadSnapshotRef",
    ])
  ) throw new StoreError("corrupt");
  const r = value as StoredReceipt;
  if (
    (r.version !== 1 && r.version !== 2) || !Number.isSafeInteger(r.generation) ||
    r.generation < 1 ||
    ![
      "unchanged-304",
      "unchanged-hash",
      "changed",
      "error",
      "extraction-failure",
    ].includes(r.outcome) || typeof r.checkedAt !== "string" ||
    Number.isNaN(Date.parse(r.checkedAt)) ||
    !HASH.test(r.priorProposalHeadId) || !HASH.test(r.resultProposalHeadId)
  ) throw new StoreError("corrupt");
  validId(r.sourceId);
  validCapture(r.priorCapture, r.sourceId);
  validCapture(r.currentCapture, r.sourceId);
  if (r.version === 2) validV2Receipt(r);
  if (r.version === 1 && ("acquisitionHead" in r || "proposalHead" in r || "proposalHeadSnapshotRef" in r)) throw new StoreError("corrupt");
  if (
    (r.outcome === "changed" &&
      r.resultProposalHeadId === r.priorProposalHeadId) ||
    (r.outcome === "unchanged-304" &&
      (r.resultProposalHeadId !== r.priorProposalHeadId ||
        !same(r.priorCapture, r.currentCapture))) ||
    (r.outcome === "unchanged-hash" &&
      (r.resultProposalHeadId !== r.priorProposalHeadId ||
        r.priorCapture.bodyHash !== r.currentCapture.bodyHash))
  ) throw new StoreError("corrupt");
  assertPortableOutput(r);
}
function isV2Completion(value: ReceiptCompletion): value is Omit<ReceiptV2, "version" | "sourceId" | "generation"> {
  return "acquisitionHead" in value || "proposalHead" in value || "proposalHeadSnapshotRef" in value;
}
function isReceiptV2(value: unknown): value is ReceiptV2 {
  return !!value && typeof value === "object" && (value as { version?: unknown }).version === 2;
}
function validV2Receipt(receipt: ReceiptV2) {
  if (!exact(receipt, ["version", "sourceId", "generation", "checkedAt", "outcome", "priorProposalHeadId", "resultProposalHeadId", "priorCapture", "currentCapture", "acquisitionHead", "proposalHead", "proposalHeadSnapshotRef"])) throw new StoreError("corrupt");
  const acquisition = receipt.acquisitionHead;
  const proposal = receipt.proposalHead;
  if (!acquisition || acquisition.format !== "forage.source-head-witness/v1" || acquisition.sourceId !== receipt.sourceId ||
    !acquisition.headSnapshotRef || acquisition.headSnapshotRef.sourceId !== receipt.sourceId ||
    typeof acquisition.token !== "string" || acquisition.token.length < 1 || acquisition.token.length > FIELDWORK_CAPTURE_REF_MAX_CHARS ||
    !sameHeadCapture(receipt.currentCapture, acquisition.headSnapshotRef) ||
    !proposal || proposal.kind !== "lookout.proposal-head-witness/v1" || proposal.version !== 1 || proposal.sourceId !== receipt.sourceId ||
    proposal.observationId !== receipt.resultProposalHeadId || typeof proposal.token !== "string" || proposal.token.length < 1 || proposal.token.length > FIELDWORK_CAPTURE_REF_MAX_CHARS ||
    typeof receipt.proposalHeadSnapshotRef !== "string" || receipt.proposalHeadSnapshotRef.length < 1 || receipt.proposalHeadSnapshotRef.length > FIELDWORK_CAPTURE_REF_MAX_CHARS) throw new StoreError("corrupt");
}
function sameHeadCapture(capture: Capture, head: SourceHeadWitness["headSnapshotRef"]) {
  return capture.sourceId === head.sourceId && capture.url === head.url && capture.bodyHash === head.bodyHash &&
    capture.fetchedAt === head.fetchedAt && capture.snapshotDigest === head.snapshotDigest;
}
async function unlinkOwned(path: string, owner: Pick<Stats, "dev" | "ino">) {
  try {
    const current = await lstat(path);
    if (
      current.isFile() && !current.isSymbolicLink() && sameFile(current, owner)
    ) await unlink(path);
  } catch (e) {
    if (code(e) !== "ENOENT") throw e;
  }
}
async function recover(path: string, store: FieldworkSourceCheckReceiptStore) {
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() || stat.isSymbolicLink() || stat.size > 512 ||
      Date.now() - stat.mtimeMs < 60_000
    ) return;
    let raw: Buffer;
    try {
      raw = await (store as any).read(path, "lock");
    } catch {
      return;
    }
    try {
      process.kill(JSON.parse(raw.toString()).pid, 0);
    } catch (e) {
      if (code(e) === "ESRCH" || e instanceof SyntaxError) {
        await unlinkOwned(path, stat);
      }
    }
  } catch { /* ambiguous locks remain busy */ }
}
