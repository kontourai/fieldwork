import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/forage";
import { resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import type {
  ContentType,
  ImageTextExtractor,
  PdfTextExtractor,
} from "@kontourai/traverse";
import type { FieldworkSourceAdapters } from "./api-contracts.js";
import { FIELDWORK_LIMITS } from "./contracts.js";

export const defaultSourceRoot = ".fieldwork/sources";

export interface FieldworkSourceInput {
  readonly sourcePath?: string;
  readonly snapshotRef?: string;
  readonly snapshotRoot?: string;
  readonly adapters?: FieldworkSourceAdapters;
}

export interface ResolvedFieldworkSource {
  readonly content: string | Uint8Array;
  readonly contentType: ContentType;
  readonly sourceRef: string;
  readonly sourceSnapshotRef: string;
  readonly identity: {
    readonly kind: "local-file" | "forage-snapshot";
    readonly ref: string;
    readonly digest: string;
    readonly contentType: ContentType;
    readonly pdfExtractorId?: string;
    readonly imageExtractorId?: string;
  };
  readonly pdfTextExtractor?: PdfTextExtractor;
  readonly imageTextExtractor?: ImageTextExtractor;
}

export async function resolveFieldworkSource(
  input: FieldworkSourceInput,
  taskName: string,
): Promise<ResolvedFieldworkSource> {
  if ((input.sourcePath ? 1 : 0) + (input.snapshotRef ? 1 : 0) !== 1) {
    throw Object.assign(
      new Error("Fieldwork requires exactly one of sourcePath or snapshotRef"),
      { code: "INVALID_ARGUMENT" },
    );
  }
  return input.snapshotRef
    ? resolveSnapshotSource(input.snapshotRef, input.snapshotRoot, input.adapters)
    : resolveLocalSource(input.sourcePath!, taskName, input.adapters);
}

async function resolveLocalSource(
  sourcePath: string,
  taskName: string,
  adapters: FieldworkSourceAdapters | undefined,
): Promise<ResolvedFieldworkSource> {
  const path = resolve(sourcePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Fieldwork source must be a regular file");
  }
  if (metadata.size > FIELDWORK_LIMITS.sourceBytes) {
    throw new Error("Fieldwork source exceeds the configured size limit");
  }
  const bytes = await readFile(path);
  const contentType = contentTypeForPath(path);
  const content = isBinary(contentType) ? bytes : bytes.toString("utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sourceRef = `fieldwork-source:v1:${taskName}:${digest}`;
  return resolved(content, contentType, sourceRef, sourceRef, digest, "local-file", adapters);
}

async function resolveSnapshotSource(
  snapshotRef: string,
  snapshotRoot: string | undefined,
  adapters: FieldworkSourceAdapters | undefined,
): Promise<ResolvedFieldworkSource> {
  const store = createFilesystemSnapshotStore({ root: resolve(snapshotRoot ?? defaultSourceRoot) });
  const resolution = await resolveSnapshotSourceRef(store, snapshotRef);
  if (!resolution.ok) {
    throw Object.assign(
      new Error(`Fieldwork snapshot replay failed: ${resolution.error.kind}`),
      { code: "SNAPSHOT_REPLAY_FAILED" },
    );
  }
  const snapshot = resolution.snapshot;
  const size = typeof snapshot.body === "string"
    ? Buffer.byteLength(snapshot.body)
    : snapshot.body.byteLength;
  if (size > FIELDWORK_LIMITS.sourceBytes) {
    throw new Error("Fieldwork source exceeds the configured size limit");
  }
  const contentType = contentTypeForSnapshot(
    snapshot.url,
    headerValue(snapshot.headers, "content-type"),
  );
  const digest = createHash("sha256").update(snapshot.body).digest("hex");
  return resolved(
    snapshot.body,
    contentType,
    snapshotRef,
    snapshotRef,
    digest,
    "forage-snapshot",
    adapters,
  );
}

function resolved(
  content: string | Uint8Array,
  contentType: ContentType,
  sourceRef: string,
  sourceSnapshotRef: string,
  digest: string,
  kind: "local-file" | "forage-snapshot",
  adapters: FieldworkSourceAdapters | undefined,
): ResolvedFieldworkSource {
  validateAdapterId(adapters?.pdf?.id);
  validateAdapterId(adapters?.image?.id);
  if (contentType === "pdf" && !adapters?.pdf) {
    throw Object.assign(
      new Error("PDF extraction requires a host-supplied PDF text adapter"),
      { code: "PDF_ADAPTER_REQUIRED" },
    );
  }
  if ((contentType === "png" || contentType === "jpeg") && !adapters?.image) {
    throw Object.assign(
      new Error("Image extraction requires a host-supplied OCR adapter"),
      { code: "IMAGE_ADAPTER_REQUIRED" },
    );
  }
  return {
    content,
    contentType,
    sourceRef,
    sourceSnapshotRef,
    identity: {
      kind,
      ref: sourceRef,
      digest,
      contentType,
      ...(contentType === "pdf" ? { pdfExtractorId: adapters!.pdf!.id } : {}),
      ...(contentType === "png" || contentType === "jpeg"
        ? { imageExtractorId: adapters!.image!.id }
        : {}),
    },
    ...(contentType === "pdf" ? { pdfTextExtractor: adapters!.pdf!.extract } : {}),
    ...(contentType === "png" || contentType === "jpeg"
      ? { imageTextExtractor: adapters!.image!.extract }
      : {}),
  };
}

function validateAdapterId(id: string | undefined): void {
  if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(id)) {
    throw Object.assign(
      new Error("Fieldwork source adapter id must be a bounded portable identifier"),
      { code: "INVALID_ARGUMENT" },
    );
  }
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function contentTypeForSnapshot(url: string, header: string | undefined): ContentType {
  const mediaType = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  if (mediaType === "text/vtt") return "transcript";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpeg";
  return contentTypeForPath(new URL(url).pathname);
}

function contentTypeForPath(path: string): ContentType {
  switch (extname(path).toLowerCase()) {
    case ".html":
    case ".htm":
      return "html";
    case ".vtt":
      return "transcript";
    case ".pdf":
      return "pdf";
    case ".png":
      return "png";
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    default:
      return "text";
  }
}

function isBinary(contentType: ContentType): boolean {
  return contentType === "pdf" || contentType === "png" || contentType === "jpeg";
}
