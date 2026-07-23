# Application boundary

Status: accepted

Fieldwork is an application because it owns a runnable CLI, capability-protected loopback server, composed browser experience, run storage, input limits, and disclosure posture. It consumes Traverse, Survey, Surface, and `@kontourai/ui` public contracts rather than defining their domain or visual semantics. Survey supplies the Review Workbench, event persistence callback/status, and extraction inspector; `@kontourai/ui` supplies the shell primitives and theme tokens.

The loopback binding is necessary but insufficient authority. Fieldwork also validates Host, requires a per-launch capability for APIs, requires same-origin JSON mutations, bounds bodies/timeouts, and emits stable path-free public errors. The browser reconciles from server-owned state after rejected stale persistence. A future host may use the descriptor exported by this package, but Fieldwork has no host runtime dependency.
