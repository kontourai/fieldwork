import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertServerReviewSessionEvents, createServerReviewSessionRecord, deriveServerReviewSessionApplyResult } from "@kontourai/survey/review-workbench/server-review-session";
import { buildExtractionInspectorModel, importExtractionEnvelope, type ReviewSessionEvent } from "@kontourai/survey";
import { FIELDWORK_LIMITS, failure } from "./contracts.js";
import {
  fieldworkHostPresentationSchema, parseFieldworkRunView, parsePreparedArtifactView,
  parseReviewMutationSuccess, type FieldworkHostPresentationV1,
  type FieldworkLifecycleEventV1, type FieldworkLifecycleListener,
  type FieldworkRunViewV1, type OpenRunOptions, type OpenRunService,
  type ReviewMutationResponseV1
} from "./api-contracts.js";
import { readRun, saveReview, withRunReviewLock } from "./run-store.js";
import { canonicalReviewItems, importNameFor, reviewSessionName } from "./fieldwork.js";

const reviewRequestSchema = z.object({
  events: z.array(z.custom<ReviewSessionEvent>((value) => Boolean(value && typeof value === "object"))).max(FIELDWORK_LIMITS.events),
  expectedEventCount: z.number().int().nonnegative().max(FIELDWORK_LIMITS.events),
  expectedRevision: z.number().int().nonnegative()
}).strict();

const defaultPresentation: FieldworkHostPresentationV1 = {
  apiVersion: "fieldwork.kontourai.io/v1",
  kind: "FieldworkHostPresentation",
  eyebrow: "Fieldwork",
  title: "Grounded review",
  theme: "light",
  navigation: [],
};

export async function openRun(runDirectory: string, options: OpenRunOptions = {}): Promise<OpenRunService> {
  const initial = await readRunView(runDirectory);
  const presentation = fieldworkHostPresentationSchema.parse(options.presentation ?? defaultPresentation);
  const embeddingOrigin = parseEmbeddingOrigin(options.embeddingOrigin);
  const capabilityToken = randomBytes(32).toString("base64url");
  const listeners = new Set<FieldworkLifecycleListener>();
  if (options.onLifecycleEvent) listeners.add(options.onLifecycleEvent);
  let sequence = 0;
  let closed = false;
  const emit = (
    type: FieldworkLifecycleEventV1["type"],
    revision: number,
    eventCount: number,
  ): void => {
    const event: FieldworkLifecycleEventV1 = {
      apiVersion: "fieldwork.kontourai.io/v1",
      kind: "FieldworkLifecycleEvent",
      sequence: ++sequence,
      type,
      runResource: initial.run.resource,
      revision,
      eventCount,
    };
    for (const listener of listeners) {
      try { listener(event); }
      catch { /* Observers cannot change the authoritative review operation. */ }
    }
  };
  let expectedOrigin = "";
  const server = createServer(async (request, response) => {
    try {
      if (!allowedHost(request.headers.host, expectedOrigin)) return void json(response, 400, failure("INVALID_HOST", "Host is not an allowed Fieldwork loopback authority"));
      await handle(runDirectory, capabilityToken, expectedOrigin, embeddingOrigin, presentation, emit, request, response);
    } catch (error) {
      const result = publicError(error);
      json(response, result.status, failure(result.code, result.message));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: options.port ?? 0 }, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback server did not expose a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  expectedOrigin = baseUrl;
  emit("run-opened", initial.run.revision, initial.review.events.length);
  return {
    baseUrl,
    capabilityToken,
    presentation,
    url: `${baseUrl}/#cap=${encodeURIComponent(capabilityToken)}`,
    view: () => readRunView(runDirectory),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      let finalView: FieldworkRunViewV1 | undefined;
      let readError: unknown;
      try { finalView = await readRunView(runDirectory); }
      catch (error) { readError = error; }
      try {
        await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      } finally {
        if (finalView) emit("run-closed", finalView.run.revision, finalView.review.events.length);
        listeners.clear();
      }
      if (readError) throw readError;
    },
  };
}

async function handle(
  directory: string,
  token: string,
  origin: string,
  embeddingOrigin: string | undefined,
  presentation: FieldworkHostPresentationV1,
  emit: (type: FieldworkLifecycleEventV1["type"], revision: number, eventCount: number) => void,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname.startsWith("/api/") && request.headers["x-fieldwork-capability"] !== token) {
    return void json(response, 401, failure("CAPABILITY_REQUIRED", "A valid Fieldwork launch capability is required"));
  }
  if (url.pathname === "/api/v1/run" && request.method === "GET") return void json(response, 200, await readRunView(directory));
  if (url.pathname === "/api/v1/host" && request.method === "GET") return void json(response, 200, presentation);
  if (url.pathname === "/api/v1/prepared" && request.method === "GET") {
    const stored = await readRun(directory);
    return void json(response, 200, parsePreparedArtifactView({
      apiVersion: "fieldwork.kontourai.io/v1", kind: "PreparedArtifactView", ok: true,
      text: stored.preparedText, artifact: stored.run.preparedArtifact
    }));
  }
  if (url.pathname === "/api/v1/review" && request.method === "POST") {
    if (request.headers.origin !== origin) return void json(response, 403, failure("ORIGIN_REQUIRED", "Mutation Origin must match the Fieldwork loopback origin"));
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      return void json(response, 415, failure("JSON_REQUIRED", "Review mutations require application/json"));
    }
    const result = await submit(directory, await body(request));
    if (result.ok) emit("review-event-persisted", result.revision, result.eventCount);
    return void json(response, result.ok ? 200 : 409, result);
  }
  if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
    return void html(response, await appHtml(), embeddingOrigin);
  }
  if (url.pathname.startsWith("/assets/") && request.method === "GET") return void asset(response, url.pathname);
  json(response, 404, failure("NOT_FOUND", "Unknown Fieldwork endpoint"));
}

export async function readRunView(directory: string): Promise<FieldworkRunViewV1> {
  const stored = await readRun(directory);
  const imported = importExtractionEnvelope(stored.envelope, {
    importName: importNameFor(stored.run), producerNamespace: "fieldwork", sourceKind: "uploaded-document",
    claimTarget: (proposal) => {
      const projection = stored.run.task.spec.projections.find((entry) => entry.fieldPath === proposal.fieldPath);
      if (!projection) throw new Error("Unknown projection");
      return { ...projection.claim, fieldOrBehavior: proposal.fieldPath };
    }
  });
  const inspector = buildExtractionInspectorModel({
    importResult: imported,
    artifact: { status: "available", text: stored.preparedText, actualDigest: stored.run.preparedArtifact.digest }
  });
  const record = createServerReviewSessionRecord({
    sessionName: reviewSessionName(stored.run), snapshot: stored.run.review.snapshot,
    eventCount: stored.run.review.events.length
  });
  const apply = deriveServerReviewSessionApplyResult({ record, events: stored.run.review.events, requiredResolvedItems: "none" });
  return parseFieldworkRunView({
    apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkRunView", ok: true,
    run: { resource: stored.run.runResource, revision: stored.run.review.revision },
    inspector,
    review: {
      snapshot: stored.run.review.snapshot,
      items: canonicalReviewItems(imported.reviewItems, stored.envelope),
      events: stored.run.review.events,
      apply
    }
  });
}

async function submit(directory: string, input: unknown): Promise<ReviewMutationResponseV1> {
  const parsed = reviewRequestSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_REVIEW", "Bounded Survey events, event count, and revision are required");
  return withRunReviewLock(directory, async (stored) => {
    const { events, expectedEventCount, expectedRevision } = parsed.data;
    const prefixMatches = JSON.stringify(events.slice(0, stored.run.review.events.length)) === JSON.stringify(stored.run.review.events);
    if (expectedRevision !== stored.run.review.revision
      || expectedEventCount !== stored.run.review.events.length
      || events.length <= stored.run.review.events.length
      || !prefixMatches) {
      return { ...failure("REVIEW_CONFLICT", "Review history is stale or not append-only"), eventCount: stored.run.review.events.length };
    }
    const record = createServerReviewSessionRecord({
      sessionName: reviewSessionName(stored.run), snapshot: stored.run.review.snapshot, eventCount: events.length
    });
    assertServerReviewSessionEvents(record, events);
    const apply = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "none" });
    const revision = stored.run.review.revision + 1;
    await saveReview(stored.directory, stored.run, { snapshot: stored.run.review.snapshot, events, revision });
    return parseReviewMutationSuccess({
      apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewMutationResult", ok: true,
      events, eventCount: events.length, revision, apply
    });
  });
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > FIELDWORK_LIMITS.requestBodyBytes) throw Object.assign(new Error("Request too large"), { code: "REQUEST_TOO_LARGE" });
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Malformed JSON"), { code: "INVALID_JSON" }); }
}

function allowedHost(host: string | undefined, origin: string): boolean {
  if (!host || !origin) return false;
  const port = new URL(origin).port;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function parseEmbeddingOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError("Embedding origin must be an absolute HTTP(S) origin"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin === "null") {
    throw new TypeError("Embedding origin must be an absolute HTTP(S) origin");
  }
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const concreteDnsName = hostname.length <= 253
    && hostname.split(".").every((label) =>
      label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
  if (isIP(hostname) === 0 && !concreteDnsName) {
    throw new TypeError("Embedding origin must use a concrete DNS name or IP address");
  }
  return parsed.origin;
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  const code = (error as { code?: string }).code;
  if (code === "REQUEST_TOO_LARGE") return { status: 413, code, message: "Request exceeds the Fieldwork body limit" };
  if (code === "INVALID_JSON") return { status: 400, code, message: "Request body is not valid JSON" };
  if (code === "REVIEW_BUSY") return { status: 503, code, message: "Review storage is temporarily busy" };
  if (error instanceof z.ZodError) return { status: 422, code: "INVALID_RUN", message: "Stored Fieldwork run failed validation" };
  return { status: 500, code: "INTERNAL", message: "Fieldwork could not complete the request" };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"
  }).end(JSON.stringify(value));
}
function html(response: ServerResponse, value: string, embeddingOrigin: string | undefined): void {
  const frameAncestors = embeddingOrigin ?? "'none'";
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`,
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff"
  }).end(value);
}
function browserRoot(): string {
  const packaged = fileURLToPath(new URL("./browser/", import.meta.url));
  return existsSync(join(packaged, "index.html")) ? packaged : join(process.cwd(), "dist/browser");
}
async function appHtml(): Promise<string> {
  try { return await readFile(join(browserRoot(), "index.html"), "utf8"); }
  catch { return "<!doctype html><title>Fieldwork</title><main><h1>Fieldwork review server</h1><p>Run npm run build for the browser UI.</p></main>"; }
}
async function asset(response: ServerResponse, pathname: string): Promise<void> {
  const root = await realpath(browserRoot());
  const target = resolve(root, `.${pathname}`);
  const segment = relative(root, target);
  if (segment.startsWith("..") || !segment) return void json(response, 404, failure("NOT_FOUND", "Unknown Fieldwork asset"));
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular asset");
    const canonical = await realpath(target);
    if (relative(root, canonical).startsWith("..")) throw new Error("asset escaped root");
    const type = canonical.endsWith(".js") ? "text/javascript" : canonical.endsWith(".css") ? "text/css" : "application/octet-stream";
    response.writeHead(200, {
      "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff"
    }).end(await readFile(canonical));
  } catch {
    json(response, 404, failure("NOT_FOUND", "Unknown Fieldwork asset"));
  }
}
