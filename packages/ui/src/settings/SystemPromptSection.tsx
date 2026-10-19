import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Monitor, Server } from "lucide-react";
import {
  TID_SETTINGS_SYSTEM_PROMPT_DIRTY_NOTE,
  TID_SETTINGS_SYSTEM_PROMPT_RESET_ALL,
  TID_SETTINGS_SYSTEM_PROMPT_RESET_ALL_CONFIRM,
  TID_SETTINGS_SYSTEM_PROMPT_SECTION,
  type SystemPromptOverrideKey,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SystemPromptAssembledPreview, SystemPromptRow } from "@/settings/SystemPromptRow.js";
import { useSystemPromptOverrides, type ResetEntry } from "@/hooks/useSystemPromptOverrides.js";
import { useOutputStyles } from "@/hooks/useOutputStyles.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceHeaderHostLabel } from "@/lib/remoteWorkspaceHistory.js";
import {
  getUserInstructionsHostKey,
  getUserInstructionsRevealDirectory,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";
import {
  buildAssembledSystemPromptText,
  describeSystemPromptSize,
  resolveSystemPromptDefault,
  SYSTEM_PROMPT_SECTION_TITLE_IDS,
  SYSTEM_PROMPT_SECTION_VARIABLE_HINTS,
  isSystemPromptSectionOfferedOnHost,
  type EditableSystemPromptSection,
  type SystemPromptIntl,
} from "@/settings/systemPromptEditorModel.js";
import type { SystemPromptRowData } from "@/settings/SystemPromptRow.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

interface SystemPromptSectionProps {
  isDesktop: boolean;
  activeTarget: UserInstructionsHostTarget;
  onDirtyChange: (dirty: boolean) => void;
}

export function SystemPromptSection({
  isDesktop,
  activeTarget,
  onDirtyChange,
}: SystemPromptSectionProps) {
  const { intl } = useZCodeIntl();
  if (!isDesktop) {
    return (
      <div className="space-y-3">
        <SectionDescription />
        <div
          data-testid={TID_SETTINGS_SYSTEM_PROMPT_SECTION}
          className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.systemPrompt.desktopOnly" })}
        </div>
      </div>
    );
  }
  return <DesktopSystemPromptSection activeTarget={activeTarget} onDirtyChange={onDirtyChange} />;
}

function SectionDescription() {
  const { intl } = useZCodeIntl();
  return (
    <div className="text-ui-base font-medium text-foreground-subtle">
      {intl.formatMessage({ id: "settings.systemPrompt.description" })}
    </div>
  );
}

function DesktopSystemPromptSection({
  activeTarget,
  onDirtyChange,
}: {
  activeTarget: UserInstructionsHostTarget;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [pinnedTarget, setPinnedTarget] = useState(activeTarget);
  const view = useSystemPromptOverrides(pinnedTarget);
  const { getOverridesDirectory, restoreDefault, resetAllCustomized } = view;
  const outputStyles = useOutputStyles(pinnedTarget);
  const activeHostKey = getUserInstructionsHostKey(activeTarget);
  const pinnedHostKey = view.hostKey;
  const declinedHostKeyRef = useRef<string | null>(null);
  const activeTargetRef = useRef(activeTarget);
  // Key of the row whose Restore confirmation is open. The reviewed revision is captured by that
  // confirmation itself, when it opens.
  const [pendingRestoreKey, setPendingRestoreKey] = useState<SystemPromptOverrideKey | null>(null);
  const [pendingReset, setPendingReset] = useState<readonly ResetEntry[] | null>(null);
  useLayoutEffect(() => {
    activeTargetRef.current = activeTarget;
  }, [activeTarget]);

  useEffect(() => {
    if (activeHostKey === pinnedHostKey) {
      declinedHostKeyRef.current = null;
      setPinnedTarget(activeTarget);
      return;
    }
    if (!view.editorDirty) {
      declinedHostKeyRef.current = null;
      setPinnedTarget(activeTarget);
      return;
    }
    if (declinedHostKeyRef.current === activeHostKey) return;
    declinedHostKeyRef.current = activeHostKey;
    const requestedHostKey = activeHostKey;
    void useConfirmDialogStore
      .getState()
      .requestConfirmation({
        title: intl.formatMessage({ id: "settings.systemPrompt.discard.title" }),
        description: intl.formatMessage({ id: "settings.systemPrompt.discard.hostChanged" }),
        confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.discard.confirm" }),
        confirmVariant: "destructive",
      })
      .then((confirmed) => {
        const latest = activeTargetRef.current;
        if (!confirmed || getUserInstructionsHostKey(latest) !== requestedHostKey) return;
        declinedHostKeyRef.current = null;
        setPinnedTarget(latest);
      });
  }, [activeHostKey, activeTarget, intl, pinnedHostKey, view.editorDirty]);

  useEffect(() => {
    onDirtyChange(view.editorDirty);
  }, [onDirtyChange, view.editorDirty]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Restore and reset confirmations capture revisions of the previous pinned host, so drop them
  // when the pinned host changes.
  useEffect(() => {
    setPendingRestoreKey(null);
    setPendingReset(null);
  }, [pinnedHostKey]);

  const hasActiveOutputStyle =
    outputStyles.status === "ready" &&
    outputStyles.activeStyleId !== null &&
    outputStyles.activeStyleId !== "default" &&
    Boolean(
      outputStyles.styles.find((style) => style.id === outputStyles.activeStyleId)?.content.trim(),
    );
  const identityBaselineReady = outputStyles.status === "ready";
  const identityUnavailableId =
    outputStyles.status === "failed" || outputStyles.status === "unsupported"
      ? "settings.systemPrompt.identityBaselineUnavailable"
      : "settings.systemPrompt.identityBaselineLoading";
  const draftBlockReason = view.editorDirty
    ? intl.formatMessage({ id: "settings.systemPrompt.blockedByDraft" })
    : undefined;
  const hostLabel = formatHostLabel(pinnedTarget, intl);

  // Rows, sizes and the assembled text depend on the listing and the output style only, so a
  // keystroke in the draft does not recompute them.
  const { sectionViews, overriddenEntries, assembledText } = useMemo(() => {
    const built: SystemPromptRowData[] = view.sections
      .filter((section) => isSystemPromptSectionOfferedOnHost(section.key, view.isRemote))
      .map((section) => {
        const defaultContent = resolveSystemPromptDefault(section, hasActiveOutputStyle);
        const effectiveContent = section.overrideContent ?? defaultContent;
        return {
          section,
          defaultContent,
          effectiveContent,
          size: describeSystemPromptSize(effectiveContent),
          variableHint: SYSTEM_PROMPT_SECTION_VARIABLE_HINTS[section.key],
        };
      });
    return {
      sectionViews: built,
      overriddenEntries: built
        .filter((row) => row.section.isOverridden)
        .map(
          (row): ResetEntry => ({ key: row.section.key, expectedRevision: row.section.revision }),
        ),
      assembledText: buildAssembledSystemPromptText(
        new Map(built.map((row) => [row.section.key, row.effectiveContent] as const)),
      ),
    };
  }, [view.sections, view.isRemote, hasActiveOutputStyle]);

  const openFolder = useCallback(async () => {
    try {
      const directory = await getOverridesDirectory();
      if ((await platform.openInFileManager(directory)).success) return;
      // The overrides folder is created on the first save, so it can be missing; fall back to its
      // parent (the ZCode data folder) so the action still lands the user in the right place.
      const parent = getUserInstructionsRevealDirectory(directory);
      if ((await platform.openInFileManager(parent)).success) return;
    } catch {
      // Reported through the toast below; the failure details are not shown to the user.
    }
    toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
  }, [getOverridesDirectory, intl, platform]);

  const sectionTitle = (key: EditableSystemPromptSection["key"]) =>
    intl.formatMessage({ id: SYSTEM_PROMPT_SECTION_TITLE_IDS[key] });

  // Stable callbacks let the memoized rows skip re-rendering while only the draft changes.
  const handleToggleRestore = useCallback(
    (section: EditableSystemPromptSection) =>
      setPendingRestoreKey((current) => (current === section.key ? null : section.key)),
    [],
  );
  const handleCancelRestore = useCallback(() => setPendingRestoreKey(null), []);
  const handleConfirmRestore = useCallback(
    (key: SystemPromptOverrideKey, reviewedRevision: string | null | undefined) => {
      setPendingRestoreKey(null);
      void restoreDefault(key, reviewedRevision);
    },
    [restoreDefault],
  );
  const handleOpenFolder = useCallback(() => void openFolder(), [openFolder]);

  return (
    <div className="space-y-3" data-testid={TID_SETTINGS_SYSTEM_PROMPT_SECTION}>
      <SectionDescription />
      {activeHostKey !== pinnedHostKey ? (
        <Alert variant="warning">
          <AlertDescription>
            {intl.formatMessage(
              { id: "settings.systemPrompt.pinnedHostNotice" },
              { host: hostLabel },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center gap-2 text-ui-xs text-foreground-subtlest">
        {view.isRemote ? (
          <Server className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Monitor className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="break-all">{hostLabel}</span>
      </div>
      <p className="text-ui-xs leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.systemPrompt.incognitoNote" })}
      </p>
      {view.editorDirty && view.editor ? (
        <Alert variant="warning">
          <AlertDescription data-testid={TID_SETTINGS_SYSTEM_PROMPT_DIRTY_NOTE}>
            {intl.formatMessage(
              { id: "settings.systemPrompt.dirtyNote" },
              { section: sectionTitle(view.editor.key) },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {view.status === "waiting" ? (
        <StatusCard>{intl.formatMessage({ id: "settings.systemPrompt.waitingRemote" })}</StatusCard>
      ) : view.status === "unsupported" ? (
        <StatusCard>
          {intl.formatMessage({ id: "settings.systemPrompt.unsupportedHost" })}
        </StatusCard>
      ) : view.status === "failed" ? (
        <StatusCard>
          <div className="space-y-3">
            <div>{intl.formatMessage({ id: "settings.systemPrompt.loadFailed" })}</div>
            <Button size="sm" variant="outline" onClick={view.reload}>
              {intl.formatMessage({ id: "settings.systemPrompt.retry" })}
            </Button>
          </div>
        </StatusCard>
      ) : view.status === "loading" ? (
        <StatusCard>{intl.formatMessage({ id: "common.loading" })}</StatusCard>
      ) : (
        <>
          {overriddenEntries.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.systemPrompt.customizedCount" },
                  { count: overriddenEntries.length },
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={view.editor?.saving || view.editorDirty}
                title={draftBlockReason}
                data-testid={TID_SETTINGS_SYSTEM_PROMPT_RESET_ALL}
                onClick={() => setPendingReset(overriddenEntries)}
              >
                {intl.formatMessage({ id: "settings.systemPrompt.resetAll" })}
              </Button>
            </div>
          ) : null}
          {pendingReset ? (
            <div
              className="space-y-2 rounded-xl border border-border px-4 py-3"
              data-testid={TID_SETTINGS_SYSTEM_PROMPT_RESET_ALL_CONFIRM}
            >
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.systemPrompt.resetAll.title" })}
              </div>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.systemPrompt.resetAll.description" },
                  { host: hostLabel, count: pendingReset.length },
                )}
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-ui-sm text-foreground">
                {pendingReset.map((entry) => (
                  <li key={entry.key}>{sectionTitle(entry.key)}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    const entries = pendingReset;
                    setPendingReset(null);
                    void resetAllCustomized(entries);
                  }}
                >
                  {intl.formatMessage({ id: "settings.systemPrompt.resetAll.confirm" })}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPendingReset(null)}>
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
              </div>
            </div>
          ) : null}
          <SettingsGroupCard>
            {sectionViews.map((row, index) => {
              const isIdentity = row.section.key === "identity-intro";
              const identityWaiting =
                isIdentity && !row.section.isOverridden && !identityBaselineReady;
              return (
                <SystemPromptRow
                  key={row.section.key}
                  view={view}
                  row={row}
                  index={index}
                  identityWaiting={identityWaiting}
                  identityNoteId={
                    isIdentity && !identityBaselineReady ? identityUnavailableId : null
                  }
                  hostLabel={hostLabel}
                  draftBlockReason={draftBlockReason}
                  restoring={pendingRestoreKey === row.section.key}
                  onToggleRestore={handleToggleRestore}
                  onCancelRestore={handleCancelRestore}
                  onConfirmRestore={handleConfirmRestore}
                  onOpenFolder={handleOpenFolder}
                />
              );
            })}
          </SettingsGroupCard>
          {sectionViews.length > 0 ? <SystemPromptAssembledPreview text={assembledText} /> : null}
        </>
      )}
    </div>
  );
}

function StatusCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {children}
    </div>
  );
}

function formatHostLabel(target: UserInstructionsHostTarget, intl: SystemPromptIntl): string {
  if (getUserInstructionsHostKey(target) === "local") {
    return intl.formatMessage({ id: "settings.systemPrompt.host.local" });
  }
  if (target.remoteTarget) return formatRemoteWorkspaceHeaderHostLabel(target.remoteTarget);
  return target.workspaceIdentity?.trim() || target.workspacePath || "";
}
