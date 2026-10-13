# Fieldwork contributor guidance

Read `CONTEXT.md` and the decision records before changing production behavior. Preserve Traverse proposal/locator semantics, Survey review semantics, and Surface validation; do not introduce parallel status or trust schemas. Keep source text local and portable records free of credentials, machine paths, private configuration, and raw diagnostics. Run the relevant `npm` checks and `veritas readiness --working-tree` before handoff.

Docs are published with docs-kit: `corpus.json` lists the published docs and MCP topics, `npm run docs:check` is the gate, and when you change code a document `covers` (`src/cli.ts` is covered by `docs/reference.md`), update that document.

For UI, brand, and product copy, follow `DESIGN.md` in `@kontourai/ui` (https://github.com/kontourai/ui/blob/main/DESIGN.md; also shipped at `node_modules/@kontourai/ui/DESIGN.md` from 1.13.0). Style with the `--k-*` tokens instead of hard-coded colors, spacing, radii or font sizes, and don't resolve anything the doc marks OPEN.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
