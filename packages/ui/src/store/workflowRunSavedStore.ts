// Read cache for "which saved workflow this run corresponds to" (docs/dynamic-workflow/transcript-and-notifications.md,
// "Which workflow a run is saved as").
//
// The decision lives in the agent (`workflows/forRun`): both facts — the run's journal record and the
// definition on disk — are over there, and the card records nothing itself. This is only a cache: the
// completion card is mounted in the virtual list and remounts on every scroll, and each remount must not
// issue another RPC. Same discipline as the hub's read cache (savedWorkflowStore): disk stays the sole
// authority, and everything is invalidated after any change.
import { create } from "zustand";
import type {
  ZCodeSavedWorkflowEntry,
  ZCodeWorkflowsForRunCandidate,
  ZCodeWorkflowsForRunResult,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * `unsupported` is a **capability**, not an error: older agents simply lack the method (JSON-RPC -32601),
 * and the card keeps only the "let ZCode distill and save it" path accordingly. All other failures are
 * treated as `error` — an inconclusive lookup does not mean it was not saved, so in that state the card
 * draws neither a chip nor "run again", but "save" stays clickable.
 */
export type WorkflowRunSavedStatus = "loading" | "ready" | "unsupported" | "error";

export interface WorkflowRunSavedState {
  status: WorkflowRunSavedStatus;
  /** The matched definition; absent means this run has no corresponding saved workflow yet. */
  entry?: ZCodeSavedWorkflowEntry;
  match?: ZCodeWorkflowsForRunResult["match"];
  /** The actual arguments this run executed with, for prefilling the "run again" arguments dialog. */
  runArgs?: Record<string, unknown>;
}

/** JSON-RPC "method not found": capability detection on older agents relies on it (the hub uses -32602 to distinguish old scopes, the same precedent). */
const METHOD_NOT_FOUND = -32601;

interface WorkflowRunSavedStoreState {
  /** Invalidation generation (incremented by invalidate): hooks put it in deps, so one invalidation makes every mounted card re-query. */
  generation: number;
  byKey: Record<string, WorkflowRunSavedState>;
  load: (key: string, loader: () => Promise<ZCodeWorkflowsForRunResult>) => Promise<void>;
  /**
   * The copy this client just wrote: this one card flips immediately (keeping the queried arguments)
   * while everything else is invalidated and re-queried — an overwrite by the same name can change the
   * answer for other runs too (the matched-by-name rule).
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
    // Skip asking when a conclusion already exists: the row window rebuilds the candidate table on every
    // projection update (new array, same content), so card effects re-run frequently — without a guard
    // here, every beat of streamed output would send one RPC per mounted completion card.
    // Conclusions are only invalidated by invalidate (save, delete, hub refresh); a genuinely changed
    // candidate list is a different key.
    if (get().byKey[key] !== undefined) return;
    set((state) => ({
      byKey: { ...state.byKey, [key]: { ...state.byKey[key], status: "loading" } },
    }));
    // The generation at issue time: when an invalidation happens mid-flight, the returned answer is a
    // fact from **before** the invalidation — drop it and let the next render re-query under the new
    // generation (otherwise a just-deleted entry at the hub would be written back onto the card by a
    // late reply).
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
    // Invalidating first and then writing this entry would lose it (invalidate clears the whole table)
    // and the card would flash back to "save" until the re-query returns;
    // so both steps happen in one set: the generation bump makes other cards re-query, while this card
    // keeps its answer and is not re-queried.
    set((state) => ({
      generation: state.generation + 1,
      byKey: { [key]: { ...state.byKey[key], status: "ready", entry } },
    }));
  },
  invalidate() {
    inFlight.clear();
    // Clear the whole table rather than one key: a single save can affect other runs of the same name
    // (the matched-by-name rule), and this table's scale is "completion cards on screen" — re-querying
    // costs far less than one card stating something wrong.
    set((state) => ({ generation: state.generation + 1, byKey: {} }));
  },
  reset() {
    inFlight.clear();
    useWorkflowRunSavedStore.setState({ generation: 0, byKey: {} });
  },
}));

/** Cache key: workspace + run + candidate signature. A changed candidate list (something was just saved in this conversation) is a different question and must be re-queried. */
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
