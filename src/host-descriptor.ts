/** A static host seam; Fieldwork does not require or import a particular host runtime. */
export const fieldworkHostDescriptor = {
  apiVersion: "fieldwork.kontourai.io/v1alpha1", kind: "FieldworkApplicationDescriptor",
  spec: {
    commands: ["fieldwork run --task <file> --source <file>", "fieldwork open <run> [--port]", "fieldwork export <run> --output <file>"],
    launch: { loopbackUrl: "http://127.0.0.1:<port>", selectedRunResource: "fieldwork-run:v1:<task>:<digest>" },
    lifecycleEvents: ["run-created", "review-event-persisted", "review-exported"],
    reviewedOutputReference: "A caller-selected output file from fieldwork export"
  }
} as const;
