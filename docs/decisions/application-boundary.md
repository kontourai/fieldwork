# Application boundary

Status: accepted

Fieldwork is an application because it owns a runnable CLI, capability-protected loopback server, composed browser experience, run storage, input limits, and disclosure posture. It consumes Traverse, Survey, Surface, and `@kontourai/ui` public contracts rather than defining their domain or visual semantics. Survey supplies the Review Workbench, event persistence callback/status, and extraction inspector; `@kontourai/ui` supplies the shell primitives and theme tokens.

The loopback binding is necessary but insufficient authority. Fieldwork also validates Host, requires a per-launch capability for APIs, requires same-origin JSON mutations, bounds bodies/timeouts, and emits stable path-free public errors. The browser reconciles from server-owned state after rejected stale persistence.

The versioned application facade and static discovery descriptor are the host
boundary. A host may launch a run, open and read the selected run, subscribe to
content-free lifecycle events, inject bounded presentation and absolute HTTP(S)
navigation, receive the Surface-validated reviewed output, and close its owned
sessions. The standalone CLI and loopback browser use the same operations.
Presentation is data rather than executable markup, and lifecycle records carry
only the portable run resource, revision, and event count. Fieldwork has no host
runtime dependency and hosts do not import its internal storage or Survey
adapters. Lifecycle observers are advisory: a throwing observer cannot roll
back or relabel an authoritative run or Survey persistence operation.

Framing remains denied by default. An embedding host must provide its exact
HTTP(S) origin when opening a run; Fieldwork validates and normalizes that
origin before adding only that source to `frame-ancestors`. Paths, credentials,
query strings, fragments, and non-HTTP schemes are rejected. The capability,
Host, mutation-Origin, and other loopback protections remain independent.
