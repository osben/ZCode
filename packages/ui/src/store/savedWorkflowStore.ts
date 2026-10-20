// Read cache for the saved-workflow hub.
// Sharded by workspaceKey; disk remains the only authority (invariant 2) — the cache only supports rerenders on the same page,
// always refresh with `bypass` after a mutation (same lesson as skillStore: reusing an in-flight Promise returns a stale scan).
import { create } from "zustand";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowInvalidEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsListResult,
} from "@zcode/shared";
import type { IZCodeAgentService, ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import { logger } from "@/logger.js";
import { useWorkflowRunSavedStore } from "@/store/workflowRunSavedStore.js";

/** Maximum runs to fetch per page to compute "last run"; a project rarely has more active workflows than this. */
const SAVED_WORKFLOW_RUNS_PAGE = 50;

/**
 * Needed for declaration output: useSavedWorkflowGlobalGroup's return type references it, and tsc -d requires a nameable type;
 * knip cannot detect this use, so mark it public.
 * @public
 */
export interface SavedWorkflowWorkspaceState {
  entries: ZCodeSavedWorkflowEntry[];
  invalid: ZCodeSavedWorkflowInvalidEntry[];
  runs: ZCodeSavedWorkflowRun[];
  /** Scanned directories (local absolute paths), used by the global group to watch; null before loading or while the list has not returned. */
  dir: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** JSON-RPC error code from the list call, when available; the global group uses -32602 to distinguish "unsupported by legacy Agent" from other errors. */
  errorCode: number | null;
}

const EMPTY_SAVED_WORKFLOW_STATE: SavedWorkflowWorkspaceState = {
  entries: [],
  invalid: [],
  runs: [],
  dir: null,
  loading: false,
  loaded: false,
  error: null,
  errorCode: null,
};

interface SavedWorkflowStoreState {
  byWorkspaceKey: Record<string, SavedWorkflowWorkspaceState>;
  load: (
    target: ZCodeAgentSavedWorkflowTarget,
    agentService: IZCodeAgentService,
    options?: { bypassCache?: boolean },
  ) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Read-cache shard key: the global tier (`scope:"global"` with no workspace)
 * uses the fixed key `"global"` — it spans projects and services chooses its storage location, so it must not be confused with any project's workspaceKey;
 * project tiers remain sharded by `resolveWorkspaceKey`.
 */
function savedWorkflowStoreKey(target: ZCodeAgentSavedWorkflowTarget): string {
  if (target.scope === "global" && !target.workspacePath) return "global";
  return resolveWorkspaceKey({
    workspacePath: target.workspacePath ?? "",
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  });
}

/** Gets the JSON-RPC code from a thrown error (ChannelClient preserves error.code); returns null if unavailable. */
function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

async function fetchWorkspace(
  target: ZCodeAgentSavedWorkflowTarget,
  agentService: IZCodeAgentService,
): Promise<{ list: ZCodeWorkflowsListResult; runs: ZCodeSavedWorkflowRun[] }> {
  // Fetch the list and run history in parallel; a run-history failure does not break the list (the hub remains usable when the journal is unavailable).
  const [list, runs] = await Promise.all([
    agentService.listSavedWorkflows(target),
    agentService
      .listSavedWorkflowRuns({ ...target, limit: SAVED_WORKFLOW_RUNS_PAGE })
      .then((result) => result.runs)
      .catch((error: unknown) => {
        logger.warn("[savedWorkflowStore] 拉取运行历史失败，按无记录处理", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as ZCodeSavedWorkflowRun[];
      }),
  ]);
  return { list, runs };
}

export const useSavedWorkflowStore = create<SavedWorkflowStoreState>((set) => ({
  byWorkspaceKey: {},
  async load(target, agentService, options = {}) {
    const key = savedWorkflowStoreKey(target);
    if (!options.bypassCache) {
      const current = inFlight.get(key);
      if (current) return current;
    }
    set((state) => ({
      byWorkspaceKey: {
        ...state.byWorkspaceKey,
        [key]: { ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE), loading: true },
      },
    }));
    const request = fetchWorkspace(target, agentService)
      .then(({ list, runs }) => {
        // The hub just read from disk: invalidate the completion-card read cache for “which workflow this run was saved as” too
        // （docs/dynamic-workflow/transcript-and-notifications.md「Which workflow a run is saved as」）。
        // Delete, move, and metadata changes in the hub all finish with a refresh; this line propagates those actions to the cards in the conversation.
        useWorkflowRunSavedStore.getState().invalidate();
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              entries: list.workflows,
              invalid: list.invalid,
              runs,
              dir: list.dir,
              loading: false,
              loaded: true,
              error: null,
              errorCode: null,
            },
          },
        }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[savedWorkflowStore] 拉取已保存工作流失败", { error: message });
        set((state) => ({
          byWorkspaceKey: {
            ...state.byWorkspaceKey,
            [key]: {
              ...(state.byWorkspaceKey[key] ?? EMPTY_SAVED_WORKFLOW_STATE),
              loading: false,
              loaded: true,
              error: message,
              errorCode: extractErrorCode(error),
            },
          },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
}));

export function selectSavedWorkflowState(
  state: SavedWorkflowStoreState,
  target: ZCodeAgentSavedWorkflowTarget | null,
): SavedWorkflowWorkspaceState {
  if (!target) return EMPTY_SAVED_WORKFLOW_STATE;
  return state.byWorkspaceKey[savedWorkflowStoreKey(target)] ?? EMPTY_SAVED_WORKFLOW_STATE;
}

/** For tests: clear the in-flight deduplication table. */
export function resetSavedWorkflowStoreForTests(): void {
  inFlight.clear();
  useSavedWorkflowStore.setState({ byWorkspaceKey: {} });
}
