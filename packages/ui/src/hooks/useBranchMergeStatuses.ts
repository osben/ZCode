import { useEffect, useMemo, useRef } from "react";
import { useBranchMergeStatusStore } from "@/store/branchMergeStatusStore.js";
import {
  createBranchMergeStatusProber,
  type BranchMergeStatusTarget,
} from "@/lib/branchMergeStatusProbeRunner.js";

export type { BranchMergeStatusTarget };

/**
 * Probes branch merge status for the sidebar's workspaces on mount (sidebar
 * open) and on window focus. The runtime git service is the single owner of
 * the observation cadence (TTL cache, branch-switch invalidation, HEAD
 * validation on cache hits); this hook only mirrors results into the store
 * for task rows — a failed probe drops the workspace entry so the badge
 * degrades to hidden instead of freezing stale.
 *
 * Callers must memoize `targets`: the effect re-runs when a remote reconnect
 * rebuilds the service lookup. An old host without the method rejects the
 * call; the row then keeps no badge (new UI + old CLI degrades silently).
 */
export function useBranchMergeStatuses(
  targets: readonly BranchMergeStatusTarget[],
  options?: { active?: boolean },
): void {
  const active = options?.active ?? true;
  const setBranchMergeStatus = useBranchMergeStatusStore((state) => state.setBranchMergeStatus);
  const dropWorkspace = useBranchMergeStatusStore((state) => state.dropWorkspace);
  // Сигнал успешной git-мутации (смена ветки/коммит): сервисный кэш инвалидирован
  // самим сервисом — здесь остаётся немедленно переопросить. Остальные re-run'ы
  // эффекта (mount, смена targets при reconnect, открытие сайдбара) тоже пробят:
  // повторная проба дешёвая и упирается в сервисный TTL.
  const refreshVersion = useBranchMergeStatusStore((state) => state.refreshVersion);

  const prober = useMemo(
    () => createBranchMergeStatusProber({ setBranchMergeStatus, dropWorkspace }),
    [setBranchMergeStatus, dropWorkspace],
  );

  const targetKeys = targets.map((target) => target.workspaceKey).join("\u0000");
  const previousKeysRef = useRef<string[] | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    void prober.probe(targets);

    const onFocus = () => {
      void prober.probe(targets);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [prober, targets, active, refreshVersion]);

  // Drop store entries for workspaces that left the sidebar.
  useEffect(() => {
    const targetKeyList = targetKeys ? targetKeys.split("\u0000") : [];
    const previousKeys = previousKeysRef.current;
    if (previousKeys) {
      for (const key of previousKeys) {
        if (!targetKeyList.includes(key)) {
          dropWorkspace(key);
          prober.forget(key);
        }
      }
    }
    previousKeysRef.current = targetKeyList;
  }, [targetKeys, dropWorkspace, prober]);
}
