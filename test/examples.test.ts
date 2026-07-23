import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { buildReviewSessionEvents } from "@kontourai/survey/review-workbench";
import { reviewedExport, runFieldwork } from "../src/fieldwork.js";
import { openRun } from "../src/server.js";
import type { FieldworkRunViewV1 } from "../src/api-contracts.js";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";
import { apiFetch, tempRoot } from "./helpers.js";

const examples = [
  ["vendor-obligations", 2],
  ["incident-postmortem", 4],
  ["grant-eligibility", 4],
  ["ordered-relationships", 7],
  ["medication-review", 6],
  ["multilingual-alignment", 4],
  ["schema-first", 6],
  ["occurrence-resolution", 5],
  ["document-sections", 4],
  ["long-form-groundwork", 2]
] as const;

const oracleExamples = new Set([
  "ordered-relationships",
  "medication-review",
  "multilingual-alignment",
  "schema-first",
  "occurrence-resolution",
  "document-sections",
  "long-form-groundwork"
]);

interface CorpusProposal {
  fieldPath: string;
  candidateValue: unknown;
  valueType: string;
  inferenceType: string;
  confidence: number;
  extractor: string;
  enumValues?: string[];
  provenance: {
    excerpt: string;
    locator: string;
    occurrence: {
      resolverVersion: string;
      count: number;
      selected: { index: number; start: number; end: number };
      selection: string;
      hintUsed: boolean;
      ambiguous: boolean;
    };
  };
}

interface CorpusEnvelope {
  result: {
    provider: string;
    model: string;
    providerCalls: number;
    totalTokensUsed: number;
    taskDigest: string;
    exampleDigests: string[];
    raw: Record<string, unknown>;
    outcome: Record<string, unknown>;
    warnings?: unknown[];
    proposals: CorpusProposal[];
  };
}

function normalizeCorpusResult(
  fixture: string,
  envelope: CorpusEnvelope,
  bundle: Awaited<ReturnType<typeof reviewedExport>>
): unknown {
  const evidenceByClaim = new Map(bundle.evidence.map((evidence) => [evidence.claimId, evidence]));
  const spans = envelope.result.proposals.map((proposal) => {
    const match = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
    assert.ok(match, `${fixture} ${proposal.fieldPath} must use a chars locator`);
    return { start: Number(match[1]), end: Number(match[2]) };
  });
  const nonOverlapping = spans.every((span, index) =>
    index === 0 || spans[index - 1].end <= span.start
  );
  const reviewedRows = bundle.claims.map((claim) => {
    const evidence = evidenceByClaim.get(claim.id);
    assert.ok(evidence, `${fixture} ${claim.fieldOrBehavior} must retain reviewed evidence`);
    const producer = evidence.metadata?.producer?.["survey.kontourai.io/extraction-envelope"];
    assert.ok(producer, `${fixture} ${claim.fieldOrBehavior} must retain replay metadata`);
    return {
      defaults: {
        claimType: claim.claimType,
        status: claim.status,
        evidenceType: evidence.evidenceType,
        method: evidence.method,
        collectedBy: evidence.collectedBy,
        provider: producer.provider,
        providerCalls: producer.attempt.providerCalls,
        outcome: producer.outcome
      },
      subjectType: claim.subjectType,
      subjectId: claim.subjectId,
      facet: claim.facet,
      fieldPath: claim.fieldOrBehavior,
      value: claim.value,
      impactLevel: claim.impactLevel,
      evidence: {
        locator: evidence.sourceLocator,
        excerpt: evidence.excerptOrSummary,
        proposalIndex: producer.proposalIndex,
        valueType: producer.valueType
      }
    };
  });
  return {
    schemaVersion: 1,
    fixture,
    replay: {
      provider: envelope.result.provider,
      model: envelope.result.model,
      providerCalls: envelope.result.providerCalls,
      totalTokensUsed: envelope.result.totalTokensUsed,
      taskDigest: envelope.result.taskDigest,
      exampleDigests: envelope.result.exampleDigests,
      rawKeys: Object.keys(envelope.result.raw).sort()
    },
    diagnostics: {
      outcome: envelope.result.outcome,
      warnings: envelope.result.warnings ?? [],
      rawDiagnosticsIncluded: Object.keys(envelope.result.raw).some((key) => key !== "tokensUsed")
    },
    ordering: { nonOverlapping },
    proposalDefaults: {
      inferenceType: uniform(envelope.result.proposals.map((proposal) => proposal.inferenceType)),
      confidence: uniform(envelope.result.proposals.map((proposal) => proposal.confidence)),
      extractor: uniform(envelope.result.proposals.map((proposal) => proposal.extractor))
    },
    proposals: envelope.result.proposals.map((proposal) => ({
      fieldPath: proposal.fieldPath,
      value: proposal.candidateValue,
      valueType: proposal.valueType,
      ...(proposal.enumValues ? { enumValues: proposal.enumValues } : {}),
      excerpt: proposal.provenance.excerpt,
      locator: proposal.provenance.locator,
      occurrence: proposal.provenance.occurrence
    })),
    reviewedDefaults: {
      claimType: uniform(reviewedRows.map((row) => row.defaults.claimType)),
      status: uniform(reviewedRows.map((row) => row.defaults.status)),
      evidenceType: uniform(reviewedRows.map((row) => row.defaults.evidenceType)),
      method: uniform(reviewedRows.map((row) => row.defaults.method)),
      collectedBy: uniform(reviewedRows.map((row) => row.defaults.collectedBy)),
      provider: uniform(reviewedRows.map((row) => row.defaults.provider)),
      providerCalls: uniform(reviewedRows.map((row) => row.defaults.providerCalls)),
      outcome: uniform(reviewedRows.map((row) => row.defaults.outcome))
    },
    reviewedClaims: reviewedRows.map(({ defaults: _defaults, ...row }) => row)
  };
}

function uniform(values: unknown[]): unknown {
  const distinct = new Map(values.map((value) => [JSON.stringify(value), value]));
  return distinct.size === 1 ? distinct.values().next().value : values;
}

for (const [name, count] of examples) {
  test(`${name} runs through extraction, Survey events, and reviewed export`, async () => {
    const taskPath = `examples/${name}/task.json`;
    const result = await runFieldwork({ taskPath, sourcePath: `examples/${name}/source.txt`, root: await tempRoot(name) });
    assert.equal(result.proposalCount, count);
    const server = await openRun(result.runDirectory);
    try {
      const initial = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
      const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
      const decisionsByItemName = Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"]));
      const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName });
      const saved = await apiFetch(server, "/api/v1/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 })
      }).then((response) => response.json()) as { ok: boolean };
      assert.equal(saved.ok, true);
    } finally { await server.close(); }
    const bundle = await reviewedExport(result.runDirectory);
    const task = JSON.parse(await readFile(taskPath, "utf8"));
    for (const projection of task.spec.projections) {
      assert.ok(bundle.claims.some((claim) =>
        claim.subjectId === projection.claim.subjectId
        && claim.facet === projection.claim.facet
        && claim.claimType === projection.claim.claimType
        && claim.fieldOrBehavior === projection.fieldPath
      ), `missing expected reviewed claim for ${projection.fieldPath}`);
    }
    const envelope = JSON.parse(await readFile(`${result.runDirectory}/extraction-envelope.json`, "utf8"));
    if (oracleExamples.has(name)) {
      const oracle = JSON.parse(await readFile(`examples/${name}/oracle.json`, "utf8"));
      assert.deepEqual(normalizeCorpusResult(name, envelope, bundle), oracle);
    }
  });
}

test("deterministic extraction sorts proposals by source offset instead of task declaration order", async () => {
  const root = await tempRoot("reversed-order");
  const task = JSON.parse(await readFile("examples/ordered-relationships/task.json", "utf8"));
  task.spec.projections = [...task.spec.projections].reverse();
  const taskPath = `${root}/reversed-task.json`;
  await writeFile(taskPath, JSON.stringify(task));
  const result = await runFieldwork({ taskPath, sourcePath: "examples/ordered-relationships/source.txt", root });
  const envelope = JSON.parse(await readFile(`${result.runDirectory}/extraction-envelope.json`, "utf8"));
  assert.deepEqual(envelope.result.proposals.map((proposal: { fieldPath: string }) => proposal.fieldPath), [
    "person.primary",
    "person.primaryRole",
    "organization.name",
    "relationship.summary",
    "person.secondary",
    "person.secondaryRole",
    "organization.attribute"
  ]);
});

test("equal source spans use field path as a declaration-independent deterministic tie break", async () => {
  const root = await tempRoot("equal-span-order");
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  task.metadata.name = "equal-span-order";
  task.spec.traverse.targetSchema = [
    { path: "tie.alpha", type: "string", inferenceType: "explicit" },
    { path: "tie.zeta", type: "string", inferenceType: "explicit" }
  ];
  task.spec.projections = [
    { ...task.spec.projections[0], fieldPath: "tie.zeta" },
    { ...task.spec.projections[0], fieldPath: "tie.alpha" }
  ];
  const taskPath = `${root}/task.json`;
  await writeFile(taskPath, JSON.stringify(task));
  const result = await runFieldwork({ taskPath, sourcePath: "examples/generic/source.txt", root });
  const envelope = JSON.parse(await readFile(`${result.runDirectory}/extraction-envelope.json`, "utf8"));
  assert.deepEqual(
    envelope.result.proposals.map((proposal: { fieldPath: string }) => proposal.fieldPath),
    ["tie.alpha", "tie.zeta"]
  );
});

test("deterministic fixture values retain declared runtime types through reviewed export", async () => {
  const root = await tempRoot("typed-values");
  const sourcePath = `${root}/source.txt`;
  const taskPath = `${root}/task.json`;
  await writeFile(sourcePath, [
    "Boolean: true",
    "Number: 12.5",
    "Array: [\"alpha\",2,false]",
    "Object: {\"nested\":{\"ok\":true},\"count\":2}",
    "String: unchanged",
    "Date: 2026-07-23",
    "Enum: high",
    ""
  ].join("\n"));
  const fields = [
    ["typed.boolean", "boolean", "Boolean: ([^\\n]+)"],
    ["typed.number", "number", "Number: ([^\\n]+)"],
    ["typed.array", "array", "Array: ([^\\n]+)"],
    ["typed.object", "object", "Object: ([^\\n]+)"],
    ["typed.string", "string", "String: ([^\\n]+)"],
    ["typed.date", "date", "Date: ([^\\n]+)"],
    ["typed.enum", "enum", "Enum: ([^\\n]+)"]
  ] as const;
  const task = {
    apiVersion: "fieldwork.kontourai.io/v1alpha1",
    kind: "FieldworkTask",
    metadata: { name: "typed-values" },
    spec: {
      traverse: {
        version: "1",
        targetSchema: fields.map(([path, type]) => ({
          path, type, inferenceType: "explicit",
          ...(type === "enum" ? { enumValues: ["low", "high"] } : {})
        }))
      },
      projections: fields.map(([fieldPath, , pattern]) => ({
        fieldPath,
        pattern,
        claim: {
          subjectType: "typed-fixture",
          subjectId: "typed-values",
          facet: "runtime-type",
          claimType: "field",
          impactLevel: "medium"
        }
      }))
    }
  };
  await writeFile(taskPath, JSON.stringify(task));
  const result = await runFieldwork({ taskPath, sourcePath, root });
  const server = await openRun(result.runDirectory);
  try {
    const initial = await apiFetch(server, "/api/v1/run").then((response) => response.json()) as FieldworkRunViewV1;
    const snapshot = initial.review.snapshot as unknown as ReviewQueueSessionState;
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: Object.fromEntries(snapshot.items.map((item) => [item.metadata.name, "accept-proposed"]))
    });
    const saved = await apiFetch(server, "/api/v1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, expectedEventCount: 0, expectedRevision: 0 })
    }).then((response) => response.json()) as { ok: boolean };
    assert.equal(saved.ok, true);
  } finally {
    await server.close();
  }
  const bundle = await reviewedExport(result.runDirectory);
  assert.deepEqual(
    Object.fromEntries(bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.value])),
    {
      "typed.boolean": true,
      "typed.number": 12.5,
      "typed.array": ["alpha", 2, false],
      "typed.object": { nested: { ok: true }, count: 2 },
      "typed.string": "unchanged",
      "typed.date": "2026-07-23",
      "typed.enum": "high"
    }
  );
});

test("deterministic non-string fixture values fail closed on invalid JSON or runtime type", async () => {
  const invalidCases = [
    ["boolean", "truthy"],
    ["number", "12px"],
    ["array", "{}"],
    ["object", "[]"]
  ] as const;
  for (const [type, raw] of invalidCases) {
    const root = await tempRoot(`invalid-${type}`);
    const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
    task.metadata.name = `invalid-${type}`;
    task.spec.traverse.targetSchema[0].type = type;
    const taskPath = `${root}/task.json`;
    const sourcePath = `${root}/source.txt`;
    await writeFile(taskPath, JSON.stringify(task));
    await writeFile(sourcePath, `Status: ${raw}\n`);
    await assert.rejects(
      () => runFieldwork({ taskPath, sourcePath, root }),
      new RegExp(`invalid ${type} JSON fixture value`)
    );
  }
});
