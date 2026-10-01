/**
 * What Traverse's evidence checker recorded about a proposed value and its
 * field's declared type. Traverse writes `evidenceMatch.schema` on each
 * proposal and Survey copies it onto the review candidate it builds, so this
 * reads a recorded fact; it never re-derives one. It has no Node imports: the
 * workbench, the run view and the reviewed export all read it from here.
 */
const SURVEY_EXTRACTION_ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";

/** A value that does not satisfy the field's declared schema, and which rule it failed. */
export interface SchemaMismatch {
  /** Traverse's `evidenceMatch.schema`: `type-mismatch`, `enum-mismatch` or `format-invalid`. */
  readonly schema: string;
  /** The field's declared type, when the candidate records one. */
  readonly valueType?: string;
}

/** A review item whose proposed value does not satisfy its field's declared schema. */
export interface ReviewItemSchemaMismatch extends SchemaMismatch {
  readonly reviewItemName: string;
  readonly fieldPath: string;
  readonly candidateId: string;
}

interface CandidateLike {
  readonly id: string;
  readonly producer?: Readonly<Record<string, unknown>>;
}

interface ReviewItemLike {
  readonly metadata: { readonly name: string };
  readonly spec: { readonly target: string; readonly candidates: readonly CandidateLike[] };
}

/**
 * The schema mismatch recorded for a candidate, or undefined when its value
 * matched (`ok`) or no check was recorded. A candidate without the record,
 * such as a recheck round's, is not reported: nothing here says it mismatched.
 */
export function candidateSchemaMismatch(candidate: Pick<CandidateLike, "producer">): SchemaMismatch | undefined {
  const producer = candidate.producer?.[SURVEY_EXTRACTION_ENVELOPE_PRODUCER] as {
    evidenceMatch?: { schema?: unknown };
    valueType?: { type?: unknown };
  } | undefined;
  const schema = producer?.evidenceMatch?.schema;
  if (typeof schema !== "string" || schema === "ok") return undefined;
  const valueType = producer?.valueType?.type;
  return { schema, ...(typeof valueType === "string" ? { valueType } : {}) };
}

/** Every candidate in the queue whose proposed value does not satisfy its field's schema. */
export function reviewItemSchemaMismatches(items: readonly ReviewItemLike[]): ReviewItemSchemaMismatch[] {
  return items.flatMap((item) => item.spec.candidates.flatMap((candidate) => {
    const mismatch = candidateSchemaMismatch(candidate);
    return mismatch ? [{ reviewItemName: item.metadata.name, fieldPath: item.spec.target, candidateId: candidate.id, ...mismatch }] : [];
  }));
}

const TYPE_NOUNS: Record<string, string> = {
  number: "a number", boolean: "true or false", date: "a date", string: "text", enum: "one of the allowed values",
  array: "a list", object: "an object",
};

function describeValue(value: unknown): string {
  if (value === null) return "empty";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "true or false";
  return "an object";
}

/** What is wrong with the value, as a phrase that follows it: `text, not a number`. */
export function schemaMismatchPhrase(mismatch: SchemaMismatch, value: unknown): string {
  const expected = mismatch.valueType === undefined ? undefined : TYPE_NOUNS[mismatch.valueType];
  if (mismatch.schema === "type-mismatch") {
    return expected ? `${describeValue(value)}, not ${expected}` : "not the field's declared type";
  }
  if (mismatch.schema === "enum-mismatch") return "not one of the field's allowed values";
  if (mismatch.schema === "format-invalid") {
    return mismatch.valueType === "date" ? "not a YYYY-MM-DD date" : "not in the field's declared format";
  }
  return "does not match the field's declared schema";
}
