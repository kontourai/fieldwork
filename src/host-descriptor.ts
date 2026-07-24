/** Versioned discovery metadata for the executable host application contract. */
export const fieldworkHostDescriptor = {
  apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkApplicationDescriptor",
  spec: {
    commands: ["fieldwork run --task <file> --source <file>", "fieldwork open <run> [--port]", "fieldwork export <run> --output <file>"],
    resources: {
      selectedRun: "fieldwork-run:v1:<task>:<digest>",
      reviewedOutput: "Surface-validated reviewed JSON returned to the caller",
    },
    launch: {
      standalone: true,
      loopbackUrl: "http://127.0.0.1:<port>",
      presentationInjection: true,
    },
    lifecycleEvents: ["run-created", "run-opened", "review-event-persisted", "review-exported", "run-closed"],
  }
} as const;
