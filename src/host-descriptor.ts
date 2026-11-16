/** Versioned discovery metadata for the executable host application contract. */
export const fieldworkHostDescriptor = {
  apiVersion: "fieldwork.kontourai.io/v1", kind: "FieldworkApplicationDescriptor",
  spec: {
    commands: ["fieldwork run --task <file> --source <file>", "fieldwork open <run> [--port] [--reviewer <id> [--reviewer-kind human|agent]]", "fieldwork export <run> --output <file>", "fieldwork upgrade <run> --to-profile v2"],
    resources: {
      selectedRun: "fieldwork-run:v1:<task>:<digest>",
      reviewedOutput: "ReviewedExport v1 or v2 with a Surface-validated bundle",
    },
    launch: {
      standalone: true,
      loopbackUrl: "http://127.0.0.1:<port>",
      presentationInjection: true,
    },
    lifecycleEvents: ["run-created", "run-opened", "review-event-persisted", "review-exported", "run-closed"],
  }
} as const;
