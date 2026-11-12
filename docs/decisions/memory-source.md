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
- **Review posture rides beside the claim as `arrival` (`reviewed` or `proposed`), never in the claim's `posture`.** Every claim is `stated`. The Kit keeps posture apart from review state, and its conflict routing skips `proposed` claims, so writing review state into posture would let an unreviewed assertion escape conflict detection. `arrival` is derived from the export's own facts: a `verified` claim is `reviewed`; a `disputed` claim and an undecided item are `proposed`; a rejected claim and every other exclusion are listed, not remembered. It is not part of the claim, so a claim keeps its id when a reviewer decides it.
- **The export has to agree with itself.** A bundle claim whose value or status disagrees with the Survey decision its evidence carries is refused, not mapped.
- **Source authority stays per source.** `source.ref` and `speaker` are the run's snapshot, so distinct snapshots never share an identity, and the projection takes one export (an export carrying two sources' records is refused).
- **`arrival` is provenance, not a promotion signal.** The "only a human promotes" gate lives in the Kit (flow-agents#1574), and Fieldwork does not repeat it. The Kit promotes a routed claim only on a decision whose host-attested `spec.reviewerKind` is `human`. Fieldwork uses Survey 8.4.0 but still writes no host-attested `spec.reviewerKind`, so its decisions remain `unattested` to the Kit. The v1 reviewed export omits Survey's newly inferred reviewer-kind metadata when `reviewerKindInferred` is true, preserving historical export bytes; the original decisions and authority fields remain intact. The memory projection never infers a kind and carries Fieldwork's own actor kind only as the attribution it is. Attesting the kind remains a separate change.
- **Accumulation and storage are not here.** Surface owns what is current in a slot; Corpus Store owns storage.
