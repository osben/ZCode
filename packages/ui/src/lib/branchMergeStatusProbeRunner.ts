import type { GitBranchMergeStatus } from "@zcode/shared";
import type { IGitService } from "@zcode/services";
import { logger } from "@/logger.js";

export interface BranchMergeStatusTarget {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  gitService: IGitService;
}

/** Минимальная поверхность стора, нужная пробе; упрощает юнит-тесты. */
export interface BranchMergeProbeStore {
  setBranchMergeStatus(workspaceKey: string, status: GitBranchMergeStatus): void;
  dropWorkspace(workspaceKey: string): void;
}

/**
 * Оркестрация проб merge-статуса без React/DOM — hook оборачивает её, тесты
 * гоняют напрямую. Каденцией владеет сервис (TTL + инвалидации), клиентского
 * гейта здесь нет: каждая проба опрашивает все цели.
 *
 * Правила записи:
 * - актуальна только последняя проба на workspace (stale-write guard);
 * - успешная проба пишет статус в стор;
 * - неудачная (старый host без метода, RPC) удаляет запись workspace — бейдж
 *   гарантированно пропадает, а не застывает прошлым «Merged»;
 * - повторяющиеся неудачи предупреждают один раз на workspace.
 */
export function createBranchMergeStatusProber(
  store: BranchMergeProbeStore,
  warnings: { warn: (message: string, detail: unknown) => void } = { warn: logger.warn },
) {
  const writeSequenceByKey = new Map<string, number>();
  const warnedKeys = new Set<string>();

  async function probe(targets: readonly BranchMergeStatusTarget[]): Promise<void> {
    await Promise.allSettled(
      targets.map(async (target) => {
        const sequence = (writeSequenceByKey.get(target.workspaceKey) ?? 0) + 1;
        writeSequenceByKey.set(target.workspaceKey, sequence);
        try {
          const status = await target.gitService.getBranchMergeStatus({
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          });
          if (writeSequenceByKey.get(target.workspaceKey) !== sequence) {
            return;
          }
          warnedKeys.delete(target.workspaceKey);
          store.setBranchMergeStatus(target.workspaceKey, status);
        } catch (error) {
          if (writeSequenceByKey.get(target.workspaceKey) !== sequence) {
            return;
          }
          if (!warnedKeys.has(target.workspaceKey)) {
            warnedKeys.add(target.workspaceKey);
            warnings.warn(
              `branch merge status unavailable for ${target.workspaceKey}`,
              error instanceof Error ? error.message : error,
            );
          }
          // Деградация по спеке: ошибка пробы скрывает бейдж, включая ранее показанный.
          store.dropWorkspace(target.workspaceKey);
        }
      }),
    );
  }

  function forget(workspaceKey: string): void {
    writeSequenceByKey.delete(workspaceKey);
    warnedKeys.delete(workspaceKey);
  }

  return { probe, forget };
}
