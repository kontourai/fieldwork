import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validatePortableExtractionResultEnvelope, type PortableExtractionResultEnvelope } from "@kontourai/traverse";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { ReviewSessionEvent } from "@kontourai/survey";
import { z } from "zod";
import { FIELDWORK_LIMITS, fieldworkTaskSchema, type FieldworkTask } from "./contracts.js";
import { parsePersistedReview, persistedReviewEventSchema, persistedReviewSnapshotSchema } from "./survey-persistence.js";

export interface StoredRun {
  schemaVersion: 1;
  runResource: string;
  createdAt: string;
  taskName: string;
  task: FieldworkTask;
  preparedArtifact: { ref: string; digest: string; contentLength: number; file: "prepared.txt" };
  envelopeFile: "extraction-envelope.json";
  review: { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[]; revision: number };
}

export const storedRunSchema = z.object({
  schemaVersion: z.literal(1),
  runResource: z.string().regex(/^fieldwork-run:v1:[a-z0-9][a-z0-9-]*:[a-f0-9]{16}$/),
  createdAt: z.string().datetime(),
  taskName: z.string().max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
  task: fieldworkTaskSchema,
  preparedArtifact: z.object({
    ref: z.string().max(FIELDWORK_LIMITS.string),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    contentLength: z.number().int().nonnegative().max(FIELDWORK_LIMITS.sourceBytes),
    file: z.literal("prepared.txt")
  }).strict(),
  envelopeFile: z.literal("extraction-envelope.json"),
  review: z.object({
    snapshot: persistedReviewSnapshotSchema,
    events: z.array(persistedReviewEventSchema).max(FIELDWORK_LIMITS.events),
    revision: z.number().int().nonnegative()
  }).strict()
}).strict();

export interface StoredRunRead {
  directory: string;
  run: StoredRun;
  envelope: PortableExtractionResultEnvelope;
  preparedText: string;
}

export const defaultRunRoot = ".fieldwork/runs";
const REVIEW_LOCK_MAX_BYTES = 256;
const REVIEW_LOCK_ABANDONED_MS = 1_000;
const REVIEW_LOCK_WAIT_MS = 750;
export interface ReviewLockPublicationHooks {
  beforePublish?(): Promise<void>;
}

export function portablePath(root: string, target: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const segment = relative(absoluteRoot, absoluteTarget);
  if (segment === ".." || segment.startsWith("../") || segment.startsWith("..\\") || isAbsolute(segment)) {
    throw new Error("Run path escapes its selected root");
  }
  return absoluteTarget;
}

export async function writeRun(root: string, run: StoredRun, envelope: PortableExtractionResultEnvelope, preparedText: string): Promise<string> {
  const absoluteRoot = resolve(root);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const directory = portablePath(absoluteRoot, join(absoluteRoot, `run-${run.runResource.split(":").at(-1)}`));
  const staging = portablePath(absoluteRoot, join(absoluteRoot, `.fieldwork-create-${randomUUID()}`));
  await mkdir(staging, { mode: 0o700 });
  try {
    await atomicJson(join(staging, "run.json"), run);
    await atomicJson(join(staging, run.envelopeFile), envelope);
    await atomicText(join(staging, run.preparedArtifact.file), preparedText);
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    await readRun(directory);
  }
  return directory;
}

export async function readRun(runDirectory: string): Promise<StoredRunRead> {
  const requested = resolve(runDirectory);
  await rejectSymlink(requested, "run directory");
  const directory = await realpath(requested);
  const runPath = await containedRegularFile(directory, "run.json");
  const runText = await readBounded(runPath, FIELDWORK_LIMITS.taskBytes + FIELDWORK_LIMITS.requestBodyBytes);
  const parsedRun = storedRunSchema.parse(JSON.parse(runText));
  const validatedReview = parsePersistedReview(parsedRun.review);
  const run = {
    ...parsedRun,
    review: { ...validatedReview, revision: parsedRun.review.revision }
  } as StoredRun;
  const envelopePath = await containedRegularFile(directory, run.envelopeFile);
  const envelopeText = await readBounded(envelopePath, FIELDWORK_LIMITS.requestBodyBytes);
  const validated = validatePortableExtractionResultEnvelope(JSON.parse(envelopeText));
  if (validated.status !== "valid") throw new Error("Stored extraction envelope is invalid");
  const preparedPath = await containedRegularFile(directory, run.preparedArtifact.file);
  const preparedText = await readBounded(preparedPath, FIELDWORK_LIMITS.sourceBytes);
  assertPreparedIdentity(run, validated.envelope, preparedText);
  assertBoundedJson(run);
  return { directory, run, envelope: validated.envelope, preparedText };
}

export async function withRunReviewLock<T>(
  runDirectory: string,
  operation: (stored: StoredRunRead) => Promise<T>,
  publicationHooks: ReviewLockPublicationHooks = {}
): Promise<T> {
  const stored = await readRun(runDirectory);
  const lockPath = join(stored.directory, ".review.lock");
  const deadline = Date.now() + REVIEW_LOCK_WAIT_MS;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  while (!lock) {
    try {
      lock = await createReviewLock(lockPath, publicationHooks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw Object.assign(new Error("Review storage is busy"), { code: "REVIEW_BUSY" });
      }
      await recoverAbandonedLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation(await readRun(stored.directory));
  } finally {
    const owned = await lock.stat();
    await lock.close();
    await unlinkIfSameRegularFile(lockPath, owned);
  }
}

export async function saveReview(directory: string, run: StoredRun, review: StoredRun["review"]): Promise<void> {
  parsePersistedReview(review);
  storedRunSchema.parse({ ...run, review });
  await atomicJson(join(directory, "run.json"), { ...run, review });
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicText(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function assertPreparedIdentity(run: StoredRun, envelope: PortableExtractionResultEnvelope, preparedText: string): void {
  const actualDigest = createHash("sha256").update(preparedText).digest("hex");
  const prepared = envelope.result.preparedArtifact;
  const state = envelope.result.preparedArtifactState;
  if (!prepared
    || actualDigest !== run.preparedArtifact.digest
    || preparedText.length !== run.preparedArtifact.contentLength
    || prepared.digest !== actualDigest
    || prepared.contentLength !== preparedText.length
    || prepared.ref !== run.preparedArtifact.ref
    || prepared.sourceSnapshotRef !== envelope.source.snapshotRef
    || envelope.source.ref !== envelope.source.snapshotRef
    || state?.status !== "available"
    || state.canonicalRef !== prepared.ref
    || state.requestedRef !== prepared.ref) {
    throw new Error("Prepared artifact identity does not match the Traverse envelope");
  }
}

async function containedRegularFile(directory: string, filename: string): Promise<string> {
  const target = portablePath(directory, join(directory, filename));
  await rejectSymlink(target, "run artifact");
  const metadata = await lstat(target);
  if (!metadata.isFile()) throw new Error("Run artifact is not a regular file");
  const canonical = await realpath(target);
  portablePath(directory, canonical);
  return canonical;
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
}

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.size > maxBytes) throw new Error("Stored artifact exceeds the Fieldwork size limit");
  return readFile(path, "utf8");
}

function assertBoundedJson(value: unknown): void {
  let entries = 0;
  const visit = (entry: unknown): void => {
    if (++entries > 100_000) throw new Error("Stored run exceeds the Fieldwork structure limit");
    if (typeof entry === "string" && entry.length > FIELDWORK_LIMITS.string) throw new Error("Stored run contains an oversized string");
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  visit(value);
}

export function assertPortableOutput(value: unknown): void {
  const pathValue = /(?:^|[\s"'=(])(?:\/(?!\/)[^\s"'<>]+|~\/[^\s"'<>]+|[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\\\s]+\\[^\s"'<>]+|file:\/\/\/?[^\s"'<>]+)/i;
  const credentialPatterns = [
    /(?:^|[\s"'=:])sk-(?:proj-)?[A-Za-z0-9_-]{8,}/i,
    /(?:^|[\s"'=:])bearer\s+[A-Za-z0-9._~+/-]{8,}/i,
    /(?:^|[\s"'=:])gh[pousr]_[A-Za-z0-9]{20,}/,
    /(?:^|[\s"'=:])github_pat_[A-Za-z0-9_]{20,}/,
    /(?:^|[\s"'=:])glpat-[A-Za-z0-9_-]{20,}/,
    /(?:^|[\s"'=:])xox[baprs]-[A-Za-z0-9-]{10,}/,
    /(?:^|[\s"'=:])(?:npm_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|sk_live_[A-Za-z0-9]{16,})/,
    /(?:^|[\s"'=:])(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{16}/,
    /(?:api[_-]?(?:key|token)|token|secret|password|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ];
  const visit = (entry: unknown): void => {
    if (typeof entry === "string" && (pathValue.test(entry) || credentialPatterns.some((pattern) => pattern.test(entry)) || /\.kontourai(?:\/|\\)|(?:^|[\\/])ops[\\/]/i.test(entry))) {
      throw new Error("Portable output contains a private path, credential, or suite reference");
    }
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (!entry || typeof entry !== "object") return;
    for (const [key, nested] of Object.entries(entry)) {
      if (/^(?:api[_-]?key|authorization|secret|password|access[_-]?token|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|raw(?:Provider)?Diagnostics?)$/i.test(key)) {
        throw new Error("Portable output contains a forbidden credential or raw diagnostic field");
      }
      visit(nested);
    }
  };
  visit(value);
}

export function resolveRunReference(run: string): string {
  return isAbsolute(run) ? run : resolve(run);
}

async function recoverAbandonedLock(lockPath: string): Promise<void> {
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > REVIEW_LOCK_MAX_BYTES) return;
    if (Date.now() - metadata.mtimeMs < REVIEW_LOCK_ABANDONED_MS) return;
    const handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > REVIEW_LOCK_MAX_BYTES || !sameFile(metadata, opened)) return;
      const buffer = Buffer.alloc(REVIEW_LOCK_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > REVIEW_LOCK_MAX_BYTES) return;
      raw = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    let owner: { pid?: number; createdAt?: number } | undefined;
    try { owner = JSON.parse(raw) as { pid?: number; createdAt?: number }; }
    catch { owner = undefined; }
    if (!owner || !Number.isInteger(owner.pid) || !Number.isFinite(owner.createdAt)) {
      await unlinkIfSameRegularFile(lockPath, metadata);
      return;
    }
    let alive = true;
    try { process.kill(owner.pid!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (!alive) await unlinkIfSameRegularFile(lockPath, metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

async function createReviewLock(lockPath: string, hooks: ReviewLockPublicationHooks): Promise<FileHandle> {
  const pendingPath = `${lockPath}.${randomUUID()}.pending`;
  const handle = await open(pendingPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
    await handle.sync();
    await hooks.beforePublish?.();
    // link(2) publishes the already-populated inode without replacing an
    // existing owner. At no point is an empty live lock visible to contenders.
    await link(pendingPath, lockPath);
    await unlink(pendingPath).catch(() => undefined);
    return handle;
  } catch (error) {
    const owned = await handle.stat().catch(() => undefined);
    await handle.close();
    if (owned) await unlinkIfSameRegularFile(pendingPath, owned);
    throw error;
  }
}

async function unlinkIfSameRegularFile(path: string, expected: Awaited<ReturnType<FileHandle["stat"]>>): Promise<void> {
  try {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || !sameFileState(current, expected)) return;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sameFile(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(
  left: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint }
): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
