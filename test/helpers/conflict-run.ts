import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFieldwork } from "../../src/fieldwork.js";
import { tempRoot } from "../helpers.js";

/**
 * A run whose `record.status` is a conflict: two chunks state it as "Active"
 * and "Paused". `record.alpha` is a second, uncontested field.
 */
export async function conflictRun(label: string): Promise<string> {
  const root = await tempRoot(`conflict-${label}`);
  const task = JSON.parse(await readFile("examples/generic/task.json", "utf8"));
  const [statusProjection] = task.spec.projections;
  task.spec.traverse.targetSchema.push({ path: "record.alpha", type: "string", inferenceType: "explicit" });
  task.spec.projections.push({ ...statusProjection, fieldPath: "record.alpha", pattern: "alpha: ([^\\n]+)" });
  const taskPath = join(root, "task.json");
  const sourcePath = join(root, "source.txt");
  await writeFile(taskPath, JSON.stringify(task));
  // Enough filler that Traverse prepares two chunks, each with its own Status line.
  await writeFile(sourcePath, `alpha: alpha-value\nStatus: Active\n${"filler line of text.\n".repeat(700)}Status: Paused\n`);
  return (await runFieldwork({ taskPath, sourcePath, root })).runDirectory;
}

