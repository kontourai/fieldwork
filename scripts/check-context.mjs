// CONTEXT.md is the vocabulary contributors and decision records draw on
// (AGENTS.md: read it before changing behavior). Corpus's manifest check fails
// when the file is missing, because corpus.json lists it, but passes an empty
// one; this keeps the empty case red in the required lane.
import { existsSync, readFileSync } from "node:fs";

if (!existsSync("CONTEXT.md") || !readFileSync("CONTEXT.md", "utf8").trim()) {
  throw new Error("Required context artifact missing or empty: CONTEXT.md");
}
console.log("context documentation passed");
