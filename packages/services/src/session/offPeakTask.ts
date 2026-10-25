import type {
  OffPeakCodingPlanSupport,
  OffPeakTaskCreateResult,
  OffPeakTakeNumberAvailability,
  ZCodeOffPeakTask,
  ZCodeOffPeakTaskCreateParams,
  ModelSelection,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// Off-peak task management service channel (not shared with the automation service surface).
// The renderer connects directly through ProxyChannel (the same pattern as codingPlanSubscription);
// polling, ticket requests, and settlement are driven internally and are not exposed to the renderer.

export interface OffPeakUpdateTaskParams {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  /** undefined = unchanged; Off-Peak Submission cannot be cleared to follow the default. */
  modelSelection?: ModelSelection | null;
}

export interface IOffPeakTaskService {
  /** Redacted support snapshot for the currently selected provider/connection; secrets never pass through renderer RPC. */
  getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport>;
  /** Current snapshot of server ticket quota; controls only the creation entry point, while POST /ticket remains the final admission authority. */
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  /** Creation requests a ticket immediately (persist only on success); failures return a stable category and never send raw errors over RPC. */
  createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult>;
  cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  deleteTask(offPeakTaskId: string): Promise<void>;
  /** Hide only the local History row; do not delete the task/session or execution fields. */
  deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null>;
  list(): Promise<ZCodeOffPeakTask[]>;
  get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
}

export const IOffPeakTaskService = createServiceDescriptor<IOffPeakTaskService>(
  ServiceChannels.OffPeakTask,
);
