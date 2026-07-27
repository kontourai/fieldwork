/**
 * Fault injection for the reviewed-export integrity guards.
 *
 * A guard that no test fails without is decoration, and a passing suite cannot
 * tell you which of the two you have. This removes each guard in turn and
 * requires the suite that covers it to go red, so the claim "these checks are
 * load-bearing" is reproducible rather than reported.
 *
 * Since fieldwork#79 the whole-extraction rule — set equality both ways,
 * per-item byte equality, and the empty-queue refusal — lives in Survey
 * (`assertReviewQueueAgainstExtractionImport`, survey#213), so the injections
 * that used to remove those guards line by line now attack the call sites:
 * the dispatcher that invokes Survey, the self-agreement shape Survey exists
 * to rule out, and the stored-digest origin of the queue binding. One entry is
 * the inverse — a PINNED REFUSAL that rewrites the emptied-queue test to
 * expect success and requires the suite to go red, so Survey's empty-queue
 * refusal is proven to reach this repo's export rather than assumed to.
 *
 * Compilation is judged separately from the suite (rule adopted from Survey's
 * own matrix): an injection that does not compile is a matrix FAILURE
 * (`DOES NOT COMPILE — wrong attribution`), never a catch — the "catch" would
 * belong to the compiler, not a test. A reported catch always means a test
 * went red.
 *
 * Not part of `npm run verify`: it edits tracked source and restores it from
 * git, so it needs a clean tree and must not race a build. Run it directly.
 *
 * A pattern that no longer matches fails the run. That is deliberate — it means
 * a guard was moved or removed, and the harness should not quietly skip it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const injections = [
  {
    label: "queue binding re-derived from the queue it checks",
    file: "src/survey-persistence.ts",
    from: "      snapshotHash,",
    to: "      snapshotHash: hashReviewQueueSnapshot(snapshot),",
    suite: "test/core.test.ts",
  },
  {
    label: "stored binding never handed to Survey's derivation",
    file: "src/survey-persistence.ts",
    from: "      ...(binding === undefined ? {} : { binding }),",
    to: "",
    suite: "test/core.test.ts",
  },
  {
    label: "session record re-derives the digest instead of carrying it",
    file: "src/fieldwork.ts",
    from: "    snapshotHash: run.review.snapshotHash, eventCount, updatedAt: run.createdAt,",
    to: "    snapshotHash: hashReviewQueueSnapshot(run.review.snapshot), eventCount, updatedAt: run.createdAt,",
    suite: "test/core.test.ts",
  },
  {
    label: "no attestation against the extraction envelope",
    file: "src/fieldwork.ts",
    from: "  assertReviewedQueueIsAttested(items, imported, stored.envelope);",
    to: "",
    suite: "test/core.test.ts",
  },
  {
    label: "whole-extraction cross-check handed the extraction's own items (self-agreement)",
    file: "src/fieldwork.ts",
    from: "      assertReviewQueueAgainstExtractionImport(withoutCompatExtractedAt(items, envelope), imported);",
    to: "      assertReviewQueueAgainstExtractionImport(withoutCompatExtractedAt(canonicalReviewItems(imported.reviewItems, envelope), envelope), imported);",
    suite: "test/core.test.ts",
  },
  {
    label: "pinned refusal: an emptied queue must stay refused at export (Survey's empty-queue rule reaches this repo)",
    file: "test/core.test.ts",
    from: "  await assert.rejects(() => reviewedExport(run.runDirectory), refusal(/stored queue is empty/));",
    to: "  await reviewedExport(run.runDirectory);",
    suite: "test/core.test.ts",
  },
  {
    label: "recheck evidence side trusted from its label alone",
    file: "src/fieldwork.ts",
    from: "      || round.evidenceObservation !== side\n      || (candidate.role === \"current\" ? side !== \"prior\" : side !== \"current\")) {",
    to: "      || false) {",
    suite: "test/recheck.test.ts",
  },
  {
    label: "recheck current-observation candidates unchecked",
    file: "src/fieldwork.ts",
    from: "    if (side === \"prior\") continue;",
    to: "    if (side) continue;",
    suite: "test/recheck.test.ts",
  },
  {
    label: "ungrounded advice hardcoded to keep-current",
    file: "src/fieldwork.ts",
    from: "  const grounded = item.spec.candidates.filter((candidate) => candidate.locator?.locator);",
    to: "  const grounded = [];",
    suite: "test/recheck.test.ts",
  },
  {
    label: "export projects a fresh envelope import again (fieldwork#59)",
    file: "src/fieldwork.ts",
    from: "  const canonical = projectCanonicalReview(stored.run.runResource, items, applied.results);",
    to: "  const canonical = projectCanonicalReview(stored.run.runResource, canonicalReviewItems(imported.reviewItems, stored.envelope), applied.results);",
    suite: "test/recheck.test.ts",
  },
];

const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (dirty) {
  throw new Error(`check:guards restores source from git, so it needs a clean tree. Uncommitted:\n${dirty}`);
}

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const results = [];

for (const injection of injections) {
  const before = digest(injection.file);
  const source = readFileSync(injection.file, "utf8");
  if (!source.includes(injection.from)) {
    results.push({ ...injection, outcome: "PATTERN MISSING" });
    continue;
  }
  writeFileSync(injection.file, source.replace(injection.from, injection.to));
  // Compile and test are judged SEPARATELY (Survey's rule). A guard whose
  // removal only breaks the build is not covered by any test — counting a
  // compile failure as "caught" is the decorative-attribution lie this matrix
  // exists to rule out. Only a red run of the targeted suite counts.
  let compiles = true;
  try {
    execFileSync("npx", ["tsc", "--noEmit"], { stdio: "pipe" });
  } catch {
    compiles = false;
  }
  let caught = false;
  if (compiles) {
    try {
      execFileSync("npx", ["tsx", "--test", injection.suite], { stdio: "pipe" });
    } catch {
      caught = true;
    }
  }
  execFileSync("git", ["checkout", "--", injection.file]);
  if (digest(injection.file) !== before) {
    throw new Error(`${injection.file} was not restored byte-identically after injection "${injection.label}"`);
  }
  results.push({
    ...injection,
    outcome: !compiles ? "DOES NOT COMPILE (wrong attribution)" : caught ? "caught" : "NOT CAUGHT",
  });
}

for (const result of results) {
  console.log(`${result.outcome === "caught" ? "  caught" : `> ${result.outcome}`}  ${result.label}  (${result.suite})`);
}
const failures = results.filter((result) => result.outcome !== "caught");
console.log(`\n${results.length - failures.length}/${results.length} injections caught`);
if (failures.length > 0) {
  throw new Error(`${failures.length} injection(s) not caught by a red run of the suite that should cover them (a non-compiling injection is wrong attribution, not a catch)`);
}
