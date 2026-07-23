# Deterministic fixture oracles

Status: accepted

The offline deterministic provider is a fixture adapter, not a model simulator. It orders proposals by their actual prepared-source spans. Equal starts sort by span end and then field path, so declaration order cannot change replay order. String and date captures remain literal strings, enum captures must be declared values, and boolean, number, array, and object captures must be unambiguous JSON literals of the declared runtime type. Invalid JSON or a mismatched runtime type fails the run closed.

Each projected field path is unique within a task. Fieldwork rejects duplicates before a run is created so proposal-to-claim ownership cannot depend on declaration order or first-match lookup.

The comparison-neutral corpus fixtures each retain a checked-in `oracle.json`. Tests compare the production `run → Survey events → reviewed export` result to those independent frozen expectations. The oracle pins ordered typed proposals, exact excerpts and `chars:` locators, non-overlap, occurrence resolution, provider and replay metadata, diagnostics and warnings posture, and reviewed claims with their evidence. A source, task, Traverse, Survey, or Surface change that alters these public observations therefore requires an intentional oracle review.

The CI corpus remains bounded groundwork over one prepared source per run. The repeated-section fixture is not proof of chunking or full long-document behavior, and the two-section fixture is not multiple-document batching. Out-of-order model emissions, chunk-boundary recovery, multipass extraction, full long-document and multiple-document lanes, and live-provider parity remain follow-up scope in [issue #9](https://github.com/kontourai/fieldwork/issues/9).
