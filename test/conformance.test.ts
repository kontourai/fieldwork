import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { buildReviewSessionEvents, type ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { openRun } from "../src/server.js";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import { apiFetch, tempRoot } from "./helpers.js";

interface SourceSpec {
  schemaVersion: 1;
  sourceLength: number;
  segments: Array<{ offset: number; text: string }>;
  fillers: Array<{ from: number; to: number; character: string }>;
}

interface EnvelopeProposal {
  fieldPath: string;
  candidateValue: unknown;
  provenance: {
    excerpt: string;
    locator: string;
    occurrence: unknown;
  };
}

test("long-input corpus keeps exact reviewed grounding across default chunk overlap", async () => {
  const fixtureRoot = "conformance/long-input";
  const spec = JSON.parse(await readFile(`${fixtureRoot}/source-spec.json`, "utf8")) as SourceSpec;
  const oracle = JSON.parse(await readFile(`${fixtureRoot}/oracle.json`, "utf8"));
  const source = sourceFromSpec(spec);
  const root = await tempRoot("long-input-conformance");
  const sourcePath = join(root, "source.txt");
  await writeFile(sourcePath, source);

  const run = await runFieldwork({
    taskPath: `${fixtureRoot}/task.json`,
    sourcePath,
    root
  });
  const prepared = await readFile(join(run.runDirectory, "prepared.txt"), "utf8");
  const envelope = JSON.parse(await readFile(join(run.runDirectory, "extraction-envelope.json"), "utf8"));

  assert.equal(prepared, source);
  assert.equal(envelope.result.providerCalls, 3, "fixture must cross three default Traverse chunks");
  assert.equal(
    envelope.result.proposals.filter((proposal: EnvelopeProposal) =>
      proposal.fieldPath === "document.boundary").length,
    1,
    "overlap-region proposal must be deduplicated"
  );

  const server = await openRun(run.runDirectory);
  try {
    const initial = await apiFetch(server, "/api/v1/run")
      .then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
    const decisionsByItemName = Object.fromEntries(
      snapshot.items.map((item) => [item.metadata.name, "accept-proposed"])
    );
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 })
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await server.close();
  }

  const bundle = await reviewedExport(run.runDirectory);
  const evidenceByClaim = new Map(bundle.evidence.map((evidence) => [evidence.claimId, evidence]));
  const observed = {
    schemaVersion: 1,
    fixture: "long-input",
    source: {
      length: source.length,
      sha256: createHash("sha256").update(source).digest("hex")
    },
    run: {
      resource: run.runResource
    },
    execution: {
      provider: envelope.result.provider,
      model: envelope.result.model,
      providerCalls: envelope.result.providerCalls,
      totalTokensUsed: envelope.result.totalTokensUsed,
      taskDigest: envelope.result.taskDigest,
      exampleDigests: envelope.result.exampleDigests,
      outcome: envelope.result.outcome,
      warnings: envelope.result.warnings ?? [],
      rawKeys: Object.keys(envelope.result.raw).sort()
    },
    proposals: envelope.result.proposals.map((proposal: EnvelopeProposal) => ({
      fieldPath: proposal.fieldPath,
      value: proposal.candidateValue,
      excerpt: proposal.provenance.excerpt,
      locator: proposal.provenance.locator,
      occurrence: proposal.provenance.occurrence
    })),
    reviewedClaims: bundle.claims.map((claim) => {
      const evidence = evidenceByClaim.get(claim.id);
      assert.ok(evidence, `${claim.fieldOrBehavior} must retain reviewed evidence`);
      return {
        fieldPath: claim.fieldOrBehavior,
        value: claim.value,
        excerpt: evidence.excerptOrSummary,
        locator: evidence.sourceLocator
      };
    })
  };

  assert.deepEqual(observed, oracle);
});

function sourceFromSpec(spec: SourceSpec): string {
  assert.equal(spec.schemaVersion, 1);
  const characters = Array<string | undefined>(spec.sourceLength);
  for (const filler of spec.fillers) {
    assert.equal(filler.character.length, 1, "filler must be one UTF-16 code unit");
    assert.ok(filler.from >= 0 && filler.from <= filler.to && filler.to <= spec.sourceLength);
    for (let index = filler.from; index < filler.to; index += 1) {
      assert.equal(characters[index], undefined, `source spec overlaps at ${index}`);
      characters[index] = filler.character;
    }
  }
  for (const segment of spec.segments) {
    assert.ok(segment.offset >= 0 && segment.offset + segment.text.length <= spec.sourceLength);
    for (let index = 0; index < segment.text.length; index += 1) {
      const target = segment.offset + index;
      assert.equal(characters[target], undefined, `source spec overlaps at ${target}`);
      characters[target] = segment.text[index];
    }
  }
  const gap = characters.findIndex((character) => character === undefined);
  assert.equal(gap, -1, `source spec leaves a gap at ${gap}`);
  return characters.join("");
}
