import { create } from "zustand";
import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { logger } from "@/logger.js";

// ============================================================
// The renderer’s sole copy of the dynamic-workflow rollout snapshot.
// ============================================================
//
// Host is the only decision-maker; this stores only its `{ mode, enabled, source }` result:
// - Fetch once per app session. The loader in Root is the single owner;
// automation pages and run panels read it without issuing their own requests.
// - No forceRefresh here. Host derives the CLI tool policy from the same 1h snapshot;
// an independent renderer refresh could make the UI show an entry point while the model has no tool.
// To force a new read, call refresh().
// - Treat a request failure as disabled (fail-closed, matching resolveDynamicWorkflowClientConfig),
// but **do not cache the failure**: a new service instance should retry. Mobile `/remote` gets an unsupported proxy
// before the workspace bridge is ready, which necessarily throws; after bridging, the accessor changes and must be able to recover.

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** Always false while loading: when availability is unknown, do not expose it; let the entry point appear slightly later rather than flash and disappear. */
  readonly enabled: boolean;
  /** Null when not ready or the fetch failed; `source` is for observability only, distinguishing “disabled by server” from “local override.” */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** Initial fetch; a no-op after this service has returned a result, and concurrent calls share the same request. */
  ensureLoaded(service: ICodingPlanSubscriptionService): Promise<void>;
  /** Bypass the gate and Host’s 1h snapshot cache to fetch again (forceRefresh). */
  refresh(service: ICodingPlanSubscriptionService): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

let inFlight: Promise<void> | null = null;
/** Service instance that has already returned a result (success or failure); do not request again on the same instance. */
let settledService: ICodingPlanSubscriptionService | null = null;

type PublishSnapshot = (snapshot: DynamicWorkflowAvailabilitySnapshot) => void;

async function loadDynamicWorkflowConfig(
  service: ICodingPlanSubscriptionService,
  options: { forceRefresh?: boolean },
  publish: PublishSnapshot,
): Promise<void> {
  try {
    const config = await service.getDynamicWorkflowClientConfig(options);
    publish({ status: "ready", enabled: config.enabled === true, config });
  } catch (error) {
    logger.warn(
      "[dynamic-workflow] 灰度快照读取失败，按未命中处理",
      error instanceof Error ? error.message : String(error),
    );
    publish({ status: "ready", enabled: false, config: null });
  } finally {
    settledService = service;
  }
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(service): Promise<void> {
      if (settledService === service) return Promise.resolve();
      if (inFlight) {
        // An in-flight request may belong to another service instance (the mobile `/remote` accessor changes while bridging); wait behind it, then check again.
        // If it belongs to this instance, settledService already matches and recursion immediately hits the no-op above.
        return inFlight.then(() => get().ensureLoaded(service));
      }
      const run = loadDynamicWorkflowConfig(service, {}, set).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },

    refresh(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, { forceRefresh: true }, set);
    },
  }),
);
