import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertPortableOutput } from "./run-store.js";

const MAX = 16_384;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^receipt-([1-9][0-9]*)-([a-f0-9]{64})\.json$/;
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
export type Result =
  | {
      readonly kind:
        | "missing"
        | "pending"
        | "superseded"
        | "busy"
        | "corrupt"
        | "unavailable";
    }
  | { readonly kind: "available"; readonly receipt: Receipt };
export type ReadHead = () => Promise<string | null>;
interface Pointer {
  version: 1;
  sourceId: string;
  generation: number;
  state: "pending" | "current" | "failed";
  token: string;
  baselineHeadId: string;
  receipt?: string;
  receiptDigest?: string;
}

/** Private Fieldwork persistence; it deliberately has no root-package export. */
export class FieldworkSourceCheckReceiptStore {
  public constructor(private readonly root: string) {}
  public async begin(
    sourceId: string,
    baseline: Baseline,
    readHead: ReadHead,
  ): Promise<Pending> {
    validBaseline(sourceId, baseline);
    return this.lock(sourceId, async () => {
      const old = await this.pointer(sourceId, true);
      if (
        (old?.token ?? null) !== baseline.pointerToken ||
        (await readHead()) !== baseline.proposalHeadId
      )
        throw new StoreError("superseded");
      const pointer: Pointer = {
        version: 1,
        sourceId,
        generation: (old?.generation ?? 0) + 1,
        state: "pending",
        token: randomUUID(),
        baselineHeadId: baseline.proposalHeadId,
      };
      await this.replace(this.pointerPath(sourceId), pointer);
      if ((await readHead()) !== baseline.proposalHeadId)
        throw new StoreError("superseded");
      return {
        sourceId,
        generation: pointer.generation,
        pointerToken: pointer.token,
        baseline,
      };
    });
  }
  /** Obtained immediately before begin so the caller can freeze the pointer CAS witness. */
  public async currentPointerToken(sourceId: string): Promise<string | null> {
    return (await this.pointer(sourceId, true))?.token ?? null;
  }
  public async finalize(
    pending: Pending,
    completed: Omit<Receipt, "version" | "sourceId" | "generation">,
    readHead: ReadHead,
  ): Promise<Result> {
    try {
      const receipt: Receipt = {
        version: 1,
        sourceId: pending.sourceId,
        generation: pending.generation,
        ...completed,
      };
      validPending(pending);
      validReceipt(receipt);
      return await this.lock(pending.sourceId, async () => {
        const pointer = await this.pointer(pending.sourceId, false);
        if (
          !pointer ||
          pointer.state !== "pending" ||
          pointer.generation !== pending.generation ||
          pointer.token !== pending.pointerToken ||
          pointer.baselineHeadId !== pending.baseline.proposalHeadId
        )
          return { kind: "superseded" };
        if (
          receipt.priorProposalHeadId !== pending.baseline.proposalHeadId ||
          !same(receipt.priorCapture, pending.baseline.admittedAcquisition)
        )
          return { kind: "superseded" };
        if ((await readHead()) !== receipt.resultProposalHeadId)
          return { kind: "unavailable" };
        const bytes = Buffer.from(JSON.stringify(receipt));
        const digest = sha(bytes);
        const name = `receipt-${receipt.generation}-${digest}.json`;
        await this.immutable(join(this.dir(pending.sourceId), name), bytes);
        if (
          (await readHead()) !== receipt.resultProposalHeadId ||
          !samePointer(await this.pointer(pending.sourceId, false), pointer)
        )
          return { kind: "unavailable" };
        await this.replace(this.pointerPath(pending.sourceId), {
          ...pointer,
          state:
            receipt.outcome === "error" ||
            receipt.outcome === "extraction-failure"
              ? "failed"
              : "current",
          receipt: name,
          receiptDigest: digest,
        });
        if ((await readHead()) !== receipt.resultProposalHeadId)
          return { kind: "unavailable" };
        return { kind: "available", receipt };
      });
    } catch (error) {
      return failure(error);
    }
  }
  public async readCurrent(
    sourceId: string,
    readHead: ReadHead,
  ): Promise<Result> {
    try {
      const pointer = await this.pointer(sourceId, true);
      if (!pointer) return { kind: "missing" };
      if (pointer.state === "pending") return { kind: "pending" };
      if (
        pointer.state !== "current" ||
        !pointer.receipt ||
        !pointer.receiptDigest
      )
        return { kind: "unavailable" };
      const head = await readHead();
      const receipt = await this.receipt(sourceId, pointer);
      if (head !== receipt.resultProposalHeadId) return { kind: "unavailable" };
      if (
        (await readHead()) !== head ||
        !samePointer(await this.pointer(sourceId, false), pointer)
      )
        return { kind: "unavailable" };
      return { kind: "available", receipt };
    } catch (error) {
      return failure(error);
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
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new StoreError("corrupt");
    const dir = this.dir(sourceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new StoreError("corrupt");
    return dir;
  }
  private async pointer(
    sourceId: string,
    absent: boolean,
  ): Promise<Pointer | null> {
    try {
      const value = JSON.parse(
        (await this.read(this.pointerPath(sourceId))).toString(),
      ) as Pointer;
      validPointer(value, sourceId);
      return value;
    } catch (error) {
      if (absent && code(error) === "ENOENT") return null;
      throw error;
    }
  }
  private async receipt(sourceId: string, pointer: Pointer): Promise<Receipt> {
    if (
      !pointer.receipt ||
      !pointer.receiptDigest ||
      !NAME.test(pointer.receipt)
    )
      throw new StoreError("corrupt");
    const bytes = await this.read(join(this.dir(sourceId), pointer.receipt));
    if (sha(bytes) !== pointer.receiptDigest) throw new StoreError("corrupt");
    let value: Receipt;
    try {
      value = JSON.parse(bytes.toString());
    } catch {
      throw new StoreError("corrupt");
    }
    validReceipt(value);
    const m = NAME.exec(pointer.receipt);
    if (
      !m ||
      Number(m[1]) !== value.generation ||
      m[2] !== pointer.receiptDigest ||
      value.generation !== pointer.generation ||
      value.sourceId !== sourceId
    )
      throw new StoreError("corrupt");
    return value;
  }
  private async read(path: string): Promise<Buffer> {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX)
        throw new StoreError("corrupt");
      const out = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await handle.read(out, 0, out.length, 0);
      const after = await handle.stat();
      if (
        bytesRead > MAX ||
        after.size !== before.size ||
        !sameFile(before, after)
      )
        throw new StoreError("corrupt");
      return out.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  private async replace(path: string, value: Pointer) {
    await this.ensure(value.sourceId);
    const temp = `${path}.${randomUUID()}.pending`;
    const h = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await h.writeFile(JSON.stringify(value));
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(temp, path);
  }
  private async immutable(path: string, bytes: Buffer) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new StoreError("corrupt");
    const temp = `${path}.${randomUUID()}.pending`;
    const h = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      const old = await this.read(path);
      if (!old.equals(bytes)) throw new StoreError("corrupt");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  private async lock<T>(sourceId: string, body: () => Promise<T>): Promise<T> {
    const dir = await this.ensure(sourceId),
      path = join(dir, ".lock");
    for (let attempt = 0; attempt < 5; attempt++) {
      const temp = `${path}.${randomUUID()}.pending`;
      let h;
      try {
        h = await open(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        await h.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        );
        await h.sync();
        await link(temp, path);
        const owner = await h.stat();
        try {
          return await body();
        } finally {
          await h.close();
          await unlinkOwned(path, owner);
        }
      } catch (error) {
        await h?.close().catch(() => undefined);
        if (code(error) !== "EEXIST") throw error;
        await recover(path);
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    }
    throw new StoreError("busy");
  }
}
class StoreError extends Error {
  public constructor(readonly kind: Exclude<Result["kind"], "available">) {
    super(kind);
  }
}
function failure(error: unknown): Result {
  return {
    kind:
      error instanceof StoreError
        ? error.kind
        : code(error) === "EEXIST"
          ? "busy"
          : "corrupt",
  };
}
function code(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}
function sha(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function samePointer(left: Pointer | null, right: Pointer) {
  return left !== null && same(left, right);
}
function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
) {
  return left.dev === right.dev && left.ino === right.ino;
}
function validId(value: string) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)
  )
    throw new StoreError("corrupt");
}
function validCapture(value: Capture, sourceId: string) {
  if (
    !value ||
    value.sourceId !== sourceId ||
    typeof value.snapshotRef !== "string" ||
    value.snapshotRef.length > 512 ||
    !/^https:\/\//.test(value.url) ||
    /@/.test(new URL(value.url).host) ||
    !HASH.test(value.bodyHash) ||
    typeof value.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(value.fetchedAt)) ||
    !["snapshot-envelope", "body-and-identity"].includes(value.integrity) ||
    (value.snapshotDigest !== undefined && !HASH.test(value.snapshotDigest))
  )
    throw new StoreError("corrupt");
}
function validBaseline(sourceId: string, value: Baseline) {
  validId(sourceId);
  if (
    (value.pointerToken !== null &&
      !/^[0-9a-f-]{36}$/i.test(value.pointerToken)) ||
    !HASH.test(value.proposalHeadId)
  )
    throw new StoreError("corrupt");
  validCapture(value.admittedAcquisition, sourceId);
}
function validPending(value: Pending) {
  validBaseline(value.sourceId, value.baseline);
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !/^[0-9a-f-]{36}$/i.test(value.pointerToken)
  )
    throw new StoreError("corrupt");
}
function validPointer(value: Pointer, sourceId: string) {
  if (
    !value ||
    value.version !== 1 ||
    value.sourceId !== sourceId ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !["pending", "current", "failed"].includes(value.state) ||
    !/^[0-9a-f-]{36}$/i.test(value.token) ||
    !HASH.test(value.baselineHeadId) ||
    (value.state === "current" &&
      (!value.receipt ||
        !value.receiptDigest ||
        !HASH.test(value.receiptDigest)))
  )
    throw new StoreError("corrupt");
}
function validReceipt(value: Receipt) {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    ![
      "unchanged-304",
      "unchanged-hash",
      "changed",
      "error",
      "extraction-failure",
    ].includes(value.outcome) ||
    typeof value.checkedAt !== "string" ||
    Number.isNaN(Date.parse(value.checkedAt)) ||
    !HASH.test(value.priorProposalHeadId) ||
    !HASH.test(value.resultProposalHeadId)
  )
    throw new StoreError("corrupt");
  validId(value.sourceId);
  validCapture(value.priorCapture, value.sourceId);
  validCapture(value.currentCapture, value.sourceId);
  assertPortableOutput(value);
}
async function unlinkOwned(
  path: string,
  owner: { dev: number | bigint; ino: number | bigint },
) {
  try {
    const current = await lstat(path);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      sameFile(current, owner)
    )
      await unlink(path);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
}
async function recover(path: string) {
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 512 ||
      Date.now() - stat.mtimeMs < 60_000
    )
      return;
    const h = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let raw;
    try {
      const opened = await h.stat();
      if (!opened.isFile() || !sameFile(stat, opened)) return;
      raw = (await h.readFile({ encoding: "utf8" })).slice(0, 512);
    } finally {
      await h.close();
    }
    try {
      const owner = JSON.parse(raw) as { pid?: number };
      process.kill(owner.pid ?? -1, 0);
    } catch (error) {
      if (code(error) === "ESRCH" || error instanceof SyntaxError)
        await unlinkOwned(path, stat);
    }
  } catch {
    /* ambiguous owners remain busy */
  }
}
