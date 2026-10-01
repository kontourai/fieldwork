import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFilesystemSnapshotStore, type Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ModelRuntime } from "@kontourai/relay";
import { runFieldwork } from "../../src/fieldwork.js";
import type { FieldworkRuntimeBinding } from "../../src/runtime-contracts.js";
import { tempRoot } from "../helpers.js";

/*
 * A run the published Fieldwork 0.13.0 wrote with a real model runtime over a
 * short synthetic specification memo, then decided in the workbench: six
 * items, every one accepted. The model answered the `number` field
 * `doc.versionNumber` with the text "2.1", which Traverse recorded as
 * `evidenceMatch.schema: type-mismatch` (fieldwork#170). The files are the
 * run's own, unedited.
 */
const REAL_RUN = join(import.meta.dirname, "..", "fixtures", "real-run-0.13.0", "run-b51eaff623a3a58a");

/** A private copy of the real run, so a test can decide, edit or export it. */
export async function realRunCopy(label: string): Promise<string> {
  const directory = join(await tempRoot(`real-run-${label}`), "run-b51eaff623a3a58a");
  await cp(REAL_RUN, directory, { recursive: true });
  return directory;
}

/** The real run's task, written where a new run can use it. */
export async function realRunTaskPath(root: string): Promise<string> {
  const task = (JSON.parse(await readFile(join(REAL_RUN, "run.json"), "utf8")) as { task: unknown }).task;
  const taskPath = join(root, "task.json");
  await writeFile(taskPath, JSON.stringify(task));
  return taskPath;
}

/** The real run's prepared text: the memo it was extracted from. */
export function realRunSourceText(): Promise<string> {
  return readFile(join(REAL_RUN, "prepared.txt"), "utf8");
}

/** How {@link typedFieldRun} words the version and the publication date. */
export interface TypedFieldOptions {
  /** The model answers the version as a number rather than as text. */
  readonly versionAsNumber?: boolean;
  /**
   * Keep the real memo's wording: "2.1" and "14 March 2026", the two spellings
   * Traverse rewrites into the field's type. Otherwise the memo says "2.10"
   * and "14/03/2026", which Traverse leaves as the model wrote them.
   */
  readonly rewritable?: boolean;
}

function typedFieldWording(options: TypedFieldOptions): { readonly version: string; readonly date: string } {
  return {
    version: options.rewritable || options.versionAsNumber ? "2.1" : "2.10",
    date: options.rewritable ? "14 March 2026" : "14/03/2026",
  };
}

/**
 * A runtime that answers the real run's task the way the real model did: the
 * version number as text for a `number` field and, as in the real web-page
 * run, the publication date in the document's own wording for a `date` field.
 * Traverse checks both against the schema itself, after rewriting the two
 * spellings it can rewrite without loss.
 */
export function typedFieldRuntime(options: TypedFieldOptions = {}): FieldworkRuntimeBinding {
  const { version, date } = typedFieldWording(options);
  const proposal = (fieldPath: string, value: unknown, excerpt: string) =>
    ({ fieldPath, value, confidence: 1, excerpt, locator: null, occurrenceHint: null });
  const runtime: ModelRuntime = {
    id: "fake:typed-fields",
    capabilities: () => ({
      structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native",
      streaming: false, abort: true, usage: true,
    }),
    invoke: async () => ({
      provider: "fixture-runtime", model: "fixture-model", outputText: "",
      toolCalls: [{
        id: "tool-typed", name: "submit_extraction_proposals",
        input: { proposals: [
          proposal("doc.title", "Harbor Telemetry Exchange Format", "The full title of this specification is Harbor Telemetry Exchange Format."),
          proposal("doc.publicationDate", date, `This specification was published on ${date}.`),
          proposal("doc.versionNumber", options.versionAsNumber ? 2.1 : version, `This document describes version ${version} of the format.`),
        ] },
      }],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latencyMs: 1, stopReason: "tool_use",
    }),
  };
  return { role: "fieldwork-extraction", candidates: [{ id: "scripted", runtime }], budget: { maxAttempts: 4, maxElapsedMs: 60_000 } };
}

/** A new run of the real task over the real memo, worded per `options` and answered by {@link typedFieldRuntime}. */
export async function typedFieldRun(label: string, options: TypedFieldOptions = {}): Promise<string> {
  const root = await tempRoot(`typed-fields-${label}`);
  const sourcePath = join(root, "memo.md");
  const { version, date } = typedFieldWording(options);
  const memo = (await realRunSourceText())
    .replace("describes version 2.1 of", `describes version ${version} of`)
    .replace("was published on 14 March 2026.", `was published on ${date}.`);
  await writeFile(sourcePath, memo);
  const run = await runFieldwork({ taskPath: await realRunTaskPath(root), sourcePath, root: join(root, "runs"), runtime: typedFieldRuntime(options) });
  return run.runDirectory;
}

/**
 * A run stopped by `maxChunks: 2`. From a web page (`html`), Traverse's
 * prepared artifact holds only the chunks it kept, so coverage lists two
 * complete chunks and the dropped ones appear only in `partial.remainingChunks`
 * — the shape the real 55,000-character page wrote. From plain `text`, the
 * prepared artifact keeps everything and coverage lists the capped chunks as
 * unread.
 */
export async function chunkCappedRun(label: string, kind: "html" | "text"): Promise<string> {
  const root = await tempRoot(`chunk-cap-${label}`);
  const runtime = statusRuntime();
  const taskPath = "examples/generic/task.json";
  if (kind === "text") {
    const sourcePath = join(root, "source.txt");
    await writeFile(sourcePath, `Status: Active\n${"filler line of text.\n".repeat(2_600)}`);
    return (await runFieldwork({ taskPath, sourcePath, root: join(root, "runs"), runtime })).runDirectory;
  }
  const paragraphs = Array.from({ length: 900 }, (_, index) => `<p>Paragraph ${index} of filler text that goes on for a while to fill chunks.</p>`).join("");
  const body = `<html><body><main><h1>Record</h1><p>Status: Active</p>${paragraphs}</main></body></html>`;
  const snapshot: Snapshot = {
    sourceId: "generic-record-source", url: "https://example.invalid/generic-record", status: 200,
    fetchedAt: "2026-07-23T10:00:00.000Z", body, bodyHash: createHash("sha256").update(body).digest("hex"),
    headers: { "content-type": "text/html; charset=utf-8" },
  };
  const snapshotRoot = join(root, "snapshots");
  await createFilesystemSnapshotStore({ root: snapshotRoot }).put(snapshot);
  return (await runFieldwork({ taskPath, snapshotRef: buildSnapshotSourceRef(snapshot), snapshotRoot, root: join(root, "runs"), runtime })).runDirectory;
}

/** Proposes the status its chunk states, and nothing for a chunk that states none; capped at two chunks. */
function statusRuntime(): FieldworkRuntimeBinding {
  const runtime: ModelRuntime = {
    id: "fake:chunk-cap",
    capabilities: () => ({
      structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native",
      streaming: false, abort: true, usage: true,
    }),
    invoke: async (request) => {
      const match = /Status: (\w+)/.exec(JSON.stringify(request.messages));
      return {
        provider: "fixture-runtime", model: "fixture-model", outputText: "",
        toolCalls: [{
          id: "tool-status", name: "submit_extraction_proposals",
          input: { proposals: match ? [{ fieldPath: "record.status", value: match[1], confidence: 0.98, excerpt: match[0], locator: null, occurrenceHint: null }] : [] },
        }],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, latencyMs: 1, stopReason: "tool_use",
      };
    },
  };
  return { role: "fieldwork-extraction", candidates: [{ id: "scripted", runtime }], budget: { maxAttempts: 30, maxElapsedMs: 60_000 }, maxChunks: 2 };
}
