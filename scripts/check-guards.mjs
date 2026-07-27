/**
 * Fault injection for the reviewed-export integrity guards.
 *
 * A guard that no test fails without is decoration, and a passing suite cannot
 * tell you which of the two you have. This removes each guard in turn and
 * requires the suite that covers it to go red, so the claim "these checks are
 * load-bearing" is reproducible rather than reported.
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
    from: "    snapshotHash: input.snapshotHash,",
    to: "    snapshotHash: hashReviewSessionSnapshot(snapshot),",
    suite: "test/core.test.ts",
  },
  {
    label: "session record re-derives the digest instead of carrying it",
    file: "src/fieldwork.ts",
    from: "    snapshotHash: run.review.snapshotHash, eventCount, updatedAt: run.createdAt,",
    to: "    snapshotHash: reviewSnapshotHash(run.review.snapshot), eventCount, updatedAt: run.createdAt,",
    suite: "test/core.test.ts",
  },
  {
    label: "no attestation against the extraction envelope",
    file: "src/fieldwork.ts",
    from: "  assertReviewedQueueIsAttested(items, canonicalReviewItems(imported.reviewItems, stored.envelope), stored.envelope);",
    to: "",
    suite: "test/core.test.ts",
  },
  {
    label: "envelope-derived items accepted without comparison",
    file: "src/fieldwork.ts",
    from: "    if (canonicalJson(found) !== canonicalJson(item)) {",
    to: "    if (false) {",
    suite: "test/core.test.ts",
  },
  {
    label: "queue may omit an extracted item (set equality, forward)",
    file: "src/fieldwork.ts",
    from: "    if (!found) throw unattested(`review item ${name} is in this run's extraction but missing from its reviewed queue`);",
    to: "    if (!found) continue;",
    suite: "test/core.test.ts",
  },
  {
    label: "queue may carry an item the extraction never produced (set equality, reverse)",
    file: "src/fieldwork.ts",
    from: "    if (!attesting.has(name)) {",
    to: "    if (false) {",
    suite: "test/core.test.ts",
  },
  {
    label: "an emptied queue is allowed to certify nothing",
    file: "src/fieldwork.ts",
    from: "  if (items.length === 0 && envelope.result.proposals.length > 0) {",
    to: "  if (false) {",
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
  let caught = false;
  try {
    execFileSync("npx", ["tsx", "--test", injection.suite], { stdio: "pipe" });
  } catch {
    caught = true;
  }
  execFileSync("git", ["checkout", "--", injection.file]);
  if (digest(injection.file) !== before) {
    throw new Error(`${injection.file} was not restored byte-identically after injection "${injection.label}"`);
  }
  results.push({ ...injection, outcome: caught ? "caught" : "NOT CAUGHT" });
}

for (const result of results) {
  console.log(`${result.outcome === "caught" ? "  caught" : `> ${result.outcome}`}  ${result.label}  (${result.suite})`);
}
const failures = results.filter((result) => result.outcome !== "caught");
console.log(`\n${results.length - failures.length}/${results.length} injections caught`);
if (failures.length > 0) {
  throw new Error(`${failures.length} injection(s) not caught by the suite that should cover them`);
}
