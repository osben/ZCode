import { useCallback, useEffect, useState } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import type { IGitService } from "@zcode/services";
import type { AppSettings, WorktreeProjectOverrideSettings } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  buildWorktreeTaskProjects,
  type WorktreeTaskProjectTab,
} from "@/command-center/worktreeTaskFlow.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import { SettingsBadge, SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { cn } from "@/components/lib/utils.js";

/** Local Git probe used only for the per-project “branch not found” warning. */
export type WorktreeGitService = Pick<IGitService, "getLocalBranches">;

/** Drafts commit on blur: settings files are not rewritten on every keystroke. */
interface WorktreeOverrideDraft {
  defaultBaseBranch: string;
  branchPrefix: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function WorktreesProjectRow({
  workspacePath,
  label,
  override,
  gitService,
  writeOverride,
}: {
  workspacePath: string;
  label?: string;
  override: WorktreeProjectOverrideSettings | undefined;
  gitService: WorktreeGitService;
  writeOverride: (
    workspacePath: string,
    next: WorktreeProjectOverrideSettings | null,
  ) => Promise<void> | void;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<WorktreeOverrideDraft>({
    defaultBaseBranch: override?.defaultBaseBranch ?? "",
    branchPrefix: override?.branchPrefix ?? "",
  });
  /** Lazily probed local branch names; undefined until the row is expanded and probed. */
  const [localBranchNames, setLocalBranchNames] = useState<ReadonlySet<string> | null>(null);

  // Fetch local branches only for the expanded row; collapsed rows never hit Git.
  useEffect(() => {
    if (!expanded || localBranchNames !== null) {
      return;
    }
    let cancelled = false;
    gitService
      .getLocalBranches({ workspacePath })
      .then((result) => {
        if (!cancelled) {
          setLocalBranchNames(new Set(result.branches.map((branch) => branch.name)));
        }
      })
      .catch((error) => {
        // 分支探测只服务于温和告警；失败时静默降级为“未知分支列表”，不打扰用户。
        if (!cancelled) {
          setLocalBranchNames(new Set<string>());
        }
        logger.warn("[WorktreesSection] 获取本地分支失败", {
          workspacePath,
          error: getErrorMessage(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, gitService, localBranchNames, workspacePath]);

  const hasOverride = Boolean(override?.defaultBaseBranch || override?.branchPrefix);
  const trimmedBaseBranch = draft.defaultBaseBranch.trim();
  const defaultBaseBranchUnknown =
    expanded &&
    trimmedBaseBranch.length > 0 &&
    localBranchNames !== null &&
    !localBranchNames.has(trimmedBaseBranch);

  const commitDraft = useCallback(() => {
    const entry: WorktreeProjectOverrideSettings = {};
    if (trimmedBaseBranch) {
      entry.defaultBaseBranch = trimmedBaseBranch;
    }
    const trimmedPrefix = draft.branchPrefix.trim();
    if (trimmedPrefix) {
      entry.branchPrefix = trimmedPrefix;
    }
    // WTS-02：两个字段都清空即删除条目，回到全局继承（与 Reset to global 同语义）。
    void writeOverride(workspacePath, Object.keys(entry).length > 0 ? entry : null);
  }, [draft.branchPrefix, trimmedBaseBranch, writeOverride, workspacePath]);

  const handleReset = useCallback(() => {
    setDraft({ defaultBaseBranch: "", branchPrefix: "" });
    if (override) {
      void writeOverride(workspacePath, null);
    }
  }, [override, writeOverride, workspacePath]);

  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-hover"
        onClick={() => setExpanded((previous) => !previous)}
      >
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-foreground-subtle transition-transform",
            expanded ? "" : "-rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
          {label || getPathLeaf(workspacePath)}
        </span>
        {hasOverride ? (
          <SettingsBadge>
            {intl.formatMessage({ id: "settings.worktrees.projects.customBadge" })}
          </SettingsBadge>
        ) : null}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-3 px-4 pb-4 pl-11">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`worktrees-base-branch-${workspacePath}`}
              className="text-ui-sm font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: "settings.worktrees.projects.defaultBaseBranch" })}
            </label>
            <Input
              id={`worktrees-base-branch-${workspacePath}`}
              value={draft.defaultBaseBranch}
              autoComplete="off"
              spellCheck={false}
              placeholder={intl.formatMessage({
                id: "settings.worktrees.projects.defaultBaseBranchPlaceholder",
              })}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  defaultBaseBranch: event.target.value,
                }))
              }
              onBlur={commitDraft}
              className="font-mono"
            />
            {defaultBaseBranchUnknown ? (
              <p className="flex items-start gap-1.5 text-ui-sm text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {intl.formatMessage({ id: "settings.worktrees.projects.defaultBaseBranchUnknown" })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`worktrees-branch-prefix-${workspacePath}`}
              className="text-ui-sm font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: "settings.worktrees.projects.branchPrefix" })}
            </label>
            <Input
              id={`worktrees-branch-prefix-${workspacePath}`}
              value={draft.branchPrefix}
              autoComplete="off"
              spellCheck={false}
              placeholder={intl.formatMessage({
                id: "settings.worktrees.projects.branchPrefixPlaceholder",
              })}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, branchPrefix: event.target.value }))
              }
              onBlur={commitDraft}
              className="font-mono"
            />
          </div>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasOverride}
              onClick={handleReset}
            >
              {intl.formatMessage({ id: "settings.worktrees.projects.resetToGlobal" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorktreesProjectOverridesCard({
  settings,
  onUpdate,
  workspaceTabs,
  recentProjects,
  gitService,
}: {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
  workspaceTabs: readonly WorktreeTaskProjectTab[];
  recentProjects: readonly string[];
  gitService: WorktreeGitService;
}) {
  const { intl } = useZCodeIntl();
  const projects = buildWorktreeTaskProjects({
    tabs: workspaceTabs,
    recentProjects,
    activeWorkspaceKey: "",
  });

  const writeOverride = useCallback(
    (workspacePath: string, next: WorktreeProjectOverrideSettings | null) => {
      const current: Record<string, WorktreeProjectOverrideSettings> = {
        ...settings?.worktreeProjectOverrides,
      };
      if (next && (next.defaultBaseBranch || next.branchPrefix)) {
        current[workspacePath] = next;
      } else {
        // WTS-02：Reset to global 即删除条目。
        delete current[workspacePath];
      }
      return onUpdate({ worktreeProjectOverrides: current });
    },
    [onUpdate, settings],
  );

  return (
    <SettingsGroupCard>
      <div className="px-4 py-3">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.worktrees.projects" })}
        </div>
        <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.worktrees.projects.description" })}
        </div>
      </div>
      {projects.length === 0 ? (
        <div className="border-t border-border px-4 py-6 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.worktrees.projects.empty" })}
        </div>
      ) : (
        projects.map((project) => (
          <WorktreesProjectRow
            key={project.workspacePath}
            workspacePath={project.workspacePath}
            label={project.label}
            override={settings?.worktreeProjectOverrides?.[project.workspacePath]}
            gitService={gitService}
            writeOverride={writeOverride}
          />
        ))
      )}
    </SettingsGroupCard>
  );
}
