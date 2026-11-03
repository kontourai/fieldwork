---
status: current
subject: Reviewed export as a memory source
decided: 2026-11-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/fieldwork/issues/205
  - kind: doc
    ref: docs/memory-source.md
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/1574
---

# Reviewed export as a memory source

Fieldwork exports a projection of its reviewed export into the Knowledge Kit's memory claim schema and owns nothing past that export.

- **A projection, not a new truth.** The claims carry the Surface status, Survey decision and Fieldwork attribution the export already holds, verbatim, in `origin`. Fieldwork adds no schema, review disposition or trust status.
- **The Kit owns the schema.** Fieldwork references it, pinned to a Kit commit, and does not copy it. Its ids are the Kit's identity rule, checked against ids the Kit itself produced.
- **Review posture rides the claim's `posture`, as `stated` or `proposed`, and nothing else.** The Kit keeps posture apart from review state, but its posture is part of claim identity and the only review-bearing field the closed schema offers. A `verified` claim is `stated`. A `disputed` claim and an undecided item are `proposed`. A rejected claim and every other exclusion are listed, not remembered.
- **Source authority stays per source.** `source.ref` and `speaker` are the run's snapshot, so distinct snapshots never share an identity, and the projection takes one export.
- **Accumulation and storage are not here.** Surface owns what is current in a slot; Corpus Store owns storage.
