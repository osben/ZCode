// Code intelligence (LSP) controls for Plugin Settings: the global switch on the plugin list and the
// per-server status and "Diagnostics after edits" switch on an installed plugin's detail page.
import { AlertTriangle } from "lucide-react";
import type { ZCodeLspServerStatus } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LspPendingKey } from "@/store/lspStore.js";

/**
 * Plugins whose language servers were exercised end to end in ZCode. Others work once their binary is
 * installed but are labelled "Not verified in ZCode" (spec 19-lsp.md §9).
 */
const VERIFIED_LSP_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "typescript-lsp@zcode-plugins-official",
]);

const STATE_LABEL_IDS: Record<ZCodeLspServerStatus["state"], string> = {
  stopped: "settings.plugins.lsp.state.stopped",
  starting: "settings.plugins.lsp.state.starting",
  ready: "settings.plugins.lsp.state.ready",
  crashed: "settings.plugins.lsp.state.crashed",
  unavailable: "settings.plugins.lsp.state.unavailable",
  not_installed: "settings.plugins.lsp.state.not_installed",
};

/** Crashed and unavailable servers need attention, so they use the warning colour; the label still carries the meaning. */
const NEEDS_ATTENTION_STATES: ReadonlySet<ZCodeLspServerStatus["state"]> = new Set([
  "crashed",
  "unavailable",
  "not_installed",
]);

export function isVerifiedLspPlugin(pluginId: string): boolean {
  return VERIFIED_LSP_PLUGIN_IDS.has(pluginId);
}

/** Global "Code intelligence" row on the plugin list. Disabled while the CLI applies a change. */
export function CodeIntelligenceSettingRow({
  enabled,
  pending,
  disabled,
  saveFailed,
  onChange,
}: {
  enabled: boolean;
  pending: boolean;
  disabled: boolean;
  /** Whether the last failed write was this global switch. */
  saveFailed: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="space-y-2 rounded-xl bg-surface px-4 py-3"
      data-testid="plugin-settings-lsp-setting"
    >
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.plugins.codeIntelligence.title" })}
          </h3>
          <p className="mt-0.5 text-ui-xs leading-snug text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.codeIntelligence.description" })}
          </p>
        </div>
        <Switch
          data-testid="plugin-settings-lsp-enabled-switch"
          checked={enabled}
          disabled={disabled || pending}
          aria-busy={pending}
          aria-label={intl.formatMessage({ id: "settings.plugins.codeIntelligence.toggle" })}
          onCheckedChange={onChange}
        />
      </div>
      {saveFailed ? (
        <p role="alert" className="flex items-center gap-1.5 text-ui-xs text-warning">
          <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.plugins.lsp.saveError" })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Language servers declared by one installed plugin, with live state and the per-server diagnostics
 * switch. Renders nothing when the plugin declares no server.
 */
export function PluginLanguageServerList({
  servers,
  globalEnabled,
  pendingKey,
  loadFailed,
  failedServerId,
  onSetDiagnosticsAfterEdit,
}: {
  servers: ZCodeLspServerStatus[];
  /** null while the first snapshot is pending. */
  globalEnabled: boolean | null;
  pendingKey: LspPendingKey | null;
  loadFailed: boolean;
  /** serverId whose last diagnostics write failed; only that row shows the error. */
  failedServerId: string | null;
  onSetDiagnosticsAfterEdit: (serverId: string, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  if (servers.length === 0 && !loadFailed) return null;
  return (
    <section data-testid="plugin-lsp-server-section" className="space-y-1.5">
      <h3 className="text-ui-base font-semibold text-foreground">
        {intl.formatMessage({ id: "settings.plugins.lsp.title" })}
      </h3>
      {loadFailed ? (
        <p role="alert" className="flex items-center gap-1.5 text-ui-xs text-warning">
          <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.plugins.lsp.loadError" })}
        </p>
      ) : null}
      {globalEnabled === false ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.lsp.disabledGlobally" })}
        </p>
      ) : null}
      <ul className="space-y-2">
        {servers.map((server) => {
          const verified = isVerifiedLspPlugin(server.pluginId);
          const diagnosticsPending = pendingKey === `diagnostics:${server.serverId}`;
          return (
            <li
              key={server.serverId}
              className="min-w-0 rounded-xl bg-surface px-3 py-2.5"
              data-testid="plugin-lsp-server"
              data-server-id={server.serverId}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">
                  {server.serverName}
                </span>
                <Badge
                  variant={NEEDS_ATTENTION_STATES.has(server.state) ? "destructive" : "secondary"}
                  className="rounded-md"
                  data-testid="plugin-lsp-server-state"
                >
                  {intl.formatMessage({ id: STATE_LABEL_IDS[server.state] })}
                </Badge>
                {verified ? null : (
                  <Badge variant="outline" className="rounded-md">
                    {intl.formatMessage({ id: "settings.plugins.lsp.notVerified" })}
                  </Badge>
                )}
              </div>
              <p className="mt-1 min-w-0 truncate font-mono text-ui-xs text-foreground-subtle">
                {server.command}
              </p>
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.plugins.lsp.extensions" },
                  { extensions: server.extensions.join(", ") },
                )}
              </p>
              {server.installed ? null : (
                <p className="mt-1 flex items-center gap-1.5 text-ui-xs text-warning">
                  <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                  {intl.formatMessage(
                    { id: "settings.plugins.lsp.notInstalled" },
                    { command: server.command },
                  )}
                </p>
              )}
              {server.restarts > 0 ? (
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.lsp.restarts" },
                    { count: String(server.restarts) },
                  )}
                </p>
              ) : null}
              {server.lastErrorCode ? (
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.lsp.lastError" },
                    { code: server.lastErrorCode },
                  )}
                </p>
              ) : null}
              {verified ? null : (
                <p className="mt-1 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.plugins.lsp.notVerifiedHint" })}
                </p>
              )}
              <div className="mt-2.5 flex min-w-0 items-center justify-between gap-3 border-t border-border pt-2.5">
                <div className="min-w-0">
                  <div className="text-ui-sm font-medium text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.lsp.diagnosticsAfterEdit" })}
                  </div>
                  <p className="text-ui-xs leading-snug text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.plugins.lsp.diagnosticsAfterEditHint" })}
                  </p>
                </div>
                <Switch
                  data-testid="plugin-lsp-diagnostics-switch"
                  data-server-id={server.serverId}
                  checked={server.diagnosticsAfterEdit}
                  disabled={globalEnabled !== true || pendingKey !== null}
                  aria-busy={diagnosticsPending}
                  aria-label={intl.formatMessage({
                    id: "settings.plugins.lsp.diagnosticsAfterEdit",
                  })}
                  onCheckedChange={(enabled) => onSetDiagnosticsAfterEdit(server.serverId, enabled)}
                />
              </div>
              {failedServerId === server.serverId ? (
                <p role="alert" className="mt-2 flex items-center gap-1.5 text-ui-xs text-warning">
                  <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.plugins.lsp.saveError" })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
