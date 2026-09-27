# Fieldwork contributor guidance

Read `CONTEXT.md` and the decision records before changing production behavior. Preserve Traverse proposal/locator semantics, Survey review semantics, and Surface validation; do not introduce parallel status or trust schemas. Keep source text local and portable records free of credentials, machine paths, private configuration, and raw diagnostics. Run the relevant `npm` checks and `veritas readiness --working-tree` before handoff.

For UI, brand, and product copy, follow `DESIGN.md` in `@kontourai/ui` (https://github.com/kontourai/ui/blob/main/DESIGN.md; also shipped at `node_modules/@kontourai/ui/DESIGN.md` from 1.13.0). Style with the `--k-*` tokens instead of hard-coded colors, spacing, radii or font sizes, and don't resolve anything the doc marks OPEN.
