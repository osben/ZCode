/* eslint-disable max-lines -- The installed Plugin list and details dialog share component groups and Hook-detail rendering; maintaining them together helps match the reference design. */
import type { ReactNode } from "react";
import { AlertTriangle, Cable, ChevronRight, Trash2 } from "lucide-react";
import type {
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginScope,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import { PluginComponentGroups } from "@/settings/PluginComponentGroups.js";
import { buildInstalledPluginDisplayGroups } from "@/settings/pluginManagedResourceGroups.js";
import { isPluginUpdatePending } from "@/settings/pluginStoreListing.js";

export type PluginOptionValueGetter = (
  plugin: ZCodePluginInfo,
  key: string,
  option: ZCodePluginUserConfigOption,
) => string | number | boolean;

export function InstalledPluginDetailDialog({
  diagnostics,
  getPluginOptionValue,
  configScope,
  installedAt,
  latestVersion,
  onOpenChange,
  onRequestUninstall,
  onRequestUpdate,
  onSavePluginOptions,
  open,
  activeOperations,
  plugin,
  renderPluginSource,
  setPluginOptionDraft,
  uninstallable,
  updateStatus,
}: {
  /** List/overview diagnostics aggregated by the plugin-management store; passed to the panel to show warnings for the current plugin. */
  diagnostics?: ZCodePluginDiagnostic[];
  getPluginOptionValue: PluginOptionValueGetter;
  configScope: ZCodePluginScope;
  installedAt?: string;
  latestVersion?: string;
  onOpenChange: (open: boolean) => void;
  onRequestUninstall?: (pluginId: string) => void;
  onRequestUpdate?: (pluginId: string) => void;
  onSavePluginOptions: (plugin: ZCodePluginInfo) => void;
  open: boolean;
  activeOperations: ReadonlyArray<{ id: string }>;
  plugin: ZCodePluginInfo | null;
  renderPluginSource: (plugin: ZCodePluginInfo) => string;
  setPluginOptionDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  uninstallable?: boolean;
  updateStatus?: "none" | "update-available" | "version-changed";
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-3rem)] w-[min(600px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0"
        data-testid="plugin-settings-detail-dialog"
        data-plugin-id={plugin?.id}
      >
        <DialogTitle className="sr-only">{plugin?.name ?? ""}</DialogTitle>
        <InstalledPluginDetailPanel
          diagnostics={diagnostics}
          getPluginOptionValue={getPluginOptionValue}
          configScope={configScope}
          installedAt={installedAt}
          latestVersion={latestVersion}
          activeOperations={activeOperations}
          plugin={plugin}
          renderPluginSource={renderPluginSource}
          setPluginOptionDraft={setPluginOptionDraft}
          uninstallable={uninstallable}
          updateStatus={updateStatus}
          onRequestUninstall={onRequestUninstall}
          onRequestUpdate={onRequestUpdate}
          onSavePluginOptions={onSavePluginOptions}
        />
      </DialogContent>
    </Dialog>
  );
}

export function InstalledPluginDetailPanel({
  diagnostics = [],
  getPluginOptionValue,
  configScope,
  installedAt,
  latestVersion,
  onRequestUninstall,
  onRequestUpdate,
  onSavePluginOptions,
  activeOperations,
  plugin,
  renderPluginSource,
  setPluginOptionDraft,
  uninstallable,
  updateStatus,
}: {
  /** List/overview diagnostics aggregated by the plugin-management store; the panel shows warnings for the current plugin only. */
  diagnostics?: ZCodePluginDiagnostic[];
  getPluginOptionValue: PluginOptionValueGetter;
  configScope: ZCodePluginScope;
  installedAt?: string;
  latestVersion?: string;
  onRequestUninstall?: (pluginId: string) => void;
  onRequestUpdate?: (pluginId: string) => void;
  onSavePluginOptions: (plugin: ZCodePluginInfo) => void;
  activeOperations: ReadonlyArray<{ id: string }>;
  plugin: ZCodePluginInfo | null;
  renderPluginSource: (plugin: ZCodePluginInfo) => string;
  setPluginOptionDraft: (pluginId: string, key: string, value: string | number | boolean) => void;
  uninstallable?: boolean;
  updateStatus?: "none" | "update-available" | "version-changed";
}) {
  const { intl } = useZCodeIntl();
  if (!plugin) {
    return (
      <div className="px-5 py-4 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.detail.empty" })}
      </div>
    );
  }

  const componentGroups = buildInstalledPluginDisplayGroups(plugin);
  const hookDetails = plugin.hookDetails ?? [];
  // Bugfix (silent failure): plugin warnings (such as an empty scan of declared skill paths) had
  // no UI location. Users saw “Installed successfully, enabled, 0 skills” with no way to diagnose
  // it. List the plugin's own warnings directly in its details panel; display the CLI message as-is, including paths.
  const pluginWarnings = diagnostics.filter(
    (diagnostic) => diagnostic.pluginId === plugin.id && diagnostic.severity === "warning",
  );
  const hasAdvanced = hookDetails.length > 0 || Object.keys(plugin.userConfig ?? {}).length > 0;
  const sourceLabel = renderPluginSource(plugin);

  return (
    <div className="max-h-[calc(100vh-3rem)] overflow-y-auto text-ui-base text-foreground">
      <div className="border-b border-border px-5 pb-4 pt-5 pr-12">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
            aria-hidden="true"
          >
            <Cable className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 flex-wrap items-baseline gap-2 text-ui-base font-semibold text-foreground">
              <span className="min-w-0 truncate">{plugin.name}</span>
              {plugin.version ? (
                <span className="text-ui-xs font-normal text-foreground-subtle">
                  v{plugin.version}
                </span>
              ) : null}
            </h2>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant={plugin.enabled ? "secondary" : "outline"} className="rounded-md">
                {plugin.enabled
                  ? intl.formatMessage({
                      id: "settings.plugins.detail.enabled",
                    })
                  : intl.formatMessage({
                      id: "settings.plugins.detail.disabled",
                    })}
              </Badge>
              <Badge variant="outline" className="min-w-0 rounded-md">
                <span className="truncate">{sourceLabel}</span>
              </Badge>
            </div>
          </div>
        </div>
        {plugin.description ? (
          <p className="mt-3 leading-relaxed text-foreground-subtle">{plugin.description}</p>
        ) : null}
      </div>

      <div className="space-y-5 px-5 py-4">
        <DetailSection title={intl.formatMessage({ id: "settings.plugins.detail.details" })}>
          {componentGroups.length > 0 ? (
            <PluginComponentGroups groups={componentGroups} />
          ) : (
            // components are authoritatively enumerated by the CLI from the plugin root, independent
            // of enabled state, so disabled plugins can still show their actual components. Reaching
            // this branch means the plugin declares no components; show an accurate empty state.
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.plugins.detail.componentsEmpty",
              })}
            </p>
          )}
        </DetailSection>

        {pluginWarnings.length > 0 ? (
          <DetailSection title={intl.formatMessage({ id: "settings.plugins.detail.warnings" })}>
            <PluginWarningList warnings={pluginWarnings} />
          </DetailSection>
        ) : null}

        {installedAt ? (
          <div className="border-t border-border pt-4">
            <div className="text-ui-xs font-medium text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.plugins.detail.installedAt",
              })}
            </div>
            <div className="mt-1 break-all text-ui-base text-foreground">{installedAt}</div>
          </div>
        ) : null}

        {hasAdvanced ? (
          <details className="group/advanced border-t border-border pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-xs font-medium text-foreground-subtle transition-colors hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-open/advanced:rotate-90" />
              {intl.formatMessage({
                id: "settings.plugins.detail.moreDetails",
              })}
            </summary>
            <div className="mt-3 space-y-3">
              <PluginDetailRow
                label={intl.formatMessage({
                  id: "settings.plugins.detail.rootPath",
                })}
                value={plugin.rootPath}
              />
              <PluginHookDetails hooks={hookDetails} />
              <PluginConfigControls
                getValue={getPluginOptionValue}
                onSave={onSavePluginOptions}
                onSetDraft={setPluginOptionDraft}
                activeOperations={activeOperations}
                plugin={plugin}
                scope={configScope}
              />
            </div>
          </details>
        ) : null}

        {isPluginUpdatePending(updateStatus) ? (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <div className="min-w-0">
              <p className="text-ui-base font-medium text-foreground">
                {updateStatus === "update-available"
                  ? intl.formatMessage(
                      { id: "settings.plugins.detail.updateAvailable" },
                      { version: latestVersion ?? "" },
                    )
                  : intl.formatMessage({
                      id: "settings.plugins.detail.versionChanged",
                    })}
              </p>
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({
                  id: "settings.plugins.detail.updateNewSessionsNote",
                })}
              </p>
            </div>
            {onRequestUpdate ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={activeOperations.some(
                  (operation) => operation.id === `plugin:update:${plugin.id}`,
                )}
                onClick={() => onRequestUpdate(plugin.id)}
              >
                {intl.formatMessage({ id: "settings.plugins.detail.update" })}
              </Button>
            ) : null}
          </div>
        ) : null}

        {uninstallable && onRequestUninstall ? (
          <div className="flex justify-end border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={activeOperations.some(
                (operation) => operation.id === `plugin:uninstall:${plugin.id}`,
              )}
              onClick={() => onRequestUninstall(plugin.id)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.detail.uninstall" })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-ui-base font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Plugin warning diagnostics list. If the CLI only writes diagnostics for issues such as an empty scan of declared skill paths,
 * the UI has nowhere to render them and users cannot investigate. The message comes from the CLI and includes the specific path
 * (the protocol wire has no path field), so render the message directly.
 */
export function PluginWarningList({ warnings }: { warnings: ZCodePluginDiagnostic[] }) {
  return (
    <ul className="space-y-2">
      {warnings.map((diagnostic, index) => (
        <li
          key={`${diagnostic.code}-${index}`}
          className="flex min-w-0 items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 break-all text-ui-sm text-foreground">{diagnostic.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function PluginHookDetails({
  hooks,
}: {
  hooks: NonNullable<ZCodePluginInfo["hookDetails"]>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div>
      <div className="mb-2 text-ui-xs font-medium text-foreground">
        {intl.formatMessage({ id: "settings.plugins.detail.hooks" })}
      </div>
      {hooks.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.detail.none" })}
        </div>
      ) : (
        <div className="space-y-2">
          {hooks.map((hook, index) => (
            <div
              key={`${hook.event}-${hook.matcher ?? "default"}-${hook.command}-${index}`}
              className="min-w-0 space-y-2 rounded-lg border border-border bg-surface px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="rounded-md font-mono">
                  {hook.event}
                </Badge>
                <Badge variant="outline" className="rounded-md">
                  {hook.matcher ??
                    intl.formatMessage({
                      id: "settings.plugins.detail.hook.defaultMatcher",
                    })}
                </Badge>
                <Badge variant={hook.runnable ? "secondary" : "outline"} className="rounded-md">
                  {hook.runnable
                    ? intl.formatMessage({
                        id: "settings.plugins.detail.hook.runnable",
                      })
                    : intl.formatMessage({
                        id: "settings.plugins.detail.hook.diagnosticOnly",
                      })}
                </Badge>
              </div>
              <PluginDetailInlineValue
                label={intl.formatMessage({
                  id: "settings.plugins.detail.hook.command",
                })}
                value={formatHookCommand(hook)}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {hook.timeoutMs !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.timeoutMs",
                    })}
                    value={`${hook.timeoutMs}ms`}
                  />
                ) : null}
                {hook.timeout !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.timeout",
                    })}
                    value={String(hook.timeout)}
                  />
                ) : null}
                {hook.async !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.async",
                    })}
                    value={String(hook.async)}
                  />
                ) : null}
                {hook.shell !== undefined ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.shell",
                    })}
                    value={hook.shell === true ? "true" : hook.shell}
                  />
                ) : null}
                {hook.statusMessage ? (
                  <PluginDetailInlineValue
                    label={intl.formatMessage({
                      id: "settings.plugins.detail.hook.statusMessage",
                    })}
                    value={hook.statusMessage}
                  />
                ) : null}
              </div>
              <PluginDetailInlineValue
                label={intl.formatMessage({
                  id: "settings.plugins.detail.hook.sourcePath",
                })}
                value={hook.sourcePath}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PluginDetailInlineValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground">{value}</div>
    </div>
  );
}

function formatHookCommand(hook: NonNullable<ZCodePluginInfo["hookDetails"]>[number]): string {
  if (!hook.args || hook.args.length === 0) return hook.command;
  return `${hook.command} ${hook.args.join(" ")}`;
}

export function PluginDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-1 break-all font-mono text-ui-xs text-foreground">{value}</div>
    </div>
  );
}
