/**
 * Draft branch-switch intent + affected-active-tasks computation
 * (spec: specs/composer-branch-switcher-semantics.md §1-§2).
 *
 * The draft-header branch picker records intent only (no git calls while drafting); the composer
 * applies it at send (guard → switch → create, abort preserves the draft). The guard lists active
 * tasks sharing the affected checkout root; worktree-bound sessions are excluded from checkout
 * switches and grouped under their worktree for panel switches.
 */
import { create } from "zustand";
import { logger } from "@/logger.js";

/** Draft branch intent per workspaceKey (`workspaceIdentity?.trim() || workspacePath`). */
interface DraftBranchIntentState {
  intentByWorkspaceKey: Record<string, string>;
  /**
   * Reactive mirror of the empty-state "New worktree" checkbox intent: while set, the header
   * branch picker is disabled (the worktree setup owns the branch for this draft, spec §1).
   */
  worktreeIntentActiveByWorkspaceKey: Record<string, boolean>;
  setDraftBranchIntent: (workspaceKey: string, branchName: string) => void;
  clearDraftBranchIntent: (workspaceKey: string) => void;
  setWorktreeIntentActive: (workspaceKey: string, active: boolean) => void;
  /**
   * Frozen destination of a restored failed submission (branch name and custom location). The next
   * worktree creation for the workspace uses it once, so Retry keeps the frozen destination.
   */
  frozenWorktreeIntentByWorkspaceKey: Record<string, FrozenWorktreeDestination>;
  setFrozenWorktreeIntent: (workspaceKey: string, destination: FrozenWorktreeDestination) => void;
  clearFrozenWorktreeIntent: (workspaceKey: string) => void;
  /** Read the pending frozen destination without consuming it; undefined when none is pending. */
  peekFrozenWorktreeIntent: (workspaceKey: string) => FrozenWorktreeDestination | undefined;
  /**
   * Clear the frozen destination only when it is still the given object. Called once admission has
   * succeeded, so a failed admission keeps the frozen destination for the next Retry.
   */
  releaseFrozenWorktreeIntent: (
    workspaceKey: string,
    destination: FrozenWorktreeDestination,
  ) => void;
}

export interface FrozenWorktreeDestination {
  branchName: string;
  customLocationPath?: string;
}

export const useDraftBranchIntentStore = create<DraftBranchIntentState>((set, get) => ({
  intentByWorkspaceKey: {},
  worktreeIntentActiveByWorkspaceKey: {},
  frozenWorktreeIntentByWorkspaceKey: {},
  setFrozenWorktreeIntent: (workspaceKey, destination) =>
    set((state) => ({
      frozenWorktreeIntentByWorkspaceKey: {
        ...state.frozenWorktreeIntentByWorkspaceKey,
        [workspaceKey]: destination,
      },
    })),
  clearFrozenWorktreeIntent: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.frozenWorktreeIntentByWorkspaceKey)) return state;
      const { [workspaceKey]: _removed, ...rest } = state.frozenWorktreeIntentByWorkspaceKey;
      return { frozenWorktreeIntentByWorkspaceKey: rest };
    }),
  peekFrozenWorktreeIntent: (workspaceKey) =>
    get().frozenWorktreeIntentByWorkspaceKey[workspaceKey],
  releaseFrozenWorktreeIntent: (workspaceKey, destination) =>
    set((state) => {
      if (state.frozenWorktreeIntentByWorkspaceKey[workspaceKey] !== destination) return state;
      const { [workspaceKey]: _released, ...rest } = state.frozenWorktreeIntentByWorkspaceKey;
      return { frozenWorktreeIntentByWorkspaceKey: rest };
    }),
  setDraftBranchIntent: (workspaceKey, branchName) =>
    set((state) => ({
      intentByWorkspaceKey: { ...state.intentByWorkspaceKey, [workspaceKey]: branchName },
    })),
  clearDraftBranchIntent: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.intentByWorkspaceKey)) return state;
      const { [workspaceKey]: _removed, ...rest } = state.intentByWorkspaceKey;
      return { intentByWorkspaceKey: rest };
    }),
  setWorktreeIntentActive: (workspaceKey, active) =>
    set((state) => {
      if (Boolean(state.worktreeIntentActiveByWorkspaceKey[workspaceKey]) === active) return state;
      const { [workspaceKey]: _removed, ...rest } = state.worktreeIntentActiveByWorkspaceKey;
      return {
        worktreeIntentActiveByWorkspaceKey: active ? { ...rest, [workspaceKey]: true } : rest,
      };
    }),
}));

export function selectWorktreeIntentActive(
  state: DraftBranchIntentState,
  workspaceKey: string,
): boolean {
  return Boolean(state.worktreeIntentActiveByWorkspaceKey[workspaceKey]);
}

export function selectDraftBranchIntent(state: DraftBranchIntentState, workspaceKey: string) {
  return state.intentByWorkspaceKey[workspaceKey] ?? null;
}

/** Sessions-index phases that make a task "active" for the switch guard (spec §2). */
const ACTIVE_SWITCH_GUARD_PHASES = new Set(["prewarming", "running"]);

/** Structural task shape the guard needs (satisfied by window-controller task list items). */
export interface BranchGuardTaskLike {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title?: string;
  executionWorktree?: { path: string } | null;
  activity?: { phase?: string } | null;
}

export interface AffectedActiveTask {
  taskId: string;
  title: string;
}

/**
 * Pure guard-list computation over the task-list state the UI already holds.
 * - checkout scope: active non-worktree tasks of the workspace (a parent-checkout switch does not
 *   touch worktree-bound sessions).
 * - worktree scope: active tasks bound to that exact worktree path.
 * An empty result means "nothing to confirm".
 */
export function collectAffectedActiveTasks(
  tasks: readonly BranchGuardTaskLike[],
  options: { workspaceKey: string; scope: "checkout" | "worktree"; worktreePath?: string },
): AffectedActiveTask[] {
  const affected: AffectedActiveTask[] = [];
  for (const task of tasks) {
    const phase = task.activity?.phase;
    if (phase === undefined || !ACTIVE_SWITCH_GUARD_PHASES.has(phase)) continue;
    const taskWorkspaceKey = task.workspaceIdentity?.trim() || task.workspacePath;
    if (taskWorkspaceKey !== options.workspaceKey) continue;
    const worktreePath = task.executionWorktree?.path;
    if (options.scope === "checkout") {
      if (worktreePath) continue;
    } else {
      if (!worktreePath || worktreePath !== options.worktreePath) continue;
    }
    affected.push({ taskId: task.taskId, title: task.title || task.taskId });
  }
  return affected;
}

/** Structural git surface the send-time branch resolution needs. */
export interface DraftBranchIntentSendGitService {
  getLocalBranches(params: {
    workspacePath: string;
  }): Promise<{ currentBranchName: string | null }>;
  switchBranch(params: {
    workspacePath: string;
    targetBranchName: string;
  }): Promise<{ ok: boolean; issues: ReadonlyArray<{ message?: string }> }>;
}

export type DraftBranchIntentSendOutcome =
  | { outcome: "proceed" }
  | {
      outcome: "aborted";
      reason: "guard" | "switch-failed" | "switch-error";
      /** Git issue text / thrown error text; the caller surfaces it, the draft stays intact. */
      message?: string;
    };

/**
 * Apply the draft branch intent before the send dispatch (spec: composer-branch-switcher-semantics.md §1).
 * Same-branch check first, then guard before any actual switch. Every failure path aborts the send
 * AND keeps the intent in the store (retryable); the intent is cleared only on full success —
 * a git failure must never silently swallow either the switch or the user's draft.
 */
export async function applyDraftBranchIntentForSend({
  gitService,
  guard,
  workspaceKey,
  workspacePath,
  branchName,
}: {
  gitService: DraftBranchIntentSendGitService;
  guard?: (request: {
    workspaceKey: string;
    targetBranchName: string;
    scope: "checkout";
  }) => Promise<boolean>;
  workspaceKey: string;
  workspacePath: string;
  branchName: string;
}): Promise<DraftBranchIntentSendOutcome> {
  try {
    const branches = await gitService.getLocalBranches({ workspacePath });
    if (branches.currentBranchName !== branchName) {
      if (guard) {
        const allowed = await guard({
          workspaceKey,
          targetBranchName: branchName,
          scope: "checkout",
        });
        if (!allowed) {
          return { outcome: "aborted", reason: "guard" };
        }
      }
      const result = await gitService.switchBranch({
        workspacePath,
        targetBranchName: branchName,
      });
      if (!result.ok) {
        return {
          outcome: "aborted",
          reason: "switch-failed",
          message: result.issues[0]?.message,
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[DraftBranchIntent] send-time branch switch failed", {
      workspaceKey,
      branchName,
      error: message,
    });
    return { outcome: "aborted", reason: "switch-error", message };
  }
  useDraftBranchIntentStore.getState().clearDraftBranchIntent(workspaceKey);
  return { outcome: "proceed" };
}
