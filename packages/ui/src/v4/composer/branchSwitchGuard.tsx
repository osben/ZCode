import { formatPluralMessage } from "../../i18n/formatPlural.js";
/**
 * Branch-switch guard (spec: specs/composer-branch-switcher-semantics.md §2): a confirm dialog
 * listing the active tasks a branch switch would disturb, shared by the draft send-time switch and
 * the status-panel switcher. Data comes from the task list the workspace shell already holds
 * (window-controller registry; no new protocol surface).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import {
  collectAffectedActiveTasks,
  type AffectedActiveTask,
  type BranchGuardTaskLike,
} from "@/v4/composer/draftBranchIntent.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";

export interface BranchSwitchGuardRequest {
  workspaceKey: string;
  targetBranchName: string;
  scope: "checkout" | "worktree";
  worktreePath?: string;
}

/** Null where no shell provides the guard (remote-control compact shell); switches proceed unguarded there. */
export const BranchSwitchGuardContext = createContext<
  ((request: BranchSwitchGuardRequest) => Promise<boolean>) | null
>(null);

export function useBranchSwitchGuard():
  | ((request: BranchSwitchGuardRequest) => Promise<boolean>)
  | null {
  return useContext(BranchSwitchGuardContext);
}

interface GuardDialogState {
  request: BranchSwitchGuardRequest;
  affected: AffectedActiveTask[];
  resolve: (allowed: boolean) => void;
}

/**
 * Owns the active-task list (existing task-list subscription surface) and the confirm dialog.
 * Returns the confirm callback (hand to consumers via BranchSwitchGuardContext) plus the dialog
 * element to render once in the shell.
 */
export function useBranchSwitchGuardShell({
  workspaceTabs,
}: {
  workspaceTabs: ReadonlyArray<
    Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity"> & {
      remoteSessionId?: string;
    }
  >;
}) {
  const { intl } = useZCodeIntl();
  const [dialogState, setDialogState] = useState<GuardDialogState | null>(null);
  // The task list hook keeps its own items ref; mirror the latest items for action-time reads.
  const { items, hasCurrentResult, loading } = useGlobalTaskList({
    kind: "active",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    // The guard must include active tasks outside the currently rendered sidebar page.
    expanded: true,
    collapsedLimit: 0,
  });
  const itemsRef = useRef<readonly BranchGuardTaskLike[]>(items);
  itemsRef.current = items;
  const listReadyRef = useRef(hasCurrentResult && !loading);
  listReadyRef.current = hasCurrentResult && !loading;
  const activeDialogRef = useRef<GuardDialogState | null>(null);
  const queuedDialogRequestsRef = useRef<GuardDialogState[]>([]);

  const confirm = useCallback(
    (request: BranchSwitchGuardRequest): Promise<boolean> => {
      if (!listReadyRef.current) {
        toast(intl.formatMessage({ id: "branchSwitchGuard.listUnavailable" }));
        return Promise.resolve(false);
      }
      const affected = collectAffectedActiveTasks(itemsRef.current, request);
      if (affected.length === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const nextRequest = { request, affected, resolve };
        if (activeDialogRef.current) {
          queuedDialogRequestsRef.current.push(nextRequest);
          return;
        }
        activeDialogRef.current = nextRequest;
        setDialogState(nextRequest);
      });
    },
    [intl],
  );

  const settle = useCallback((current: GuardDialogState, allowed: boolean) => {
    // Resolve outside the state updater: updaters must stay pure (StrictMode double-invokes them).
    if (activeDialogRef.current !== current) return;
    current.resolve(allowed);
    const next = queuedDialogRequestsRef.current.shift() ?? null;
    activeDialogRef.current = next;
    setDialogState(next);
  }, []);

  useEffect(
    () => () => {
      activeDialogRef.current?.resolve(false);
      activeDialogRef.current = null;
      for (const queued of queuedDialogRequestsRef.current.splice(0)) queued.resolve(false);
    },
    [],
  );

  const dialog = useMemo(() => {
    if (!dialogState) return null;
    return (
      <AlertDialog open onOpenChange={(open) => !open && settle(dialogState, false)}>
        <AlertDialogContent data-branch-switch-guard-dialog="true">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "branchSwitchGuard.title" })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {/* formatMessage only substitutes {key} placeholders (createIntl), so the plural
                      count comes from the formatPlural key family and is assembled here. */}
                  {intl.formatMessage(
                    { id: "branchSwitchGuard.descriptionPrefix" },
                    { branch: dialogState.request.targetBranchName },
                  )}{" "}
                  {formatPluralMessage(
                    intl,
                    "branchSwitchGuard.taskCount",
                    dialogState.affected.length,
                  )}
                </p>
                <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 text-foreground-subtle">
                  {dialogState.affected.map((task) => (
                    <li key={task.taskId}>{task.title}</li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(dialogState, false)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(dialogState, true)}>
              {intl.formatMessage({ id: "branchSwitchGuard.confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }, [dialogState, intl, settle]);

  return { confirm, dialog };
}
