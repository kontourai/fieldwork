import { crawl, createFilesystemSnapshotStore, type CrawlManifest } from "@kontourai/forage";
import {
  type FieldworkAcquisitionOptions,
  type FieldworkAcquisitionResult,
} from "./api-contracts.js";
import { defaultSourceRoot } from "./source-input.js";

type Crawl = typeof crawl;

export async function acquireFieldwork(
  options: FieldworkAcquisitionOptions,
): Promise<FieldworkAcquisitionResult> {
  return acquireFieldworkWith(options, crawl);
}

export async function acquireFieldworkWith(
  options: FieldworkAcquisitionOptions,
  acquire: Crawl,
): Promise<FieldworkAcquisitionResult> {
  const store = createFilesystemSnapshotStore({ root: options.snapshotRoot ?? defaultSourceRoot });
  const manifest = await acquire(
    { url: options.url },
    {
      store,
      maxPages: options.maxPages ?? 20,
      maxDepth: options.maxDepth ?? 2,
      discovery: options.discovery ?? "links",
      render: options.render ?? "never",
    },
  );
  return acquisitionResult(manifest);
}

function acquisitionResult(manifest: CrawlManifest): FieldworkAcquisitionResult {
  return {
    apiVersion: "fieldwork.kontourai.io/v1",
    kind: "FieldworkAcquisitionResult",
    pages: manifest.pages.map((page) => ({
      sourceRef: page.sourceRef,
      status: page.status,
      depth: page.depth,
      rendered: page.rendered,
      warningCount: page.warnings.length,
    })),
    truncated: manifest.truncated,
    warningCount: manifest.warnings.length,
  };
}
