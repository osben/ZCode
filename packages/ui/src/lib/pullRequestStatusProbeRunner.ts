import type { SessionPullRequestsTaskInput, SessionPullRequestStatus } from "@zcode/shared";
import type { IGitService } from "@zcode/services";
import { logger } from "@/logger.js";

export interface PullRequestStatusTargetTask {
  input: SessionPullRequestsTaskInput;
  /** Live running flag from the sessions index; drives the turn-end invalidation. */
  running: boolean;
}

export interface PullRequestStatusTarget {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  gitService: IGitService;
  /** Worktree tasks of this workspace; ordinary sessions never ride the probe. */
  tasks: readonly PullRequestStatusTargetTask[];
}

/** Минимальная поверхность стора, нужная пробе; упрощает юнит-тесты. */
export interface PullRequestProbeStore {
  setWorkspacePullRequestStatuses(
    workspaceKey: string,
    entries: Record<string, SessionPullRequestStatus>,
  ): void;
  dropWorkspaceTasks(workspaceKey: string): void;
}

/**
 * Оркестрация проб PR-статуса без React/DOM — hook оборачивает её, тесты
 * гоняют напрямую. Каденцией владеет сервис (TTL + forceTaskIds), клиентского
 * TTL-гейта здесь нет.
 *
 * Правила записи:
 * - актуальна только последняя проба на workspace (stale-write guard);
 * - успешная проба мержит записи workspace: сайдбар пробит всеми задачами,
 *   Session manager — только видимыми строками, вычитание чужих записей
 *   запрещено;
 * - ответ обязан быть объектом (web-стаб отвечает {}, старый host reject'ит);
 * - неудачная проба удаляет записи workspace — индикатор гарантированно
 *   пропадает, а не застывает прошлым состоянием;
 * - повторяющиеся неудачи предупреждают один раз на workspace.
 */
export function createPullRequestStatusProber(
  store: PullRequestProbeStore,
  warnings: { warn: (message: string, detail: unknown) => void } = { warn: logger.warn },
) {
  const writeSequenceByWorkspaceKey = new Map<string, number>();
  const warnedWorkspaceKeys = new Set<string>();

  async function probe(
    targets: readonly PullRequestStatusTarget[],
    options?: { force?: boolean; forceTaskIds?: string[] },
  ): Promise<void> {
    await Promise.allSettled(
      targets.map(async (target) => {
        if (target.tasks.length === 0) {
          return;
        }
        const forceTaskIds = options?.force
          ? target.tasks.map((task) => task.input.taskId)
          : (options?.forceTaskIds ?? []).filter((taskId) =>
              target.tasks.some((task) => task.input.taskId === taskId),
            );
        const sequence = (writeSequenceByWorkspaceKey.get(target.workspaceKey) ?? 0) + 1;
        writeSequenceByWorkspaceKey.set(target.workspaceKey, sequence);
        try {
          const result = await target.gitService.getSessionPullRequests({
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            tasks: target.tasks.map((task) => task.input),
            ...(forceTaskIds.length > 0 ? { forceTaskIds } : {}),
          });
          if (writeSequenceByWorkspaceKey.get(target.workspaceKey) !== sequence) {
            return;
          }
          if (result === null || typeof result !== "object" || Array.isArray(result)) {
            throw new Error("unexpected getSessionPullRequests response shape");
          }
          warnedWorkspaceKeys.delete(target.workspaceKey);
          store.setWorkspacePullRequestStatuses(target.workspaceKey, result);
        } catch (error) {
          if (writeSequenceByWorkspaceKey.get(target.workspaceKey) !== sequence) {
            return;
          }
          if (!warnedWorkspaceKeys.has(target.workspaceKey)) {
            warnedWorkspaceKeys.add(target.workspaceKey);
            warnings.warn(
              `session pull request status unavailable for ${target.workspaceKey}`,
              error instanceof Error ? error.message : error,
            );
          }
          store.dropWorkspaceTasks(target.workspaceKey);
        }
      }),
    );
  }

  function forget(workspaceKey: string): void {
    writeSequenceByWorkspaceKey.delete(workspaceKey);
    warnedWorkspaceKeys.delete(workspaceKey);
  }

  return { probe, forget };
}
