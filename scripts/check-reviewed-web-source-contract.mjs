import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// `reviewed-web-source-contract` is deliberately browser-consumable.  Keep
// its emitted declaration graph independent of Fieldwork's native facade and
// the Forage, Lookout, and Surface owner implementations.
const entry = resolve("dist/reviewed-web-source-contract.d.ts");
if (!existsSync(entry)) throw new Error("Build reviewed-web-source-contract before checking its declaration graph");
const pending = [entry];
const seen = new Set();
const forbidden = /(?:^|\/)node:|@kontourai\/(?:fieldwork|forage|lookout|surface)|(?:reviewed-web-source|host-application|run-store|source-check-receipts)/;
while (pending.length > 0) {
  const file = pending.pop();
  if (!file || seen.has(file)) continue;
  seen.add(file);
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (forbidden.test(specifier)) throw new Error(`Browser contract declaration graph leaks ${specifier} through ${file}`);
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".d.ts"));
      if (!existsSync(target)) throw new Error(`Missing declaration dependency ${specifier} from ${file}`);
      pending.push(target);
    }
  }
}
console.log(`reviewed web source browser declaration graph passed for ${seen.size} files`);
