import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RotateCcwIcon } from "lucide-react";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import {
  composeBranchName,
  computeWorktreeTargetPath,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  isValidCustomWorktreeLocationPath,
  type WorktreeTaskProjectTab,
} from "@/command-center/worktreeTaskFlow.js";
import { generateWorktreeBranchNameCandidate } from "@/command-center/worktreeNameGenerator.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  WorktreesProjectOverridesCard,
  type WorktreeGitService,
} from "@/settings/WorktreesProjectOverridesCard.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

// Fallback sample when no local workspace tab is open; the example prefers a real project path.
const LOCATION_EXAMPLE_FALLBACK_PROJECT_PATH = "~/projects/demo-app";
// Stage F review requirement: preset modes (sibling/inside/global) show a fixed short example; custom still computes the real path.
const WORKTREE_LOCATION_EXAMPLES: Partial<Record<WorktreeLocationMode, string>> = {
  sibling: "example-repo-worktrees/my-branch",
  inside: "example-repo/.worktrees/my-branch",
  global: "~/.zcode/worktrees/example-repo/my-branch",
};

/**
 * Full-width text setting row (2026-10-13 review): the 192px SettingsRow control column clipped
 * mono inputs, so label/description stack above a flex-1 input with an icon reset button.
 */
function WorktreeTextSettingRow({
  label,
  description,
  inputId,
  value,
  placeholder,
  onValueChange,
  onCommit,
  onRevert,
  onReset,
  resetDisabled,
  resetLabel,
  example,
}: {
  label: string;
  description: string;
  inputId: string;
  value: string;
  placeholder: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  /** Escape handler: restore the draft from the effective saved value. */
  onRevert: () => void;
  onReset: () => void;
  resetDisabled: boolean;
  resetLabel: string;
  example: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <label htmlFor={inputId} className="block text-ui-base font-medium text-foreground">
        {label}
      </label>
      <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</div>
      <div className="mt-3 flex items-center gap-2">
        <Input
          id={inputId}
          size="lg"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            // Enter commits, Escape reverts to the effective saved value.
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onRevert();
              event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 font-mono"
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={resetDisabled}
                aria-label={intl.formatMessage({ id: resetLabel })}
                onClick={onReset}
              >
                <RotateCcwIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{intl.formatMessage({ id: resetLabel })}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <p className="mt-3 truncate font-mono text-ui-sm text-foreground-subtle" title={example}>
        {example}
      </p>
    </div>
  );
}

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
  // Unset (or explicitly empty — normalizeSettingsPatch deletes the field) resolves to the
  // flow default (zcode/, 2026-10-13); display shows the effective value.
  const branchPrefix = settings?.worktreeBranchPrefix || DEFAULT_WORKTREE_BRANCH_PREFIX;
  const savedBranchPrefixIsEmpty = (settings?.worktreeBranchPrefix ?? "") === "";
  // Stage F: global storage is offered only on platforms implementing IPlatformService.getAppWorktreesDir (desktop).
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
    // An empty string deletes the field via normalizeSettingsPatch (back to the sibling default); intermediate states (relative paths) are not persisted.
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
    if (trimmed.length === 0) {
      setBranchPrefixDraft(DEFAULT_WORKTREE_BRANCH_PREFIX);
    }
    // Empty string deletes the field via normalizeSettingsPatch; the display (and the flow)
    // then resolve to DEFAULT_WORKTREE_BRANCH_PREFIX.
    if (trimmed !== branchPrefix) {
      void onUpdate({ worktreeBranchPrefix: trimmed });
    }
  }, [branchPrefix, branchPrefixDraft, onUpdate]);

  const handleResetBranchPrefix = useCallback(() => {
    setBranchPrefixDraft(DEFAULT_WORKTREE_BRANCH_PREFIX);
    if (!savedBranchPrefixIsEmpty) {
      void onUpdate({ worktreeBranchPrefix: "" });
    }
  }, [onUpdate, savedBranchPrefixIsEmpty]);

  // Deterministic preview (review 2026-10-13): "Preview: <prefix><generated name>" with a
  // fixed RNG so the generated part does not flicker between renders.
  const branchPrefixExample = composeBranchName(
    branchPrefixDraft,
    generateWorktreeBranchNameCandidate(() => 0),
  );

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
          // computeWorktreeTargetPath takes customPath as string | null; a conditional spread would leave an undefined shape.
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
                {/* Review 2026-10-13: custom location is temporarily disabled — the preset
                    modes cover current needs; a previously saved custom mode keeps working. */}
                <SelectItem value="custom" disabled>
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
        <WorktreeTextSettingRow
          label={intl.formatMessage({ id: "settings.worktrees.branchPrefix" })}
          description={intl.formatMessage({ id: "settings.worktrees.branchPrefix.description" })}
          inputId="worktrees-branch-prefix"
          value={branchPrefixDraft}
          placeholder={DEFAULT_WORKTREE_BRANCH_PREFIX}
          onValueChange={setBranchPrefixDraft}
          onCommit={commitBranchPrefix}
          onRevert={() => setBranchPrefixDraft(branchPrefix)}
          onReset={handleResetBranchPrefix}
          resetDisabled={branchPrefixDraft === branchPrefix && savedBranchPrefixIsEmpty}
          resetLabel="settings.worktrees.branchPrefix.reset"
          example={intl.formatMessage(
            { id: "settings.worktrees.branchPrefix.example" },
            { name: branchPrefixExample },
          )}
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
