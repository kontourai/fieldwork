import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFilesystemSnapshotStore, type Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createObservationStore, type CheckResult, type LookoutSource, type ProposalSetObservation } from "@kontourai/lookout";
import { ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import { buildTrustReport, formatTrustReportSummary, validateTrustBundle } from "@kontourai/surface";
import type { PortableExtractionResultEnvelope } from "@kontourai/traverse";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { parseFieldworkTask, traverseTask } from "../src/contracts.js";
import { classifyGroundingRefusals, disputeContestedClaims, extractionCoverageSummary, projectAttestedReviewedProjection, reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { inspectionExport } from "../src/inspection.js";
import { recheckFieldwork, sameProposals } from "../src/recheck.js";
import { readRun, readRunMetadata } from "../src/run-store.js";
import type { FieldworkRuntimeBinding } from "../src/runtime-contracts.js";
import { MAX_FAILURE_MESSAGE_CHARS, runtimeMessageIsPlain } from "../src/runtime-session.js";
import { openRun, readRunView } from "../src/server.js";
import { apiFetch, tempRoot } from "./helpers.js";
import { chunkCappedRun, realRunCopy, realRunTaskPath, typedFieldRun } from "./helpers/real-run.js";

/*
 * Defects found by running the published 0.13.0 end to end with a real model
 * runtime (fieldwork#170). Each test uses the shape that run wrote: the real
 * stored run itself, or a new run through the same Traverse, Survey, Lookout
 * and Dispatch code with a scripted runtime in the model's place.
 */

const exec = promisify(execFile);

interface CliResult { readonly code: number; readonly stdout: string }

/** Run the CLI as a child process and report its exit status rather than throwing on a non-zero one. */
async function cli(...args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown };
    if (typeof failed.code !== "number" || typeof failed.stdout !== "string") throw error;
    return { code: failed.code, stdout: failed.stdout };
  }
}

interface RefusedEntry { fieldPath: string; gaps: string[]; schemaMatch?: string }

async function acceptEverything(runDirectory: string): Promise<void> {
  const service = await openRun(runDirectory);
  try {
    const view = await apiFetch(service, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = view.review.snapshot as unknown as ReviewQueueSessionState;
    const decisionsByItemName = Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"]));
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName } as never);
    const saved = await apiFetch(service, "/api/v1/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 }),
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally { await service.close(); }
}

// --- 1. A repeated recheck of an unchanged source --------------------------

/** A six-field prior run over a stored capture, and a recheck of it that finds the source unchanged. */
async function unchangedRecheckSetup(label: string) {
  const root = await tempRoot(label);
  const taskPath = await realRunTaskPath(root);
  const task = parseFieldworkTask(JSON.parse(await readFile(taskPath, "utf8")));
  const source: LookoutSource = {
    id: "spec-source", url: "https://example.invalid/spec", kind: "web-page", cadenceHint: "manual", renderPolicy: "never",
    targetSchema: traverseTask(task).targetSchema as LookoutSource extends { targetSchema: infer Schema } ? Schema : never,
  };
  const body = [
    "Title: Harbor Telemetry Exchange Format", "Publication date: 2026-03-14", "Status: Internal Draft",
    "Version: 2.1", "First editor: Priya Raman", "Editor count: 3",
  ].join("\n");
  const snapshot: Snapshot = {
    sourceId: source.id, url: source.url, status: 200, fetchedAt: "2026-07-23T10:00:00.000Z", body,
    bodyHash: createHash("sha256").update(body).digest("hex"), headers: { "content-type": "text/plain; charset=utf-8" },
  };
  const snapshotRoot = join(root, "snapshots");
  await createFilesystemSnapshotStore({ root: snapshotRoot }).put(snapshot);
  const snapshotRef = buildSnapshotSourceRef(snapshot);
  const prior = await runFieldwork({ taskPath, snapshotRef, snapshotRoot, root: join(root, "runs") });
  const observationRoot = join(root, "observations");
  const unchanged: CheckResult = {
    sourceId: source.id, sourceUrl: source.url, checkedAt: "2026-07-23T11:00:00.000Z", warnings: [],
    kind: "unchanged-304", snapshotRef,
  };
  const recheck = () => recheckFieldwork({
    source, priorRunDirectory: prior.runDirectory, taskPath, root: join(root, "runs"), observationRoot, snapshotRoot,
    now: () => "2026-07-23T10:01:00.000Z", acquisition: { check: async () => unchanged },
  });
  return { source, prior, observationRoot, recheck };
}

test("an identical recheck of an unchanged source succeeds a second and a third time", async () => {
  const { source, prior, observationRoot, recheck } = await unchangedRecheckSetup("recheck-repeat");

  const first = await recheck();
  assert.equal(first.classification, "unchanged-source");

  // What made the second recheck fail: the store Lookout wrote holds the same
  // six proposals in a different order from the envelope's.
  const stored = await createObservationStore({ root: observationRoot }).loadLatest(source.id);
  assert.ok(stored.ok && stored.value);
  const envelopeOrder = (await readRun(prior.runDirectory)).envelope.result.proposals.map((proposal) => proposal.fieldPath);
  const storedOrder = stored.value.proposals.map((proposal) => proposal.fieldPath);
  assert.equal(envelopeOrder.length, 6);
  assert.deepEqual([...storedOrder].sort(), [...envelopeOrder].sort());
  assert.notDeepEqual(storedOrder, envelopeOrder, "the stored order has to differ from the envelope's, or this test proves nothing");

  const second = await recheck();
  const third = await recheck();
  assert.equal(second.classification, "unchanged-source");
  assert.equal(third.classification, "unchanged-source");
  assert.deepEqual(third.priorObservation, first.priorObservation);
});

test("a stored observation whose proposals differ from the prior run's by one value is still a conflict", async () => {
  // Order-insensitive must not mean anything goes: the same six proposals with
  // one value changed, stored through Lookout's own store, is not this run's
  // observation, whatever order it is in.
  const { source, prior, observationRoot, recheck } = await unchangedRecheckSetup("recheck-differs");
  const { envelope } = await readRun(prior.runDirectory);
  const proposals = envelope.result.proposals.map((proposal) =>
    proposal.fieldPath === "doc.firstEditor" ? { ...proposal, candidateValue: "Someone Else" } : proposal);
  assert.equal(proposals.filter((proposal, index) => proposal !== envelope.result.proposals[index]).length, 1);
  const observation: ProposalSetObservation = {
    sourceId: source.id, snapshotRef: envelope.source.snapshotRef!, observedAt: envelope.result.extractedAt,
    proposals: proposals as ProposalSetObservation["proposals"],
  };
  const committed = await createObservationStore({ root: observationRoot }).commit({
    observation, recordedAt: observation.observedAt,
    check: { checkedAt: observation.observedAt, resultKind: "changed", currentSnapshotRef: observation.snapshotRef },
  }, null);
  assert.ok(committed.ok, JSON.stringify(committed));
  await assert.rejects(recheck, (error: Error & { code?: string }) => {
    assert.equal(error.code, "RECHECK_CONFLICT", error.message);
    assert.match(error.message, /Stored source continuity does not match the selected prior run/);
    return true;
  });
});

test("stored and envelope proposals are compared as a multiset: order is ignored, repetition is not", () => {
  const proposal = (fieldPath: string) => ({
    fieldPath, candidateValue: fieldPath, extractor: "x",
    provenance: { excerpt: fieldPath, locator: "chars:0-1" },
  });
  const [a, b] = [proposal("a"), proposal("b")];
  assert.equal(sameProposals([b, a], [a, b]), true);
  assert.equal(sameProposals([a, a, b], [a, b]), false, "a repeated proposal is a different observation");
  assert.equal(sameProposals([a, b], [a, b, b]), false);
  assert.equal(sameProposals([a], [b]), false);
});

// --- 2. A value that does not satisfy its field's schema --------------------

/** Surface's own trust report over the exported bundle: what a bundle-only consumer reads. */
function surfaceReport(exported: Awaited<ReturnType<typeof reviewedExport>>): string {
  return formatTrustReportSummary(buildTrustReport(validateTrustBundle(exported.bundle)));
}

test("the real run's number-as-text claim is exported with its grounding refused, and the CLI exits 3", async () => {
  const runDirectory = await realRunCopy("export");
  const exported = await reviewedExport(runDirectory);
  const claim = exported.bundle.claims.find((entry) => entry.fieldOrBehavior === "doc.versionNumber");
  assert.equal(claim?.value, "2.1", "the value the real model returned for a number field is text");
  const scope = exported.reviewRound as { groundingRefused?: RefusedEntry[]; groundingUnchecked?: RefusedEntry[] };
  assert.deepEqual(scope.groundingRefused?.map((entry) => entry.fieldPath), ["doc.versionNumber"]);
  assert.ok(scope.groundingRefused[0]!.gaps.includes("schema-mismatch"), JSON.stringify(scope.groundingRefused));
  assert.equal(scope.groundingRefused[0]!.schemaMatch, "type-mismatch");
  assert.equal(scope.groundingUnchecked, undefined, "a value of the wrong type is not merely unchecked");

  // The bundle on its own must say so too: Surface's report used to print
  // "Claims: 6 (verified: 6)" and "Disputed: none" over this export.
  assert.equal(claim?.status, "disputed");
  const report = surfaceReport(exported);
  assert.match(report, /^Claims: 6 \(verified: 5, disputed: 1\)$/m);
  assert.match(report, new RegExp(`^Disputed: ${claim!.id.replaceAll(".", "\\.")}$`, "m"));
  const disputes = exported.bundle.events.filter((event) => event.status === "disputed");
  assert.deepEqual(disputes.map((event) => [event.claimId, event.notes]), [[claim!.id, "Reviewed grounding refused: schema-mismatch (type-mismatch)."]]);

  // Surface takes a claim's newest event, so the dispute has to be stamped
  // after the reviewer's even when that event is later than this host's clock.
  const bundle = exported.bundle as unknown as ReturnType<typeof validateTrustBundle>;
  const future = "2999-01-01T00:00:00.000Z";
  const undisputed = validateTrustBundle({
    ...bundle,
    claims: bundle.claims.map((entry) => entry.id === claim!.id ? { ...entry, status: "verified" as const } : entry),
    events: bundle.events.filter((event) => event.status !== "disputed")
      .map((event) => event.claimId === claim!.id ? { ...event, createdAt: future, ...(event.verifiedAt ? { verifiedAt: future } : {}) } : event),
  });
  assert.match(formatTrustReportSummary(buildTrustReport(undisputed)), /^Claims: 6 \(verified: 6\)$/m);
  const redisputed = disputeContestedClaims(undisputed, scope.groundingRefused as never, new Date("2026-01-01T00:00:00.000Z"));
  assert.match(formatTrustReportSummary(buildTrustReport(redisputed)), /^Claims: 6 \(verified: 5, disputed: 1\)$/m);

  const outputPath = join(runDirectory, "..", "export.json");
  const result = await cli("export", runDirectory, "--output", outputPath, "--json");
  assert.equal(result.code, 3, result.stdout);
  const summary = JSON.parse(result.stdout) as { groundingRefused?: RefusedEntry[]; groundingUnchecked?: unknown };
  assert.deepEqual(summary.groundingRefused?.map((entry) => entry.fieldPath), ["doc.versionNumber"]);
  assert.equal(summary.groundingUnchecked, undefined);
});

test("a mistyped value with no Traverse record is still refused, from Surface's own derivation", async () => {
  // A proposal an older Traverse wrote carries no `evidenceMatch`. Surface
  // still derives `invalid` structural trust for text in a number field,
  // which is a different finding from the `unvalidated` it reports for a
  // value it cannot check.
  const projection = projectAttestedReviewedProjection(await readRunMetadata(await realRunCopy("no-record")));
  const items = structuredClone(projection.items) as typeof projection.items;
  for (const item of items) {
    for (const candidate of item.spec.candidates) {
      delete (candidate.producer?.["survey.kontourai.io/extraction-envelope"] as { evidenceMatch?: unknown }).evidenceMatch;
    }
  }
  const { refused, unchecked } = classifyGroundingRefusals({ ...projection, items });
  assert.deepEqual(refused.map((entry) => entry.fieldPath), ["doc.versionNumber"]);
  assert.ok(refused[0]!.gaps.includes("schema-mismatch"), JSON.stringify(refused));
  assert.equal(refused[0]!.schemaMatch, undefined, "no Traverse record, so none is reported");
  assert.deepEqual(unchecked, []);
});

test("the review item for a mistyped value is flagged in the run view the workbench and API clients read", async () => {
  const view = await readRunView(await realRunCopy("view"));
  // The exact record Traverse wrote on the real proposal, as Survey carries it.
  const item = (view.review.snapshot as unknown as ReviewQueueSessionState).items.find((entry) => entry.spec.target === "doc.versionNumber")!;
  const producer = item.spec.candidates[0]!.producer?.["survey.kontourai.io/extraction-envelope"] as { evidenceMatch?: unknown };
  assert.deepEqual(producer.evidenceMatch, {
    checkerVersion: "evidence-match-v4", schema: "type-mismatch", tokenBoundary: true, valueInExcerpt: "not-evaluated",
  });
  assert.deepEqual(view.review.schemaMismatches, [{
    reviewItemName: item.metadata.name, fieldPath: "doc.versionNumber", candidateId: item.spec.candidates[0]!.id,
    schema: "type-mismatch", valueType: "number",
  }]);
});

test("a date in the document's own wording is refused too, where Surface alone reports no gap", async () => {
  const runDirectory = await typedFieldRun("date");
  const proposals = (await readRun(runDirectory)).envelope.result.proposals;
  const byPath = <T extends readonly unknown[]>(rows: T[]): T[] => rows.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  assert.deepEqual(
    byPath(proposals.map((proposal) => [proposal.fieldPath, proposal.candidateValue, proposal.evidenceMatch?.schema] as const)),
    [["doc.publicationDate", "14/03/2026", "format-invalid"], ["doc.title", "Harbor Telemetry Exchange Format", "ok"], ["doc.versionNumber", "2.10", "type-mismatch"]],
  );
  const view = await readRunView(runDirectory);
  assert.deepEqual(byPath((view.review.schemaMismatches ?? []).map((entry) => [entry.fieldPath, entry.schema, entry.valueType] as const)), [
    ["doc.publicationDate", "format-invalid", "date"], ["doc.versionNumber", "type-mismatch", "number"],
  ]);

  await acceptEverything(runDirectory);
  const exported = await reviewedExport(runDirectory);
  const scope = exported.reviewRound as { groundingRefused?: RefusedEntry[]; groundingUnchecked?: unknown };
  const byField = new Map((scope.groundingRefused ?? []).map((entry) => [entry.fieldPath, entry]));
  assert.deepEqual([...byField.keys()].sort(), ["doc.publicationDate", "doc.versionNumber"]);
  // Surface accepts any string as a date, so this gap is Fieldwork's alone.
  assert.deepEqual(byField.get("doc.publicationDate")!.gaps, ["schema-mismatch"]);
  assert.equal(byField.get("doc.publicationDate")!.schemaMatch, "format-invalid");
  assert.ok(byField.get("doc.versionNumber")!.gaps.includes("schema-mismatch"));
  assert.equal(scope.groundingUnchecked, undefined);
  const result = await cli("export", runDirectory, "--output", join(runDirectory, "..", "export.json"), "--json");
  assert.equal(result.code, 3, result.stdout);
});

test("a date mismatch on its own is disputed in the bundle and refuses the grounding evaluation", async () => {
  // The version is a real number here, so the date is the only mismatch, and
  // Surface on its own evaluates this round as `allowed`.
  const runDirectory = await typedFieldRun("date-only", { versionAsNumber: true });
  assert.deepEqual((await readRunView(runDirectory)).review.schemaMismatches?.map((entry) => entry.fieldPath), ["doc.publicationDate"]);
  await acceptEverything(runDirectory);
  const exported = await reviewedExport(runDirectory);
  const date = exported.bundle.claims.find((entry) => entry.fieldOrBehavior === "doc.publicationDate")!;
  assert.equal(date.value, "14/03/2026");
  assert.equal(date.status, "disputed");
  const report = surfaceReport(exported);
  assert.match(report, /^Claims: 3 \(verified: 2, disputed: 1\)$/m);
  assert.match(report, new RegExp(`^Disputed: ${date.id.replaceAll(".", "\\.")}$`, "m"));
  assert.deepEqual(
    exported.bundle.events.filter((event) => event.status === "disputed").map((event) => event.notes),
    ["Reviewed grounding refused: schema-mismatch (format-invalid)."],
  );
  const grounding = exported.reviewedGrounding as { outcome: string; gaps: { kind: string; claimId: string; schemaMatch?: string }[] };
  assert.equal(grounding.outcome, "refused");
  assert.deepEqual(grounding.gaps.map((gap) => [gap.kind, gap.claimId, gap.schemaMatch]), [["schema-mismatch", date.id, "format-invalid"]]);
});

test("a plain decimal and a written date arrive in the field's type, and the inspection says values were rewritten", async () => {
  // The real model's answers to the real memo: "2.1" for a number field and
  // "14 March 2026" for a date field. Traverse rewrites both without loss, so
  // neither is a mismatch; "2.10" and "14/03/2026" above still are.
  const runDirectory = await typedFieldRun("rewritten", { rewritable: true });
  const { proposals, warningClassifications } = (await readRun(runDirectory)).envelope.result;
  const row = (fieldPath: string) => {
    const proposal = proposals.find((entry) => entry.fieldPath === fieldPath)!;
    return [proposal.candidateValue, proposal.evidenceMatch?.schema, proposal.evidenceMatch?.valueInExcerpt, proposal.provenance.excerpt];
  };
  assert.deepEqual(row("doc.versionNumber"), [2.1, "ok", "match", "This document describes version 2.1 of the format."]);
  assert.deepEqual(row("doc.publicationDate"), ["2026-03-14", "ok", "match", "This specification was published on 14 March 2026."]);
  assert.equal((await readRunView(runDirectory)).review.schemaMismatches, undefined);

  // One classification per rewritten value, where `fieldwork inspect` lists the run's warnings.
  const rewritten = [{ category: "normalization", code: "proposal-normalization" }, { category: "normalization", code: "proposal-normalization" }];
  assert.deepEqual(warningClassifications, rewritten);
  const inspected = JSON.parse(await inspectionExport(runDirectory)) as { spec: { extraction: { warningClassifications: unknown } } };
  assert.deepEqual(inspected.spec.extraction.warningClassifications, rewritten);

  await acceptEverything(runDirectory);
  const exported = await reviewedExport(runDirectory);
  assert.deepEqual(
    exported.bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.value, claim.status]).sort(),
    [["doc.publicationDate", "2026-03-14", "verified"], ["doc.title", "Harbor Telemetry Exchange Format", "verified"], ["doc.versionNumber", 2.1, "verified"]],
  );
  const scope = exported.reviewRound as { groundingRefused?: unknown; groundingUnchecked?: unknown };
  assert.equal(scope.groundingRefused, undefined);
  assert.equal(scope.groundingUnchecked, undefined);
});

// --- 3. Chunks a chunk cap dropped ------------------------------------------

test("the real capped run's coverage counts the five chunks the cap dropped", () => {
  // `result.coverage`, `result.partial` and `result.outcome` exactly as the
  // real `--max-chunks 2` run of a 55,000-character page stored them: the
  // prepared artifact kept 6,851 characters and coverage lists nothing else.
  const envelope = { result: {
    outcome: { reason: "max-chunks", status: "partial" },
    partial: { completedChunks: 2, reason: "max-chunks", remainingChunks: 5 },
    coverage: [{ chunk: 2, end: 4448, start: 0, status: "complete" }, { chunk: 1, end: 6851, start: 4450, status: "complete" }],
  } } as unknown as PortableExtractionResultEnvelope;
  assert.deepEqual(extractionCoverageSummary(envelope), { chunkCount: 7, incompleteChunkCount: 5, droppedChunkCount: 5 });
});

test("a web page capped at two chunks is served and inspected with its dropped chunks counted", async () => {
  const runDirectory = await chunkCappedRun("html", "html");
  const { coverage, partial } = (await readRun(runDirectory)).envelope.result;
  // The real shape: coverage lists only the kept chunks, both complete.
  assert.deepEqual(coverage?.map((entry) => entry.status), ["complete", "complete"]);
  assert.ok(partial && partial.remainingChunks > 0);
  const dropped = partial.remainingChunks;

  const view = await readRunView(runDirectory);
  assert.deepEqual(view.extraction.outcome, { status: "partial", reason: "max-chunks" });
  assert.deepEqual(view.extraction.coverage, { chunkCount: 2 + dropped, incompleteChunkCount: dropped, droppedChunkCount: dropped });

  const inspected = JSON.parse(await inspectionExport(runDirectory)) as {
    spec: { extraction: { partial?: unknown; coverageSummary?: unknown } };
  };
  assert.deepEqual(inspected.spec.extraction.partial, partial);
  assert.deepEqual(inspected.spec.extraction.coverageSummary, view.extraction.coverage);
});

test("capped chunks that coverage already lists as unread are not counted twice", async () => {
  const runDirectory = await chunkCappedRun("text", "text");
  const { coverage, partial } = (await readRun(runDirectory)).envelope.result;
  const unread = coverage!.filter((entry) => entry.status === "unread" && entry.reason === "not-dispatched").length;
  assert.ok(unread > 0 && partial?.remainingChunks === unread, JSON.stringify({ coverage, partial }));
  assert.deepEqual((await readRunView(runDirectory)).extraction.coverage, { chunkCount: 2 + unread, incompleteChunkCount: unread });
});

// --- 4. A removed queue item ------------------------------------------------

test("a queue item removed from a decided run is refused with the typed binding error", async () => {
  const runDirectory = await realRunCopy("removed-item");
  const runPath = join(runDirectory, "run.json");
  const stored = JSON.parse(await readFile(runPath, "utf8")) as { review: { snapshot: { activeItemName: string; items: { metadata: { name: string } }[] } } };
  // As the real check did: drop one decided item and leave everything else.
  const removed = stored.review.snapshot.items.findIndex((item) => item.metadata.name !== stored.review.snapshot.activeItemName);
  assert.ok(removed >= 0);
  stored.review.snapshot.items.splice(removed, 1);
  await writeFile(runPath, JSON.stringify(stored, null, 2));

  await assert.rejects(() => readRun(runDirectory), (error: Error & { code?: string }) => {
    assert.equal(error.code, "REVIEW_BINDING_BROKEN", error.message);
    return true;
  });
  const result = await cli("export", runDirectory, "--output", join(runDirectory, "..", "export.json"), "--json");
  assert.equal(result.code, 1);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "REVIEW_BINDING_BROKEN");
});

// --- 5. A runtime that cannot answer ----------------------------------------

function failingRuntime(message: string): FieldworkRuntimeBinding {
  const runtime: ModelRuntime = {
    id: "fake:out-of-quota",
    capabilities: () => ({
      structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native",
      streaming: false, abort: true, usage: true,
    }),
    invoke: async () => { throw new ModelInvocationError("RATE_LIMITED", message, true); },
  };
  return { role: "fieldwork-extraction", candidates: [{ id: "scripted", runtime }], budget: { maxAttempts: 3, maxElapsedMs: 60_000 } };
}

async function runFailure(message: string): Promise<Error & { code?: string; runtimeFailure?: unknown }> {
  const root = await tempRoot("runtime-failure");
  try {
    await runFieldwork({ taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt", root, runtime: failingRuntime(message) });
  } catch (error) { return error as Error & { code?: string }; }
  throw new Error("the run was expected to fail");
}

test("a runtime that fails every attempt reports the last attempt's code and message, not only that it was exhausted", async () => {
  const error = await runFailure("Weekly usage limit reached");
  assert.equal(error.code, "RUNTIME_INVOCATION_FAILED");
  assert.match(error.message, /Dispatch invocation ended with exhausted/);
  assert.match(error.message, /runtime fake:out-of-quota failed with RATE_LIMITED: Weekly usage limit reached/);
  assert.match(error.message, /1 failed attempt recorded/);
  assert.deepEqual(error.runtimeFailure, { runtimeId: "fake:out-of-quota", code: "RATE_LIMITED" });
});

test("a runtime message is shown only when it reads as plain prose; the code and runtime id always are", async () => {
  const home = ["", "Users", "someone"].join("/");
  // Built from parts so no scanner reads a credential shape in this file.
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join(".");
  const assign = (name: string, value: string, separator = "=") => `${name}${separator}${value}`;
  const withheld = [
    // Not in the safe character set: paths, URLs, assignments, headers, query strings.
    "could not read /var/run/model/state.json",
    `ENOENT:${home}/.codex/auth.json`,
    "open ~/.config/model/auth.json failed",
    "EPERM:C:\\Users\\someone\\auth.json",
    "read //server/share/model.json failed",
    "%USERPROFILE%\\model\\auth.json is missing",
    "someone/.ssh/id_rsa is unreadable",
    "request to https://alice:opensesame@host.example failed",
    `rejected ${jwt}`,
    assign("ZAI_API_KEY", "abc"),
    assign("pass" + "word", " hunter2", ":"),
    `Authorization: Basic ${Buffer.from("alice:opensesame").toString("base64")}`,
    "GET failed for upload?sig=abc",
    assign("cookie sess" + "ion", "abc"),
    // Safe characters, but a credential-like word.
    "Invalid API key provided: abcd1234",
    "abcd1234efgh is not a valid key",
    "the bearer was rejected",
    "sig abc was rejected",
    // Safe characters and words, but a value-shaped word.
    "rejected abcd1234efgh5678",
    `rejected ${"9f86d081".repeat(8)}`,
    // A long opaque run with no digit in it.
    `rejected ${"AbCdEfGh".repeat(3)}`,
    // Too long.
    `limit ${"reached ".repeat(40)}`,
  ];
  for (const message of withheld) {
    assert.equal(runtimeMessageIsPlain(message), false, message);
    const error = await runFailure(message);
    assert.equal(error.code, "RUNTIME_INVOCATION_FAILED");
    assert.equal(
      error.message,
      "Dispatch invocation ended with exhausted. The last attempt on runtime fake:out-of-quota failed with RATE_LIMITED (details withheld) (1 failed attempt recorded).",
      message,
    );
    assert.deepEqual(error.runtimeFailure, { runtimeId: "fake:out-of-quota", code: "RATE_LIMITED" });
  }
  assert.equal(MAX_FAILURE_MESSAGE_CHARS, 200);

  for (const plain of [
    "exit code 1", "rate limit exceeded, retry after 30s", "model not found: gpt-x",
    "You have hit your weekly limit, resets Oct 4", "the signal was lost (design limit)", "x".repeat(23),
    `${"reached ".repeat(24)}limit.`,
  ]) {
    assert.ok(plain.length <= 200);
    const error = await runFailure(plain);
    assert.ok(error.message.includes(`failed with RATE_LIMITED: ${plain} (1 failed attempt recorded).`), error.message);
  }

  // A runtime that gave no message is not reported as one that was withheld.
  const silent = await runFailure("");
  assert.match(silent.message, /failed with RATE_LIMITED \(1 failed attempt recorded\)\.$/);
});
