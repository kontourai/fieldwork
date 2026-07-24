# Runtime binding is launch policy

Fieldwork tasks describe extraction and review meaning. They do not name a model provider, credential, local executable, fallback order, or spending policy. The same task can therefore run with the offline fixture, a local Relay harness profile, a Datum-resolved SDK target, or a host-supplied Relay runtime without editing durable task semantics.

Runtime candidates are adapted by Relay and composed through Dispatch before Traverse sees an extraction provider. Dispatch owns candidate order, retry and fallback, durable authorization-wide attempt/token/cost capacity, elapsed time, and request-content-free terminal receipts. Traverse still owns the extraction prompt, structured schema, proposal interpretation, exact excerpt verification, and prepared-artifact grounding. Datum resolves configured SDK roles but does not invoke them. Conduit remains the separate host lifecycle and asset-installation boundary.

Runtime selection participates in the run identity so two executions cannot silently reuse one another. Stored execution identity includes only role, candidate/runtime identifiers, structured-output and output-limit fidelity, limits, and optional public rate assumptions. Credentials stay constructor-only. Dispatch receipts omit request content and raw runtime diagnostics, and Fieldwork applies its portable disclosure scan before invocation and persistence.

Native structured output is required by default. OpenCode's prompted structured-output mode requires an explicit launch opt-in and remains labeled `prompted`; it is not represented as native schema enforcement. Direct SDK launch currently supports Datum's `anthropic-compatible` kind. Other provider kinds remain available through a host-supplied Relay runtime rather than a Fieldwork-specific SDK adapter.

Every runtime-mode run uses Dispatch's file authorization ledger under the caller-selected Fieldwork root. The stable run identity derives the authorization identity, while a deterministic sequence plus Relay request digest derives each invocation identity. Dispatch reserves worst-case capacity before provider launch and settles measured usage only after success. Failed or interrupted launches remain conservatively reserved; an identical invocation after restart fails closed instead of replaying. The portable run stores reservation identities and states, never the ledger path.

Attempt capacity is always durable. A token or estimated-cost ceiling additionally requires caller-declared worst-case total tokens per attempt. An estimated-cost ceiling also requires an explicit rate and native output-token-limit fidelity for every candidate, allowing Dispatch to reserve worst-case cost before launch. Provider-reported cost and estimated cost remain distinct. Elapsed time is still enforced from session receipts and is not represented as crash-safe capacity.

Bounded chunk concurrency, requested physical-batch size, and the Traverse-provider-operation ceiling are runtime launch policy and participate in execution identity. A Traverse provider operation can still use multiple Dispatch fallback attempts, so the durable attempt authorization separately caps model launches. Traverse may receive completions out of order, but it owns source-ordered proposal normalization; Fieldwork orders stored Dispatch receipts by deterministic invocation sequence so scheduling cannot destabilize the run artifact. Provider-operation ceilings and cancellation preserve Traverse's typed partial state. A failed chunk retains its classified provider failure and conservative Dispatch reservation while successful chunks continue into review.

Physical batching is exposed only when the selected primary Relay runtime
declares a positive batch bound and implements the native operation. Traverse
groups logical chunks within that bound. Dispatch reserves every launched item
before the physical call, retains capacity-exhausted items positionally without
launching them, settles successful siblings, and applies ordinary fallback to
retryable item failures. Stored receipts retain the shared content-free
operation identity and native item index/count plus each request and
authorization identity. If the runtime capability is absent or inconsistent,
the facade omits batching and Traverse uses its single-invocation path;
concurrency is never relabeled as a provider batch.
