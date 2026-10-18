import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Monitor, RotateCcw, Server } from "lucide-react";
import {
  TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED,
  TID_SETTINGS_SYSTEM_PROMPT_EDIT,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE,
  TID_SETTINGS_SYSTEM_PROMPT_ROW,
  TID_SETTINGS_SYSTEM_PROMPT_SECTION,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SystemPromptEditor } from "@/settings/SystemPromptEditor.js";
import { useSystemPromptOverrides } from "@/hooks/useSystemPromptOverrides.js";
import { useOutputStyles } from "@/hooks/useOutputStyles.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceHeaderHostLabel } from "@/lib/remoteWorkspaceHistory.js";
import { cn } from "@/components/lib/utils.js";
import {
  getUserInstructionsHostKey,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";
import {
  resolveEffectiveSystemPrompt,
  resolveSystemPromptDefault,
  SYSTEM_PROMPT_SECTION_TITLE_IDS,
  SYSTEM_PROMPT_SECTION_VARIABLE_HINTS,
  isSystemPromptSectionOfferedOnHost,
} from "@/settings/systemPromptEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

interface SystemPromptSectionProps {
  isDesktop: boolean;
  activeTarget: UserInstructionsHostTarget;
  onDirtyChange: (dirty: boolean) => void;
}

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

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
  const [pinnedTarget, setPinnedTarget] = useState(activeTarget);
  const view = useSystemPromptOverrides(pinnedTarget);
  const outputStyles = useOutputStyles(pinnedTarget);
  const activeHostKey = getUserInstructionsHostKey(activeTarget);
  const pinnedHostKey = view.hostKey;
  const declinedHostKeyRef = useRef<string | null>(null);
  const activeTargetRef = useRef(activeTarget);
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

  const hasActiveOutputStyle =
    outputStyles.status === "ready" &&
    outputStyles.activeStyleId !== null &&
    outputStyles.activeStyleId !== "default" &&
    Boolean(
      outputStyles.styles.find((style) => style.id === outputStyles.activeStyleId)?.content.trim(),
    );
  const identityBaselineReady = outputStyles.status === "ready";

  const rows = view.sections
    .filter((section) => isSystemPromptSectionOfferedOnHost(section.key, view.isRemote))
    .map((section) => {
      const defaultContent = resolveSystemPromptDefault(section, hasActiveOutputStyle);
      return {
        section,
        effectiveContent: resolveEffectiveSystemPrompt(section, defaultContent),
        variableHint: SYSTEM_PROMPT_SECTION_VARIABLE_HINTS[section.key],
      };
    });

  return (
    <div className="space-y-3" data-testid={TID_SETTINGS_SYSTEM_PROMPT_SECTION}>
      <SectionDescription />
      {activeHostKey !== pinnedHostKey ? (
        <Alert variant="warning">
          <AlertDescription>
            {intl.formatMessage(
              { id: "settings.systemPrompt.pinnedHostNotice" },
              { host: formatHostLabel(pinnedTarget, intl) },
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
        <span className="break-all">{formatHostLabel(pinnedTarget, intl)}</span>
      </div>
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
          <SettingsGroupCard>
            {rows.map(({ section, effectiveContent, variableHint }, index) => (
              <div
                key={section.key}
                className={cn(index > 0 && "border-t border-border")}
                data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_ROW, section.key)}
                data-section-key={section.key}
              >
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ui-base font-medium text-foreground">
                        {intl.formatMessage({
                          id: SYSTEM_PROMPT_SECTION_TITLE_IDS[section.key],
                        })}
                      </span>
                      {section.isOverridden ? (
                        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-ui-xs text-foreground-subtle">
                          <span
                            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED, section.key)}
                          >
                            {intl.formatMessage({ id: "settings.systemPrompt.customized" })}
                          </span>
                        </span>
                      ) : null}
                    </div>
                    {variableHint ? (
                      <p className="mt-1 text-ui-xs leading-5 text-foreground-subtle">
                        {intl.formatMessage({ id: variableHint.id }, variableHint.values)}
                      </p>
                    ) : null}
                    {section.key === "identity-intro" && !identityBaselineReady ? (
                      <p className="mt-1 text-ui-xs leading-5 text-foreground-subtle">
                        {intl.formatMessage({
                          id:
                            outputStyles.status === "failed" ||
                            outputStyles.status === "unsupported"
                              ? "settings.systemPrompt.identityBaselineUnavailable"
                              : "settings.systemPrompt.identityBaselineLoading",
                        })}
                      </p>
                    ) : null}
                    {view.editor?.key !== section.key ? (
                      <details className="mt-1 text-ui-sm text-foreground-subtle">
                        <summary className="cursor-pointer">
                          {intl.formatMessage({ id: "settings.systemPrompt.effectivePreview" })}
                        </summary>
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5">
                          {section.key === "identity-intro" &&
                          !identityBaselineReady &&
                          !section.isOverridden
                            ? intl.formatMessage({
                                id:
                                  outputStyles.status === "failed" ||
                                  outputStyles.status === "unsupported"
                                    ? "settings.systemPrompt.identityBaselineUnavailable"
                                    : "settings.systemPrompt.identityBaselineLoading",
                              })
                            : effectiveContent}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      view.editor?.saving ||
                      view.editorDirty ||
                      (section.key === "identity-intro" &&
                        !section.isOverridden &&
                        !identityBaselineReady)
                    }
                    data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_EDIT, section.key)}
                    onClick={() => view.openEditor(section.key, effectiveContent)}
                  >
                    {intl.formatMessage({ id: "settings.systemPrompt.edit" })}
                  </Button>
                  {section.isOverridden ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={view.editor?.saving || view.editorDirty}
                      data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE, section.key)}
                      onClick={() => {
                        void useConfirmDialogStore
                          .getState()
                          .requestConfirmation({
                            title: intl.formatMessage({
                              id: "settings.systemPrompt.restoreConfirm.title",
                            }),
                            description: intl.formatMessage(
                              { id: "settings.systemPrompt.restoreConfirm.description" },
                              {
                                section: intl.formatMessage({
                                  id: SYSTEM_PROMPT_SECTION_TITLE_IDS[section.key],
                                }),
                                host: formatHostLabel(pinnedTarget, intl),
                              },
                            ),
                            confirmLabel: intl.formatMessage({
                              id: "settings.systemPrompt.restoreConfirm.confirm",
                            }),
                            confirmVariant: "destructive",
                          })
                          .then((confirmed) => {
                            if (confirmed) void view.restoreDefault(section.key);
                          });
                      }}
                    >
                      <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
                      {intl.formatMessage({ id: "settings.systemPrompt.restoreDefault" })}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </SettingsGroupCard>
          {view.editor ? <SystemPromptEditor view={view} /> : null}
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

function formatHostLabel(target: UserInstructionsHostTarget, intl: Intl): string {
  if (getUserInstructionsHostKey(target) === "local") {
    return intl.formatMessage({ id: "settings.systemPrompt.host.local" });
  }
  if (target.remoteTarget) return formatRemoteWorkspaceHeaderHostLabel(target.remoteTarget);
  return target.workspaceIdentity?.trim() || target.workspacePath || "";
}
