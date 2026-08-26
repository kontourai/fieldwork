import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertPortableOutput } from "./run-store.js";

const MAX = 16_384;
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
  readonly receipt: Receipt;
};
export type ReadHead = () => Promise<string | null>;
export interface SourceCheckStorageHooks {
  afterReadOpen?(kind: "pointer" | "receipt" | "lock"): Promise<void>;
  afterReadStat?(kind: "pointer" | "receipt" | "lock"): Promise<void>;
  beforeImmutableLink?(): Promise<void>;
  beforeLockLink?(): Promise<void>;
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
    const baseline = copy(value);
    validBaseline(sourceId, baseline);
    try {
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
    input: Omit<Receipt, "version" | "sourceId" | "generation">,
    readHead: ReadHead,
  ): Promise<Result> {
    const pending = copy(inputPending);
    const complete = copy(input);
    try {
      validPending(pending);
      const receipt: Receipt = {
        version: 1,
        sourceId: pending.sourceId,
        generation: pending.generation,
        ...complete,
      };
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
        if (
          await checkedHead(readHead) !== receipt.resultProposalHeadId ||
          !samePointer(await this.pointer(pending.sourceId, false), pointer)
        ) return { kind: "unavailable" };
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
        if (
          await checkedHead(readHead) !== receipt.resultProposalHeadId ||
          !samePointer(await this.pointer(pending.sourceId, false), published)
        ) return { kind: "unavailable" };
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
        observed !== receipt.resultProposalHeadId ||
        await checkedHead(readHead) !== observed ||
        !samePointer(await this.pointer(sourceId, false), pointer)
      ) return { kind: "unavailable" };
      return { kind: "available", receipt };
    } catch (e) {
      return failed(e);
    }
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
  private async receipt(sourceId: string, pointer: Pointer): Promise<Receipt> {
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
      (receipt as Receipt).generation !== pointer.generation ||
      (receipt as Receipt).sourceId !== sourceId
    ) throw new StoreError("corrupt");
    return receipt as Receipt;
  }
  private async read(
    path: string,
    kind: "pointer" | "receipt" | "lock",
  ): Promise<Buffer> {
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
      return out.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  private async replace(path: string, value: Pointer) {
    await this.ensure(value.sourceId);
    const temp = `${path}.${randomUUID()}.pending`;
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(value));
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
    c.snapshotRef.length > 512 || url.protocol !== "https:" || url.username ||
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
    ])
  ) throw new StoreError("corrupt");
  const r = value as Receipt;
  if (
    r.version !== 1 || !Number.isSafeInteger(r.generation) ||
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
  if (
    (r.outcome === "changed" &&
      r.resultProposalHeadId === r.priorProposalHeadId) ||
    ((r.outcome === "unchanged-304" || r.outcome === "unchanged-hash") &&
      (r.resultProposalHeadId !== r.priorProposalHeadId ||
        !same(r.priorCapture, r.currentCapture)))
  ) throw new StoreError("corrupt");
  assertPortableOutput(r);
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
