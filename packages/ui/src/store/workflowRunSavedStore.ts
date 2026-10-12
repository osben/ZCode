// Read cache for "which saved workflow this run corresponds to" (docs/dynamic-workflow/transcript-and-notifications.md
// "Which workflow a run is saved as").
//
// The determination lives in the agent (`workflows/forRun`): both facts — the run's journal record and the on-disk definition —
// are over there, and the card records nothing itself. This is only a cache: completion cards hang in a virtual list and remount
// on every scroll, so each remount must not fire another RPC. Same discipline as the hub's read cache (savedWorkflowStore):
// the disk remains the sole authority, and any change invalidates everything.
import { create } from "zustand";
import type {
  ZCodeSavedWorkflowEntry,
  ZCodeWorkflowsForRunCandidate,
  ZCodeWorkflowsForRunResult,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * `unsupported` is a **capability**, not an error: old agents simply lack this method (JSON-RPC -32601),
 * and based on that the card keeps only the "let ZCode summarize and save for me" path. All other failures are treated as `error` —
 * not finding an answer is not the same as not saved,
 * so in that state the card draws neither the chip nor "run again", while "save" stays clickable.
 */
export type WorkflowRunSavedStatus = "loading" | "ready" | "unsupported" | "error";

export interface WorkflowRunSavedState {
  status: WorkflowRunSavedStatus;
  /** The matched definition; absent means this run has no corresponding saved workflow yet. */
  entry?: ZCodeSavedWorkflowEntry;
  match?: ZCodeWorkflowsForRunResult["match"];
  /** The args this run ran with, used to prefill the args form for "run again". */
  runArgs?: Record<string, unknown>;
}

/** JSON-RPC "method not found": old-agent capability detection relies on it (the hub uses -32602 to distinguish legacy scopes, the same precedent). */
const METHOD_NOT_FOUND = -32601;

interface WorkflowRunSavedStoreState {
  /** Invalidation generation (incremented by invalidate): the hook puts it in its deps, so one invalidation makes all mounted cards re-query. */
  generation: number;
  byKey: Record<string, WorkflowRunSavedState>;
  load: (key: string, loader: () => Promise<ZCodeWorkflowsForRunResult>) => Promise<void>;
  /**
   * The one this client just saved: that card flips over immediately (keeping the already-fetched args), everything else is
   * invalidated and re-queried — a same-name overwrite may simultaneously change other runs' answers (the match-by-name rule).
   */
  applySaved: (key: string, entry: ZCodeSavedWorkflowEntry) => void;
  /** Invalidate after save / delete / hub refresh: the next render re-queries. */
  invalidate: () => void;
  reset: () => void;
}

const inFlight = new Map<string, Promise<void>>();

function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

export const useWorkflowRunSavedStore = create<WorkflowRunSavedStoreState>((set, get) => ({
  generation: 0,
  byKey: {},
  async load(key, loader) {
    const current = inFlight.get(key);
    if (current) return current;
    // Don't ask again when a conclusion exists: the row window rebuilds the candidates table on every projection update (a new array,
    // same content), so the card's effect reruns frequently — without a guard here, every beat of streaming output would fire one RPC
    // per completion card on screen. Conclusions are invalidated only by invalidate (save, delete, hub refresh); a genuinely changed
    // candidate set is a different key.
    if (get().byKey[key] !== undefined) return;
    set((state) => ({
      byKey: { ...state.byKey, [key]: { ...state.byKey[key], status: "loading" } },
    }));
    // The generation at the moment of sending: when an invalidation happens mid-flight, the returning answer is a fact from **before**
    // the invalidation; drop it and let the next render re-query at the new generation (otherwise the entry the hub just deleted would
    // be written back onto the card by a late reply).
    const issuedAt = get().generation;
    const request = loader()
      .then((result) => {
        if (get().generation !== issuedAt) return;
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: {
              status: "ready",
              ...(result.entry === undefined ? {} : { entry: result.entry }),
              ...(result.match === undefined ? {} : { match: result.match }),
              ...(result.runArgs === undefined ? {} : { runArgs: result.runArgs }),
            },
          },
        }));
      })
      .catch((error: unknown) => {
        if (get().generation !== issuedAt) return;
        const unsupported = extractErrorCode(error) === METHOD_NOT_FOUND;
        if (!unsupported) {
          logger.warn("[workflowRunSavedStore] 查询这次 run 的已保存工作流失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        set((state) => ({
          byKey: { ...state.byKey, [key]: { status: unsupported ? "unsupported" : "error" } },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
  applySaved(key, entry) {
    inFlight.clear();
    // Invalidating first and then landing this entry would lose it (invalidate clears the whole table), and the card would flash back to "save"
    // until the re-query returns; so both things are done in one set: the generation bump makes other cards re-query, while this card keeps
    // its answer and is not re-queried.
    set((state) => ({
      generation: state.generation + 1,
      byKey: { [key]: { ...state.byKey[key], status: "ready", entry } },
    }));
  },
  invalidate() {
    inFlight.clear();
    // Clear the whole table rather than a single key: one save may affect other runs of the same name at once (the match-by-name rule),
    // and this table's scale is "the number of completion cards on screen" — re-querying costs far less than one card saying the wrong thing.
    set((state) => ({ generation: state.generation + 1, byKey: {} }));
  },
  reset() {
    inFlight.clear();
    useWorkflowRunSavedStore.setState({ generation: 0, byKey: {} });
  },
}));

/** Cache key: workspace + run + candidate signature. A changed candidate set (just saved once in the conversation) is a different question and must re-query. */
export function workflowRunSavedKey(
  workspaceKey: string,
  runId: string,
  candidates: readonly ZCodeWorkflowsForRunCandidate[] | undefined,
): string {
  const signature = (candidates ?? [])
    .map((candidate) => `${candidate.scope ?? ""}:${candidate.name}`)
    .join(",");
  return `${workspaceKey}\u0000${runId}\u0000${signature}`;
}

export function selectWorkflowRunSavedState(
  state: WorkflowRunSavedStoreState,
  key: string | null,
): WorkflowRunSavedState | undefined {
  return key === null ? undefined : state.byKey[key];
}

/** For tests. */
export function resetWorkflowRunSavedStoreForTests(): void {
  useWorkflowRunSavedStore.getState().reset();
}
