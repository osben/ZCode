import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { AppSettings, WorktreeLocationMode } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  composeBranchName,
  computeWorktreeTargetPath,
  isValidCustomWorktreeLocationPath,
  type WorktreeTaskProjectTab,
} from "@/command-center/worktreeTaskFlow.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  WorktreesProjectOverridesCard,
  type WorktreeGitService,
} from "@/settings/WorktreesProjectOverridesCard.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const BRANCH_PREFIX_EXAMPLE_INPUT = "task-name";
// Fallback sample when no local workspace tab is open; the example prefers a real project path.
const LOCATION_EXAMPLE_FALLBACK_PROJECT_PATH = "~/projects/demo-app";
// Stage F 评审要求：预置模式（sibling/inside/global）的示例行用固定短格式，custom 仍计算真实路径。
const WORKTREE_LOCATION_EXAMPLES: Partial<Record<WorktreeLocationMode, string>> = {
  sibling: "example-repo-worktrees/my-branch",
  inside: "example-repo/.worktrees/my-branch",
  global: "~/.zcode/worktrees/example-repo/my-branch",
};

export function WorktreesSection({
  settings,
  onUpdate,
  workspaceTabs,
  recentProjects,
  onSelectDirectory,
  gitService,
}: {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
  /** Open local workspace tabs; reused from the “New task in worktree” project list. */
  workspaceTabs: readonly WorktreeTaskProjectTab[];
  recentProjects: readonly string[];
  onSelectDirectory: () => Promise<string | null>;
  gitService: WorktreeGitService;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const locationMode: WorktreeLocationMode = settings?.worktreeLocationMode ?? "sibling";
  const branchPrefix = settings?.worktreeBranchPrefix ?? "";
  // Stage F：全局存储仅在实现了 IPlatformService.getAppWorktreesDir 的平台（desktop）可选。
  const supportsGlobalWorktreeStorage = typeof platform?.getAppWorktreesDir === "function";

  // WTS-01: the custom path is a draft until blur; invalid values stay as a field-level error and are not persisted.
  // The error is withheld for a still-empty field right after revealing it; emptiness itself is enforced
  // by the creation flow (computeWorktreeTargetPath returns null), not by yelling on first reveal.
  const [customPathDraft, setCustomPathDraft] = useState(
    settings?.worktreeCustomLocationPath ?? "",
  );
  const customPathDraftInvalid =
    locationMode === "custom" &&
    customPathDraft.trim().length > 0 &&
    !isValidCustomWorktreeLocationPath(customPathDraft);
  const [branchPrefixDraft, setBranchPrefixDraft] = useState(branchPrefix);
  // Settings arrive asynchronously; keep the drafts in sync with the saved values so a
  // blur on a still-empty draft cannot delete a saved setting (CodeRabbit data-integrity).
  useEffect(() => {
    setCustomPathDraft(settings?.worktreeCustomLocationPath ?? "");
  }, [settings?.worktreeCustomLocationPath]);
  useEffect(() => {
    setBranchPrefixDraft(branchPrefix);
  }, [branchPrefix]);

  const handleLocationModeChange = useCallback(
    (nextMode: string) => {
      void onUpdate({ worktreeLocationMode: nextMode as WorktreeLocationMode });
    },
    [onUpdate],
  );

  const commitCustomPath = useCallback(() => {
    const trimmed = customPathDraft.trim();
    // 空串经 normalizeSettingsPatch 删除字段（回到 sibling 约定）；中间态（相对路径）不落盘。
    if (
      (trimmed.length === 0 || isValidCustomWorktreeLocationPath(trimmed)) &&
      trimmed !== (settings?.worktreeCustomLocationPath ?? "")
    ) {
      void onUpdate({ worktreeCustomLocationPath: trimmed });
    }
  }, [customPathDraft, onUpdate, settings]);

  const handleChooseFolder = useCallback(async () => {
    const selectedDir = await onSelectDirectory();
    if (selectedDir && isValidCustomWorktreeLocationPath(selectedDir)) {
      setCustomPathDraft(selectedDir);
      if (selectedDir !== (settings?.worktreeCustomLocationPath ?? "")) {
        void onUpdate({ worktreeCustomLocationPath: selectedDir });
      }
    }
  }, [onSelectDirectory, onUpdate, settings]);

  const commitBranchPrefix = useCallback(() => {
    const trimmed = branchPrefixDraft.trim();
    if (trimmed !== branchPrefix) {
      // 空串经 normalizeSettingsPatch 删除字段 = Reset to default。
      void onUpdate({ worktreeBranchPrefix: trimmed });
    }
  }, [branchPrefix, branchPrefixDraft, onUpdate]);

  const handleResetBranchPrefix = useCallback(() => {
    setBranchPrefixDraft("");
    if (branchPrefix) {
      void onUpdate({ worktreeBranchPrefix: "" });
    }
  }, [branchPrefix, onUpdate]);

  const branchPrefixExample = composeBranchName(branchPrefixDraft, BRANCH_PREFIX_EXAMPLE_INPUT);

  // Recommendation (a): the location row always previews a concrete target path for the current
  // mode. Preset modes use the fixed short examples (Stage F); custom computes the real path,
  // re-derivable from a real open project when one exists.
  const exampleProjectPath =
    workspaceTabs.find((tab) => !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity)
      ?.workspacePath ?? LOCATION_EXAMPLE_FALLBACK_PROJECT_PATH;
  const exampleCustomPath = customPathDraft.trim() || settings?.worktreeCustomLocationPath;
  const locationExamplePath =
    locationMode === "custom"
      ? computeWorktreeTargetPath(exampleProjectPath, branchPrefixExample, {
          mode: locationMode,
          // computeWorktreeTargetPath 的 customPath 是 string | null；条件展开会留下 undefined 形状。
          customPath: exampleCustomPath || null,
          appWorktreesDir: null,
        })
      : (WORKTREE_LOCATION_EXAMPLES[locationMode] ?? null);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.worktrees.location" })}
          description={intl.formatMessage({
            id:
              locationMode === "global"
                ? "settings.worktrees.location.global.description"
                : "settings.worktrees.location.description",
          })}
          control={
            <Select value={locationMode} onValueChange={handleLocationModeChange}>
              <SelectTrigger size="lg" className="w-64 min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sibling">
                  {intl.formatMessage({ id: "settings.worktrees.location.sibling" })}
                </SelectItem>
                <SelectItem value="inside">
                  {intl.formatMessage({ id: "settings.worktrees.location.inside" })}
                </SelectItem>
                {supportsGlobalWorktreeStorage ? (
                  <SelectItem value="global">
                    {intl.formatMessage({ id: "settings.worktrees.location.global" })}
                  </SelectItem>
                ) : null}
                <SelectItem value="custom">
                  {intl.formatMessage({ id: "settings.worktrees.location.custom" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
          detail={
            <>
              {locationMode === "custom" ? (
                <div className="mt-3 flex flex-col gap-2">
                  <label
                    htmlFor="worktrees-custom-location"
                    className="text-ui-sm font-medium text-foreground-subtle"
                  >
                    {intl.formatMessage({ id: "settings.worktrees.location.customPath" })}
                  </label>
                  <div className="flex items-center gap-2">
                    <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
                    <Input
                      id="worktrees-custom-location"
                      size="lg"
                      value={customPathDraft}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={customPathDraftInvalid || undefined}
                      placeholder={intl.formatMessage({
                        id: "settings.worktrees.location.customPathPlaceholder",
                      })}
                      onChange={(event) => setCustomPathDraft(event.target.value)}
                      onBlur={commitCustomPath}
                      onKeyDown={(event) => {
                        // Enter фиксирует, Escape откатывает к сохранённому значению.
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitCustomPath();
                          event.currentTarget.blur();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setCustomPathDraft(settings?.worktreeCustomLocationPath ?? "");
                          event.currentTarget.blur();
                        }
                      }}
                      className="flex-1 font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleChooseFolder()}
                    >
                      {intl.formatMessage({ id: "settings.worktrees.chooseFolder" })}
                    </Button>
                  </div>
                  {customPathDraftInvalid ? (
                    <p className="text-ui-sm text-destructive">
                      {intl.formatMessage({ id: "settings.worktrees.location.customPathInvalid" })}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {locationExamplePath ? (
                <p
                  className="mt-3 truncate font-mono text-ui-sm text-foreground-subtle"
                  title={locationExamplePath}
                >
                  {intl.formatMessage({ id: "settings.worktrees.location.example" })}:{" "}
                  {locationExamplePath}
                </p>
              ) : null}
            </>
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.worktrees.branchPrefix" })}
          description={intl.formatMessage({ id: "settings.worktrees.branchPrefix.description" })}
          control={
            <div className="flex w-full items-center justify-end gap-2">
              <Input
                aria-label={intl.formatMessage({ id: "settings.worktrees.branchPrefix" })}
                size="lg"
                value={branchPrefixDraft}
                autoComplete="off"
                spellCheck={false}
                placeholder={intl.formatMessage({
                  id: "settings.worktrees.branchPrefix.placeholder",
                })}
                onChange={(event) => setBranchPrefixDraft(event.target.value)}
                onBlur={commitBranchPrefix}
                onKeyDown={(event) => {
                  // Enter фиксирует, Escape откатывает к сохранённому значению.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitBranchPrefix();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setBranchPrefixDraft(branchPrefix);
                    event.currentTarget.blur();
                  }
                }}
                className="w-64 font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!branchPrefix && !branchPrefixDraft.trim()}
                onClick={handleResetBranchPrefix}
              >
                {intl.formatMessage({ id: "settings.worktrees.branchPrefix.reset" })}
              </Button>
            </div>
          }
          detail={
            <p className="mt-3 font-mono text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.worktrees.branchPrefix.example" },
                { name: branchPrefixExample },
              )}
            </p>
          }
        />
      </SettingsGroupCard>

      <WorktreesProjectOverridesCard
        settings={settings}
        onUpdate={onUpdate}
        workspaceTabs={workspaceTabs}
        recentProjects={recentProjects}
        gitService={gitService}
      />
    </div>
  );
}
