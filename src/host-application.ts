import {
  fieldworkLifecycleEventSchema,
  type FieldworkHostPresentationV1,
  type FieldworkLifecycleEventType,
  type FieldworkLifecycleEventV1,
  type FieldworkLifecycleListener,
  type OpenRunService,
  type ReviewedExportV1,
  type RunOptions,
  type FieldworkRunResult,
} from "./api-contracts.js";
import { runFieldwork, reviewedExport } from "./fieldwork.js";
import { fieldworkHostDescriptor } from "./host-descriptor.js";
import { openRun, readRunView } from "./server.js";
import { ReviewedWebSourceReader, type ReviewedWebSourceInspection, type ReviewedWebSourceOwner, type ReviewedWebSourceRefs, type ReviewedWebSourceResult } from "./reviewed-web-source.js";

export interface FieldworkApplicationOpenOptions {
  readonly runDirectory: string;
  readonly port?: number;
  readonly presentation?: FieldworkHostPresentationV1;
  readonly embeddingOrigin?: string;
}
export interface FieldworkApplicationOptions {
  readonly reviewedWebSourceOwner?: ReviewedWebSourceOwner;
}

export interface FieldworkApplication {
  readonly descriptor: typeof fieldworkHostDescriptor;
  subscribe(listener: FieldworkLifecycleListener): () => void;
  run(options: RunOptions): Promise<FieldworkRunResult>;
  open(options: FieldworkApplicationOpenOptions): Promise<OpenRunService>;
  reviewedOutput(runDirectory: string): Promise<ReviewedExportV1>;
  listReviewedWebSourceRefs(cursor?: string): Promise<ReviewedWebSourceRefs>;
  /** Owner-bound web source operations. They are unavailable until a host configures an owner. */
  describeReviewedWebSource(exactRef: string): Promise<ReviewedWebSourceResult>;
  inspectReviewedWebSource(exactRef: string, cursor?: string): Promise<ReviewedWebSourceInspection>;
  close(): Promise<void>;
}

/** Compose Fieldwork as one independently runnable, host-neutral application. */
export function createFieldworkApplication(options: FieldworkApplicationOptions = {}): FieldworkApplication {
  const listeners = new Set<FieldworkLifecycleListener>();
  const sessions = new Set<OpenRunService>();
  let sequence = 0;
  const reviewedWebSource = options.reviewedWebSourceOwner && new ReviewedWebSourceReader(options.reviewedWebSourceOwner);
  const emit = (
    type: FieldworkLifecycleEventType,
    runResource: string,
    revision: number,
    eventCount: number,
  ): void => {
    const event = fieldworkLifecycleEventSchema.parse({
      apiVersion: "fieldwork.kontourai.io/v1",
      kind: "FieldworkLifecycleEvent",
      sequence: ++sequence,
      type,
      runResource,
      revision,
      eventCount,
    });
    for (const listener of listeners) {
      try { listener(event); }
      catch { /* Host observers are advisory and cannot fail application work. */ }
    }
  };
  const forward = (event: FieldworkLifecycleEventV1): void => {
    emit(event.type, event.runResource, event.revision, event.eventCount);
  };
  return {
    descriptor: fieldworkHostDescriptor,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async run(options) {
      const result = await runFieldwork(options);
      const selected = await readRunView(result.runDirectory);
      emit("run-created", result.runResource, selected.run.revision, selected.review.events.length);
      return result;
    },
    async open(options) {
      const opened = await openRun(options.runDirectory, {
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
        ...(options.embeddingOrigin === undefined ? {} : { embeddingOrigin: options.embeddingOrigin }),
        onLifecycleEvent: forward,
      });
      const service: OpenRunService = {
        ...opened,
        close: async () => {
          await opened.close();
          sessions.delete(service);
        },
      };
      sessions.add(service);
      return service;
    },
    async reviewedOutput(runDirectory) {
      const output = await reviewedExport(runDirectory);
      const selected = await readRunView(runDirectory);
      emit("review-exported", selected.run.resource, selected.run.revision, selected.review.events.length);
      return output;
    },
    async listReviewedWebSourceRefs(cursor) {
      if (!reviewedWebSource) return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceRefs", status: "restricted" };
      return reviewedWebSource.listReviewedWebSourceRefs(cursor);
    },
    async describeReviewedWebSource(exactRef) {
      if (!reviewedWebSource) return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceDescriptor", status: "restricted" };
      return reviewedWebSource.describeReviewedWebSource(exactRef);
    },
    async inspectReviewedWebSource(exactRef, cursor) {
      if (!reviewedWebSource) return { apiVersion: "fieldwork.kontourai.io/v1", kind: "ReviewedWebSourceInspection", status: "restricted" };
      return reviewedWebSource.inspectReviewedWebSource(exactRef, cursor);
    },
    async close() {
      await Promise.all([...sessions].map((session) => session.close()));
      listeners.clear();
    },
  };
}
