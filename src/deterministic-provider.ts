import type { ExtractionProvider, ProviderExtractionInput, ProviderExtractionOutput } from "@kontourai/traverse";
import { deterministicPattern, type FieldworkTask } from "./contracts.js";

/** Offline provider for fixtures and repeatable local review; it never accesses credentials or the network. */
export function createDeterministicProvider(task: FieldworkTask): ExtractionProvider {
  return {
    name: "fieldwork-deterministic-v1",
    capabilities: { supported: ["structured-output", "exact-excerpts", "task-specifications", "usage", "warnings"] },
    async extract(input: ProviderExtractionInput): Promise<ProviderExtractionOutput> {
      const proposals = task.spec.projections.flatMap((projection) => {
        const match = deterministicPattern(projection.pattern, projection.fieldPath).exec(input.content);
        if (!match?.[1]) return [];
        const field = input.targetSchema.find((candidate) => candidate.path === projection.fieldPath);
        if (!field) throw new Error(`Projection ${projection.fieldPath} is not declared by the Traverse task`);
        const candidateValue = decodeDeterministicValue(match[1].trim(), field);
        return [{
          fieldPath: projection.fieldPath,
          candidateValue, confidence: 1, extractor: "fieldwork-deterministic-v1",
          fieldworkSort: { start: match.index, end: match.index + match[0].length },
          // Traverse verifies this excerpt and replaces any provisional locator.
          provenance: { excerpt: match[0], locator: "chars:0-0" }
        }];
      }).sort((left, right) =>
        left.fieldworkSort.start - right.fieldworkSort.start
        || left.fieldworkSort.end - right.fieldworkSort.end
        || compareCodeUnits(left.fieldPath, right.fieldPath)
      ).map(({ fieldworkSort: _fieldworkSort, ...proposal }) => proposal);
      return { proposals, raw: { response: "offline deterministic extraction", model: "fieldwork-deterministic-v1", tokensUsed: 0 } };
    }
  };
}

function decodeDeterministicValue(raw: string, field: ProviderExtractionInput["targetSchema"][number]): unknown {
  switch (field.type) {
    case "array": {
      const value = parseFixtureJson(raw, field.path, "array");
      if (Array.isArray(value)) return value;
      throw invalidFixtureType(field.path, "array");
    }
    case "boolean": {
      const value = parseFixtureJson(raw, field.path, "boolean");
      if (typeof value === "boolean") return value;
      throw invalidFixtureType(field.path, "boolean");
    }
    case "enum":
      if (field.enumValues?.includes(raw)) return raw;
      throw new Error(`Projection ${field.path} produced an invalid enum fixture value`);
    case "number": {
      const value = parseFixtureJson(raw, field.path, "number");
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw invalidFixtureType(field.path, "number");
    }
    case "object": {
      const value = parseFixtureJson(raw, field.path, "object");
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
      throw invalidFixtureType(field.path, "object");
    }
    case "date":
    case "string":
      return raw;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseFixtureJson(raw: string, fieldPath: string, expectedType: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidFixtureType(fieldPath, expectedType);
  }
}

function invalidFixtureType(fieldPath: string, expectedType: string): Error {
  return new Error(`Projection ${fieldPath} produced an invalid ${expectedType} JSON fixture value`);
}
