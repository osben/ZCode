import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Monitor, Plus, RotateCcw, Server, Trash2 } from "lucide-react";
import {
  TID_SETTINGS_INSTRUCTIONS_RETRY,
  TID_SETTINGS_OUTPUT_STYLES_ROW,
  TID_SETTINGS_OUTPUT_STYLES_SECTION,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { useOutputStyles, type OutputStylesView } from "@/hooks/useOutputStyles.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceHeaderHostLabel } from "@/lib/remoteWorkspaceHistory.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  OutputStylesConflictDialog,
  OutputStylesEditorCard,
} from "@/settings/OutputStylesEditorCard.js";
import {
  getUserInstructionsHostKey,
  type UserInstructionsHostTarget,
} from "@/settings/userInstructionsEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

interface OutputStylesSectionProps {
  isDesktop: boolean;
  /** Target host whose ~/.zcode output styles are edited (same semantics as the Instructions section). */
  activeTarget: UserInstructionsHostTarget;
  /** Dirty-draft signal for Settings navigation blocking; the section still owns the draft. */
  onDirtyChange: (dirty: boolean) => void;
}

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * Settings "Output Styles" section (docs/output-styles-settings.md): list built-in and custom
 * styles, activate one, and edit prompts with a diff preview. Built-in defaults live in code;
 * editing one writes an override file, and deleting that file restores the default.
 */
export function OutputStylesSection({
  isDesktop,
  activeTarget,
  onDirtyChange,
}: OutputStylesSectionProps) {
  const { intl } = useZCodeIntl();
  if (!isDesktop) {
    return (
      <div className="space-y-3">
        <SectionDescription />
        <div
          data-testid={TID_SETTINGS_OUTPUT_STYLES_SECTION}
          className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.outputStyles.desktopOnly" })}
        </div>
      </div>
    );
  }
  return <DesktopOutputStylesSection activeTarget={activeTarget} onDirtyChange={onDirtyChange} />;
}

function SectionDescription() {
  const { intl } = useZCodeIntl();
  return (
    <div className="text-ui-base font-medium text-foreground-subtle">
      {intl.formatMessage({ id: "settings.outputStyles.description" })}
    </div>
  );
}

function DesktopOutputStylesSection({
  activeTarget,
  onDirtyChange,
}: {
  activeTarget: UserInstructionsHostTarget;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // Bind the editor to one host while a draft is dirty, mirroring the Instructions section.
  const [pinnedTarget, setPinnedTarget] = useState(activeTarget);
  const view = useOutputStyles(pinnedTarget);
  const activeHostKey = getUserInstructionsHostKey(activeTarget);
  const pinnedHostKey = view.hostKey;
  const declinedHostKeyRef = useRef<string | null>(null);
  const editorDirty = view.editorDirty;
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
    if (!editorDirty) {
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
        title: intl.formatMessage({ id: "settings.outputStyles.discard.title" }),
        description: intl.formatMessage({ id: "settings.outputStyles.discard.hostChanged" }),
        confirmLabel: intl.formatMessage({ id: "settings.outputStyles.discard.confirm" }),
        confirmVariant: "destructive",
      })
      .then((confirmed) => {
        const latest = activeTargetRef.current;
        if (!confirmed || getUserInstructionsHostKey(latest) !== requestedHostKey) return;
        declinedHostKeyRef.current = null;
        setPinnedTarget(latest);
      });
  }, [activeHostKey, activeTarget, editorDirty, intl, pinnedHostKey]);

  useEffect(() => {
    onDirtyChange(editorDirty);
  }, [editorDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  return (
    <div className="space-y-3" data-testid={TID_SETTINGS_OUTPUT_STYLES_SECTION}>
      <SectionDescription />
      {activeHostKey !== pinnedHostKey ? (
        <Alert variant="warning">
          <AlertDescription>
            {intl.formatMessage(
              { id: "settings.outputStyles.pinnedHostNotice" },
              { host: formatHostLabel(pinnedTarget, intl) },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <StylesList view={view} intl={intl} />
      <p className="text-ui-sm leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.outputStyles.effectHint" })}
      </p>
      <OutputStylesConflictDialog view={view} intl={intl} />
    </div>
  );
}

function formatHostLabel(target: UserInstructionsHostTarget, intl: Intl): string {
  if (getUserInstructionsHostKey(target) === "local") {
    return intl.formatMessage({ id: "settings.outputStyles.host.local" });
  }
  if (target.remoteTarget) return formatRemoteWorkspaceHeaderHostLabel(target.remoteTarget);
  return target.workspaceIdentity?.trim() || target.workspacePath || "";
}

function StylesList({ view, intl }: { view: OutputStylesView; intl: Intl }) {
  switch (view.status) {
    case "waiting":
      return <StatusText intl={intl} id="settings.outputStyles.waitingRemote" />;
    case "loading":
      return <StatusText intl={intl} id="common.loading" />;
    case "unsupported":
      return <StatusText intl={intl} id="settings.outputStyles.unsupportedHost" />;
    case "failed":
      return (
        <div className="space-y-3">
          <p className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.outputStyles.loadFailed" })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={view.reload}
            data-testid={TID_SETTINGS_INSTRUCTIONS_RETRY}
          >
            <RotateCcw className="size-4" />
            {intl.formatMessage({ id: "settings.outputStyles.retry" })}
          </Button>
        </div>
      );
    case "ready":
      return (
        <div className="space-y-3">
          <SettingsGroupCard>
            <div className="divide-y divide-border">
              {view.styles.map((style) => (
                <StyleRow key={style.id} style={style} view={view} intl={intl} />
              ))}
            </div>
          </SettingsGroupCard>
          {view.editor === null ? (
            <Button variant="outline" size="sm" onClick={() => view.openEditor("new")}>
              <Plus className="size-4" />
              {intl.formatMessage({ id: "settings.outputStyles.newStyle" })}
            </Button>
          ) : null}
          {view.editor !== null ? <OutputStylesEditorCard view={view} intl={intl} /> : null}
        </div>
      );
  }
}

function StyleRow({
  style,
  view,
  intl,
}: {
  style: OutputStylesView["styles"][number];
  view: OutputStylesView;
  intl: Intl;
}) {
  const isActive = style.id === view.activeStyleId;
  const activating = view.activatingStyleId === style.id;
  const HostIcon = view.isRemote ? Server : Monitor;
  return (
    <div
      className="flex items-start gap-3 px-4 py-3"
      data-testid={TID_SETTINGS_OUTPUT_STYLES_ROW}
      data-style-id={style.id}
    >
      <button
        type="button"
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-input-border text-foreground-subtle hover:border-input-border-hover disabled:opacity-50"
        aria-pressed={isActive}
        aria-label={intl.formatMessage(
          { id: "settings.outputStyles.activateLabel" },
          { name: style.name },
        )}
        disabled={activating || isActive}
        onClick={() => void view.activate(style.id)}
      >
        {isActive ? <Check className="size-3.5 text-foreground" aria-hidden="true" /> : null}
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">{style.name}</span>
          {style.isBuiltIn ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "settings.outputStyles.builtinTag" })}
            </span>
          ) : null}
          {style.isOverridden ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "settings.outputStyles.overriddenTag" })}
            </span>
          ) : null}
          {activating ? (
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </span>
          ) : null}
        </div>
        <p className="text-ui-sm leading-5 text-foreground-subtle">{style.description}</p>
        {style.filePath ? (
          <div className="flex items-center gap-1.5 font-mono text-ui-xs break-all text-foreground-subtlest">
            <HostIcon className="size-3 shrink-0" aria-hidden="true" />
            {style.filePath}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => view.openEditor(style)}>
          {intl.formatMessage({
            id:
              style.isBuiltIn && !style.isOverridden
                ? "settings.outputStyles.customize"
                : "settings.outputStyles.edit",
          })}
        </Button>
        {style.isBuiltIn && style.isOverridden ? (
          <Button variant="ghost" size="sm" onClick={() => void view.restoreDefault(style)}>
            {intl.formatMessage({ id: "settings.outputStyles.restoreDefault" })}
          </Button>
        ) : null}
        {!style.isBuiltIn ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void useConfirmDialogStore
                .getState()
                .requestConfirmation({
                  title: intl.formatMessage({ id: "settings.outputStyles.deleteConfirm.title" }),
                  description: intl.formatMessage(
                    { id: "settings.outputStyles.deleteConfirm.description" },
                    { name: style.name },
                  ),
                  confirmLabel: intl.formatMessage({
                    id: "settings.outputStyles.deleteConfirm.confirm",
                  }),
                  confirmVariant: "destructive",
                })
                .then((confirmed) => {
                  if (confirmed) void view.deleteStyle(style);
                });
            }}
          >
            <Trash2 className="size-4" />
            {intl.formatMessage({ id: "settings.outputStyles.delete" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function StatusText({ intl, id }: { intl: Intl; id: string }) {
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">{intl.formatMessage({ id })}</p>
  );
}
