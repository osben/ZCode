import { useCallback, useMemo, useState } from "react";
import type { ZCodeImportSessionsResult, ZCodeImportableSessionCandidate } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

export type ClaudeMigrationRange = "all" | "7d" | "30d" | "90d";
type ClaudeMigrationWorkspaceFilterMode = "all" | "current";

const DEFAULT_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
export const UNLIMITED_SCAN_LIMIT_INPUT = "unlimited";

const RANGE_TO_DURATION_MS: Record<Exclude<ClaudeMigrationRange, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

function resolveModifiedSince(range: ClaudeMigrationRange): number | undefined {
  if (range === "all") {
    return undefined;
  }

  return Date.now() - RANGE_TO_DURATION_MS[range];
}

function resolveClaudeMigrationScanLimit(limitInput: string): number | undefined {
  if (limitInput === UNLIMITED_SCAN_LIMIT_INPUT) {
    return undefined;
  }

  const parsed = Number.parseInt(limitInput.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_SCAN_LIMIT);
}

export interface ClaudeSessionMigrationSupportState {
  supported: boolean;
  reason?: "desktopOnly";
}

function normalizeWorkspaceFilterMode(
  mode: ClaudeMigrationWorkspaceFilterMode,
  workspacePath: string | null,
): ClaudeMigrationWorkspaceFilterMode {
  if (mode === "current" && !workspacePath) {
    return "all";
  }

  return mode;
}

export function useClaudeSessionMigration(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const zcodeTaskService = useZCodeTaskService(
    params.workspacePath ?? undefined,
    undefined,
    params.workspaceIdentity,
  );
  const tabStoreApi = useTabStoreApi();
  const [workspaceFilterModeState, setWorkspaceFilterModeState] =
    useState<ClaudeMigrationWorkspaceFilterMode>("all");
  const [range, setRange] = useState<ClaudeMigrationRange>("30d");
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [candidates, setCandidates] = useState<ZCodeImportableSessionCandidate[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] = useState<ZCodeImportSessionsResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const workspaceFilterMode = useMemo(
    () => normalizeWorkspaceFilterMode(workspaceFilterModeState, params.workspacePath),
    [workspaceFilterModeState, params.workspacePath],
  );

  const effectiveWorkspacePath = useMemo(
    () => (workspaceFilterMode === "current" ? (params.workspacePath ?? undefined) : undefined),
    [workspaceFilterMode, params.workspacePath],
  );
  const effectiveWorkspaceIdentity = useMemo(
    () =>
      workspaceFilterMode === "current" ? params.workspaceIdentity?.trim() || undefined : undefined,
    [params.workspaceIdentity, workspaceFilterMode],
  );

  const supportState = useMemo<ClaudeSessionMigrationSupportState>(() => {
    // Key behavior: native Claude history migration reads ~/.claude/projects on the current machine.
    // Therefore, block only web here; workspace is now an optional filter and does not determine whether the feature is available.
    if (!params.isDesktop) {
      return {
        supported: false,
        reason: "desktopOnly",
      };
    }

    return {
      supported: true,
    };
  }, [params.isDesktop]);

  const scanLimit = useMemo(() => resolveClaudeMigrationScanLimit(limitInput), [limitInput]);

  const setWorkspaceFilterMode = useCallback(
    (mode: ClaudeMigrationWorkspaceFilterMode) => {
      setWorkspaceFilterModeState(normalizeWorkspaceFilterMode(mode, params.workspacePath));
    },
    [params.workspacePath],
  );

  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((previous) => {
      if (previous.includes(sessionId)) {
        return previous.filter((current) => current !== sessionId);
      }

      return [...previous, sessionId];
    });
  }, []);

  const selectAllSessions = useCallback(() => {
    setSelectedSessionIds(candidates.map((candidate) => candidate.sessionId));
  }, [candidates]);

  const clearSelectedSessions = useCallback(() => {
    setSelectedSessionIds([]);
  }, []);

  const scan = useCallback(async () => {
    if (!supportState.supported) {
      return;
    }

    setIsScanning(true);
    setScanError(null);

    try {
      logger.info(
        `[Migration] 开始扫描 Claude 原生历史 workspaceFilter=${effectiveWorkspacePath ?? "all"} range=${range} limit=${scanLimit ?? "unlimited"}`,
      );
      const nextCandidates = await zcodeTaskService.scanImportableClaudeSessions({
        workspacePath: effectiveWorkspacePath,
        ...(effectiveWorkspaceIdentity ? { workspaceIdentity: effectiveWorkspaceIdentity } : {}),
        modifiedSince: resolveModifiedSince(range),
        ...(scanLimit === undefined ? {} : { limit: scanLimit }),
      });
      setCandidates(nextCandidates);
      // Key behavior: after rescanning, keep only selections that are still visible.
      // This prevents changing filters or refreshing results from adding old sessions no longer in the current list to the import request.
      setSelectedSessionIds((previous) =>
        previous.filter((sessionId) =>
          nextCandidates.some((candidate) => candidate.sessionId === sessionId),
        ),
      );
      logger.info(
        `[Migration] Claude 原生历史扫描完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} count=${nextCandidates.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 扫描 Claude 原生历史失败", error);
      setScanError(message);
    } finally {
      setIsScanning(false);
    }
  }, [
    zcodeTaskService,
    effectiveWorkspaceIdentity,
    effectiveWorkspacePath,
    range,
    scanLimit,
    supportState.supported,
  ]);

  const importSessions = useCallback(
    async (sessionIds: string[]) => {
      if (!supportState.supported || sessionIds.length === 0) {
        return null;
      }

      setIsImporting(true);
      setImportError(null);

      try {
        logger.info(
          `[Migration] 开始导入 Claude 原生历史 workspaceFilter=${effectiveWorkspacePath ?? "all"} selected=${sessionIds.length}`,
        );
        const result = await zcodeTaskService.importClaudeSessions({
          workspacePath: effectiveWorkspacePath,
          ...(effectiveWorkspaceIdentity ? { workspaceIdentity: effectiveWorkspaceIdentity } : {}),
          sessionIds,
        });
        setLastImportResult(result);
        const handledSessionIds = new Set([
          ...result.imported.map((item) => item.sessionId),
          ...result.skipped.map((item) => item.sessionId),
          ...result.failed.map((item) => item.sessionId),
        ]);
        setSelectedSessionIds((previous) =>
          previous.filter((sessionId) => !handledSessionIds.has(sessionId)),
        );
        if (result.imported.length > 0) {
          const importedWorkspacePaths = new Set(result.imported.map((item) => item.workspacePath));
          // Claude import previously called bumpTaskListVersion to make every task list query again, but only the affected
          // workspace results need to be invalidated and fetched again. Local invalidation still shows imported tasks in
          // the sidebar without refreshing unrelated workspaces.
          const importedWorkspaceScopes = result.imported.map((item) => ({
            workspacePath: item.workspacePath,
          }));
          for (const workspacePath of importedWorkspacePaths) {
            tabStoreApi.getState().ensureWorkspaceTab(workspacePath);
          }
          invalidateTaskQueryCacheByScopes(importedWorkspaceScopes);
        }
        logger.info(
          `[Migration] Claude 原生历史导入完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Migration] 导入 Claude 原生历史失败", error);
        setImportError(message);
        return null;
      } finally {
        setIsImporting(false);
      }
    },
    [
      zcodeTaskService,
      effectiveWorkspaceIdentity,
      effectiveWorkspacePath,
      supportState.supported,
      tabStoreApi,
    ],
  );

  const importSelectedSessions = useCallback(async () => {
    return importSessions(selectedSessionIds);
  }, [importSessions, selectedSessionIds]);

  return {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter: params.workspacePath !== null,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount: selectedSessionIds.length,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSessions,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  };
}
