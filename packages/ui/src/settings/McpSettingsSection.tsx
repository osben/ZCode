/* eslint-disable max-lines -- The MCP settings page centrally maintains the list, plugin grouping, form entry, and header-row mode toggle; splitting it would add cross-state prop-passing complexity. */
/**
 * MCP Settings Section
 *
 * Manages MCP server configuration in the settings page.
 * Supports the unified ZCode Agent MCP source backed by settings directories.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_PLUGIN_MCP_SERVER_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type {
  RemoteTarget,
  WorkspaceMcpTrustDecision,
  ZCodeWorkspaceMcpTrustResult,
  ZCodeAvailablePluginSummary,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
} from "@zcode/shared";
import {
  isZCodeAgentMcpStatusModeUnsupportedError,
  type IServiceAccessor,
  type IMcpSyncService,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { logger } from "@/logger.js";
import { McpServerForm } from "@/settings/McpServerForm.js";
import { McpServerList, McpStatusDot } from "@/settings/McpServerList.js";
import {
  formToConfig,
  type FormState,
  type McpEditorMode,
  type ServerScope,
} from "@/settings/mcpSettingsShared.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  buildPluginMcpServerItems,
  filterLocalMcpServers,
  groupPluginMcpServersByPlugin,
  type PluginMcpServerItem,
} from "@/settings/pluginManagedResourceGroups.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { McpServersImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import {
  formatRemoteSyncTargetLabel,
  shouldShowRemoteSyncActions,
  useSettingsDataSyncEntry,
} from "@/data-sync/index.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfigWorkspaceServices as useWorkspaceServices } from "@/workspace-config-catalog/index.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { ExternalLink, Import, Plus, UploadCloud } from "lucide-react";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { selectPluginsForScope } from "@/settings/pluginCapabilityProjection.js";

const DEFAULT_MCP_SOURCE: ServerScope = "zcodeagentmcp";
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS = 1_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS = 5 * 60_000;
const MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS = 10;

export async function applyWorkspaceMcpTrustDecision(
  request: WorkspaceMcpTrustDecision,
  isCurrentTarget: () => boolean,
  decide: (request: WorkspaceMcpTrustDecision) => Promise<ZCodeWorkspaceMcpTrustResult>,
): Promise<boolean> {
  if (!isCurrentTarget()) return false;
  const result = await decide(request);
  if (!result.accepted) throw new Error(result.reasonCode ?? "workspace_mcp_trust_unavailable");
  return isCurrentTarget();
}

export function createMcpOAuthAuthorizationStatusRefreshDeadline(
  now: () => number = Date.now,
): number {
  return now() + MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS;
}

export function isMcpOAuthAuthorizationStatusRefreshExpired(
  deadline: number,
  now: () => number = Date.now,
): boolean {
  return now() >= deadline;
}

export type McpServerStatusListRefreshOutcome =
  | "refreshed"
  | "stale-workspace"
  | "status-mode-unsupported";

export async function refreshMcpServerStatusList({
  beginServerStatusListRefresh,
  markServerStatusListRefreshFailed,
  mergeServerStatusSnapshots,
  getCurrentWorkspaceKey,
  mode,
  mcpServers,
  requestedWorkspaceKey,
  workspaceIdentity,
  workspacePath,
  mcpSyncService,
}: {
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed?: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  getCurrentWorkspaceKey: () => string;
  mode?: ZCodeMcpListMode;
  mcpServers?: ZCodeAgentMcpServer[];
  requestedWorkspaceKey: string;
  workspaceIdentity?: string;
  workspacePath: string;
  // mcp/list converges on IMcpSyncService — the UI never touches zcodeAgentService directly.
  mcpSyncService: Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;
}): Promise<McpServerStatusListRefreshOutcome> {
  if (!requestedWorkspaceKey || getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
    return "stale-workspace";
  }
  const refreshMode = mode ?? "connect";
  const requestEpoch = beginServerStatusListRefresh(refreshMode);
  try {
    const result = await mcpSyncService.listWorkspaceMcpServerStatuses({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(mode ? { mode } : {}),
    });
    if (getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
      return "stale-workspace";
    }
    mergeServerStatusSnapshots(result.statuses, requestEpoch, refreshMode);
    return "refreshed";
  } catch (error) {
    if (getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
      return "stale-workspace";
    }
    if (refreshMode === "status" && isZCodeAgentMcpStatusModeUnsupportedError(error)) {
      return "status-mode-unsupported";
    }
    markServerStatusListRefreshFailed?.(
      error instanceof Error ? error.message : String(error),
      requestEpoch,
      refreshMode,
    );
    throw error;
  }
}

export interface McpOAuthAuthorizationPendingRefresh {
  mcpServers: ZCodeAgentMcpServer[];
  pendingKey: string;
  workspaceKey: string;
}

export function transitionMcpAutoStatusListRefreshKey(
  previousKey: string,
  nextKey: string,
): { lastRefreshKey: string; shouldRefresh: boolean } {
  if (!nextKey) {
    // A workspace switch clears servers/status first; if the empty state kept A's dedup key,
    // returning to an identically configured A would be misjudged as already refreshed, leaving the
    // list and OAuth polling stuck at unknown forever.
    return { lastRefreshKey: "", shouldRefresh: false };
  }
  return {
    lastRefreshKey: nextKey,
    shouldRefresh: previousKey !== nextKey,
  };
}

export interface McpOAuthAuthorizationFollowupRefresh {
  mcpServers: ZCodeAgentMcpServer[];
  refreshKey: string;
  workspaceKey: string;
}

export function transitionMcpOAuthAuthorizationPendingRefresh({
  activeWorkspaceKey,
  existingFollowup = null,
  mcpServers,
  now = Date.now,
  pendingKey,
  previous,
}: {
  activeWorkspaceKey: string;
  existingFollowup?: McpOAuthAuthorizationFollowupRefresh | null;
  mcpServers: ZCodeAgentMcpServer[];
  now?: () => number;
  pendingKey: string;
  previous: McpOAuthAuthorizationPendingRefresh | null;
}): {
  followup: McpOAuthAuthorizationFollowupRefresh | null;
  pending: McpOAuthAuthorizationPendingRefresh | null;
} {
  if (!activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  if (pendingKey) {
    return {
      followup: null,
      pending: {
        mcpServers: [...mcpServers],
        pendingKey,
        workspaceKey: activeWorkspaceKey,
      },
    };
  }
  if (existingFollowup?.workspaceKey === activeWorkspaceKey) {
    // The follow-up's own status merge changes servers/snapshot and reruns the transition;
    // the same-workspace bounded retry window must keep the same object and must not clean itself
    // up after the first packet.
    return { followup: existingFollowup, pending: null };
  }
  if (!previous || previous.workspaceKey !== activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  return {
    followup: {
      mcpServers: [...previous.mcpServers],
      refreshKey: `${activeWorkspaceKey}:${previous.pendingKey}:${now()}`,
      workspaceKey: activeWorkspaceKey,
    },
    pending: null,
  };
}

interface McpStatusListRefreshQueue {
  request: (runLatest: () => Promise<void>) => Promise<void>;
}

/** Refresh source: manual is the user clicking the refresh button; auto is a refresh driven by list/config changes. */
export type McpStatusListRefreshTrigger = "auto" | "manual";

export interface McpStatusListRefreshInput {
  activeWorkspaceKey: string;
  activeWorkspacePath?: string;
  configReadyWorkspaceKey: string;
  isConfigLoaded: boolean;
  serverStatusListKey: string;
  storeWorkspaceKey: string;
}

export function resolveMcpStatusListRefreshSkipReason({
  input,
  requestedWorkspaceKey,
  trigger,
}: {
  input: McpStatusListRefreshInput;
  requestedWorkspaceKey: string;
  trigger: McpStatusListRefreshTrigger;
}): string | undefined {
  if (!requestedWorkspaceKey) return "no-active-workspace";
  if (input.activeWorkspaceKey !== requestedWorkspaceKey) {
    return "workspace-changed";
  }
  if (input.storeWorkspaceKey !== requestedWorkspaceKey) {
    return "mcp-store-not-aligned";
  }
  if (input.configReadyWorkspaceKey !== requestedWorkspaceKey) {
    return "config-not-ready";
  }
  if (!input.isConfigLoaded) return "config-not-loaded";
  if (!input.activeWorkspacePath) return "no-workspace-path";
  // serverStatusListKey is empty when there are only host/plugin built-in MCPs and no user MCPs.
  // Deduping automatic refreshes on that is fine, but a manual refresh click must really send a
  // request, or the button appears completely unresponsive.
  if (!input.serverStatusListKey && trigger !== "manual") {
    return "empty-status-list-key";
  }
  return undefined;
}

export function createMcpStatusListRefreshQueue(): McpStatusListRefreshQueue {
  let inFlight: Promise<void> | null = null;
  let latestRun: (() => Promise<void>) | null = null;
  let rerunAfterCurrent = false;

  return {
    async request(runLatest) {
      latestRun = runLatest;
      if (inFlight) {
        rerunAfterCurrent = true;
        await inFlight;
        return;
      }

      inFlight = (async () => {
        try {
          do {
            rerunAfterCurrent = false;
            const run = latestRun ?? runLatest;
            latestRun = null;
            await run();
          } while (rerunAfterCurrent);
        } finally {
          inFlight = null;
        }
      })();

      await inFlight;
    },
  };
}

export function buildMcpOAuthAuthorizationStatusRefreshServers(
  servers: ZCodeMcpServer[],
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): ZCodeAgentMcpServer[] {
  const pendingSnapshotNames = new Set(
    Object.entries(statusSnapshots)
      .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
      .map(([serverName]) => serverName),
  );
  const result: ZCodeAgentMcpServer[] = [];
  const seenNames = new Set<string>();

  for (const server of servers) {
    if (server.source !== "zcodeagentmcp" || !server.enabled) {
      continue;
    }
    const hasPendingAuthorization =
      Boolean(server.authorization?.authorizationUrl) || pendingSnapshotNames.has(server.name);
    if (!hasPendingAuthorization || seenNames.has(server.name)) {
      continue;
    }
    const zcodeAgentServer = convertToZCodeAgentMcpServer(
      server.name,
      server.config,
      server.scope === "workspace" ? "workspace" : "user",
    );
    if (!zcodeAgentServer) {
      continue;
    }
    seenNames.add(server.name);
    result.push(zcodeAgentServer);
  }

  return result;
}

export function buildMcpOAuthAuthorizationStatusRefreshOptions(mcpServers: ZCodeAgentMcpServer[]): {
  mode: "status";
  mcpServers: ZCodeAgentMcpServer[];
} {
  return {
    // OAuth pending/follow-up/focus refreshes only read runtime state; the pending subset must not enter the connect replace path.
    mode: "status",
    mcpServers,
  };
}

export function buildMcpServerStatusListKey(servers: ZCodeMcpServer[]): string {
  return servers
    .filter((server) => server.source === "zcodeagentmcp")
    .map((server) => {
      const enabledKey = server.enabled ? "enabled" : "disabled";
      return `${server.id}:${enabledKey}:${JSON.stringify(server.config)}`;
    })
    .join("|");
}

export function buildPluginMcpServerStatusListKey(plugins: ZCodePluginInfo[]): string {
  return plugins
    .map((plugin) => {
      const declaredNames = plugin.declaredMcpServerNames ?? [];
      const runtimeNames = plugin.mcpServerNames;
      const hostNames = plugin.hostMcpServerNames ?? [];
      if (
        (!plugin.enabled && hostNames.length === 0) ||
        (declaredNames.length === 0 && runtimeNames.length === 0 && hostNames.length === 0)
      ) {
        return "";
      }
      const pluginKey = `${plugin.id}:${plugin.enabled ? "enabled" : "disabled"}:${[
        ...declaredNames,
      ]
        .sort()
        .join(",")}:${[...runtimeNames].sort().join(",")}`;
      return hostNames.length > 0
        ? `${pluginKey}:host=${[...hostNames].sort().join(",")}`
        : pluginKey;
    })
    .filter(Boolean)
    .join("|");
}

export function shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext: boolean): boolean {
  return !isRemoteSyncContext;
}

export function buildPendingMcpOAuthAuthorizationRefreshKey(
  servers: ZCodeMcpServer[],
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): string {
  const localPendingKeys = servers
    .filter(
      (server) =>
        server.source === "zcodeagentmcp" &&
        server.enabled &&
        Boolean(server.authorization?.authorizationUrl),
    )
    .map((server) => `${server.id}:${server.authorization?.startedAt ?? ""}`);
  const runtimePendingKeys = Object.entries(statusSnapshots)
    .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
    .map(([serverName, snapshot]) => `${serverName}:${snapshot.authorization?.startedAt ?? ""}`);
  return Array.from(new Set([...localPendingKeys, ...runtimePendingKeys])).join("|");
}

function PluginMcpServerList({
  items,
  pluginListingById,
  onOpenAuthorization,
}: {
  items: PluginMcpServerItem[];
  pluginListingById: ReadonlyMap<string, ZCodeAvailablePluginSummary["listing"]>;
  onOpenAuthorization?: (item: PluginMcpServerItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });

  function resolveStatusDescription(item: PluginMcpServerItem): string {
    if (item.authorization?.authorizationUrl) {
      return intl.formatMessage({
        id: "settings.mcp.plugin.authorizationRequiredDescription",
      });
    }
    if (item.status === "error") {
      return intl.formatMessage({
        id: resolveMcpFailureMessageId(item.failureKind),
      });
    }
    if (item.active) {
      if (item.status === "connecting") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectingDescription",
        });
      }
      if (item.status === "connected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectedDescription",
        });
      }
      if (item.status === "disconnected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.disconnectedDescription",
        });
      }
      return item.hostProvided
        ? intl.formatMessage(
            { id: "settings.mcp.host.activeDescription" },
            { pluginName: item.pluginName },
          )
        : intl.formatMessage({ id: "settings.mcp.plugin.activeDescription" });
    }
    if (!item.pluginEnabled) {
      return intl.formatMessage({
        id: "settings.mcp.plugin.disabledDescription",
      });
    }
    return intl.formatMessage({
      id: "settings.mcp.plugin.unavailableDescription",
    });
  }

  return (
    <SettingsResourceList
      items={items}
      getKey={(item) => item.id}
      renderItem={(item) => {
        const statusDescription = resolveStatusDescription(item);
        return (
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-mcp-status={item.status ?? ""}
            data-mcp-tool-count={item.toolCount}
            data-testid={testId(TID_PLUGIN_MCP_SERVER_ROW, item.runtimeServerName)}
          >
            <div className="relative size-9 shrink-0" data-mcp-status-dot-placement="icon-corner">
              <PluginStoreAvatar
                item={{
                  name: item.pluginName,
                  listing: pluginListingById.get(item.pluginId),
                }}
                className="size-9 bg-background"
              />
              <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
                <McpStatusDot
                  status={item.status}
                  attention={Boolean(item.authorization?.authorizationUrl)}
                  disabled={!item.pluginEnabled}
                  reason={statusDescription}
                />
              </span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.status === "error" ? (
                <McpFailurePresentation error={item.error} failureKind={item.failureKind} />
              ) : (
                <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
                  {statusDescription}
                </div>
              )}
            </div>
            {item.authorization?.authorizationUrl ? (
              <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">
                <Button
                  variant="link"
                  size="sm"
                  className="text-icon-blue hover:text-icon-blue/80"
                  aria-label={openAuthorizationLabel}
                  data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, item.runtimeServerName)}
                  title={openAuthorizationLabel}
                  onClick={() => onOpenAuthorization?.(item)}
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{openAuthorizationLabel}</span>
                </Button>
              </div>
            ) : null}
          </div>
        );
      }}
    />
  );
}

interface McpSettingsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  /** The online remote device when Scope selects its "user" level; the sync button shows only then. */
  dataSyncSourceServerId?: string | null;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

export function McpSettingsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  isWebRemoteControl = false,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  dataSyncSourceServerId,
  unscopedServices,
  cacheAuthorityKey,
}: McpSettingsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey || unscopedServices) },
  );
  const platform = usePlatform();

  const storedServers = useMcpStore((s) => s.servers);
  const storedStatusSnapshots = useMcpStore((s) => s.statusSnapshots);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginStoreAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const currentProjectPath = useMcpStore((s) => s.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((s) => s.currentWorkspaceIdentity);
  const currentAuthorityKey = useMcpStore((s) => s.currentAuthorityKey);
  // Bug cause: with props missing, this used to fall back to the current tab's path and identity.
  // A remote "user" level has no identity to begin with; the fallback mixed in the current tab's
  // identity, so reads/writes landed on the current tab's device.
  // Fix: bind only to the Scope target (props); the sole caller, PluginsSection, always passes the
  // target path.
  const activeWorkspacePath = workspacePath ?? undefined;
  const activeWorkspaceIdentity = workspaceIdentity;
  const activeWorkspaceKey = `${cacheAuthorityKey?.trim() || "workspace"}\0${activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""}`;
  const currentMcpStoreWorkspaceKey = `${currentAuthorityKey?.trim() || "workspace"}\0${currentWorkspaceIdentity?.trim() || currentProjectPath}`;
  // Fix reason: the active tab can switch before the async MCP catalog loads; a transition frame
  // must not project A's config and snapshot onto B, let alone let a later effect send those
  // sensitive configs to B's Agent.
  const mcpStoreMatchesActiveWorkspace =
    Boolean(activeWorkspaceKey) && currentMcpStoreWorkspaceKey === activeWorkspaceKey;
  const servers = mcpStoreMatchesActiveWorkspace ? storedServers : [];
  const statusSnapshots = mcpStoreMatchesActiveWorkspace ? storedStatusSnapshots : {};
  const isConfigLoaded = useMcpStore((s) => s.isConfigLoaded);
  const ensureLoadedForWorkspace = useMcpStore((s) => s.ensureLoadedForWorkspace);
  const loadMcpFromUserDirectory = useMcpStore((s) => s.loadMcpFromUserDirectory);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const addScopedMcpServer = useMcpStore((s) => s.addScopedMcpServer);
  const updateScopedMcpServer = useMcpStore((s) => s.updateScopedMcpServer);
  const deleteScopedMcpServer = useMcpStore((s) => s.deleteScopedMcpServer);
  const updateServerStatus = useMcpStore((s) => s.updateServerStatus);
  const beginServerStatusListRefresh = useMcpStore((s) => s.beginServerStatusListRefresh);
  const markServerStatusListRefreshFailed = useMcpStore((s) => s.markServerStatusListRefreshFailed);
  const mergeServerStatusSnapshots = useMcpStore((s) => s.mergeServerStatusSnapshots);

  const [showForm, setShowForm] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const [editingServer, setEditingServer] = useState<ZCodeMcpServer | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const query = searchQuery;
  const [editorMode, setEditorMode] = useState<McpEditorMode>("form");
  const [mcpConfigReadyWorkspaceKey, setMcpConfigReadyWorkspaceKey] = useState("");
  const [mcpOAuthAuthorizationFollowupRefresh, setMcpOAuthAuthorizationFollowupRefresh] =
    useState<McpOAuthAuthorizationFollowupRefresh | null>(null);
  const [mcpStatusOnlyUnsupported, setMcpStatusOnlyUnsupported] = useState(false);
  const mcpStatusOnlyUnsupportedRef = useRef(false);
  const isFormView = showForm || editingServer !== null;
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
  }, [isFormView, onEditorOpenChange]);
  useEffect(
    () => () => {
      onEditorOpenChange?.(false);
    },
    [onEditorOpenChange],
  );
  const serverStatusListKey = useMemo(
    () =>
      [buildMcpServerStatusListKey(servers), buildPluginMcpServerStatusListKey(plugins)]
        .filter(Boolean)
        .join("|"),
    [plugins, servers],
  );
  const statusListRefreshQueueRef = useRef<McpStatusListRefreshQueue | null>(null);
  if (!statusListRefreshQueueRef.current) {
    statusListRefreshQueueRef.current = createMcpStatusListRefreshQueue();
  }
  const latestStatusListRefreshInputRef = useRef<{
    activeWorkspaceIdentity?: string;
    activeWorkspaceKey: string;
    activeWorkspacePath?: string;
    configReadyWorkspaceKey: string;
    storeWorkspaceKey: string;
    isConfigLoaded: boolean;
    serverStatusListKey: string;
  }>({
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  });
  latestStatusListRefreshInputRef.current = {
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  };
  const autoStatusListRefreshKey = useMemo(() => {
    if (
      !isConfigLoaded ||
      !activeWorkspacePath ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      !serverStatusListKey
    ) {
      return "";
    }
    return [activeWorkspaceIdentity ?? "", activeWorkspacePath, serverStatusListKey].join("\n");
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    isConfigLoaded,
    mcpConfigReadyWorkspaceKey,
    serverStatusListKey,
  ]);
  const pendingMcpOAuthAuthorizationRefreshKey = useMemo(
    () => buildPendingMcpOAuthAuthorizationRefreshKey(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshServers = useMemo(
    () => buildMcpOAuthAuthorizationStatusRefreshServers(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshDeadline = useMemo(
    () =>
      activeWorkspaceKey && pendingMcpOAuthAuthorizationRefreshKey
        ? createMcpOAuthAuthorizationStatusRefreshDeadline()
        : 0,
    // A status snapshot merge rebuilds the pending server array and restarts the polling effect;
    // the deadline may change only with the workspace/pending authorization window, or slow
    // requests would keep extending the 5-minute window.
    [activeWorkspaceKey, pendingMcpOAuthAuthorizationRefreshKey],
  );
  const lastPendingMcpOAuthAuthorizationRefreshRef =
    useRef<McpOAuthAuthorizationPendingRefresh | null>(null);
  const lastAutoStatusListRefreshKeyRef = useRef("");
  const requestMcpServerStatusList = useCallback(
    async (options?: {
      mcpServers?: ZCodeAgentMcpServer[];
      mode?: ZCodeMcpListMode;
      trigger?: McpStatusListRefreshTrigger;
    }) => {
      const trigger = options?.trigger ?? "auto";
      const requestedWorkspaceKey = activeWorkspaceKey;
      const requestedInput = latestStatusListRefreshInputRef.current;
      // Both the queue runner and in-flight responses can cross workspace lifetimes;
      // the active/store/readiness keys must still agree before sending or merging a result.
      const getCurrentRefreshWorkspaceKey = () => {
        const latest = latestStatusListRefreshInputRef.current;
        return latest.activeWorkspaceKey === latest.storeWorkspaceKey &&
          latest.configReadyWorkspaceKey === latest.activeWorkspaceKey
          ? latest.activeWorkspaceKey
          : "";
      };
      const isRequestCurrent = () => getCurrentRefreshWorkspaceKey() === requestedWorkspaceKey;
      const skipReason = resolveMcpStatusListRefreshSkipReason({
        input: requestedInput,
        requestedWorkspaceKey,
        trigger,
      });
      if (skipReason) {
        // These guards used to be silent returns: after a refresh click there was neither a request
        // nor any trace, and a repro could not tell "no request sent" from "sent but read stale
        // state" in the logs.
        if (trigger === "manual") {
          logger.warn("[mcp] manual status refresh skipped", {
            reason: skipReason,
            workspacePath: requestedInput.activeWorkspacePath,
          });
        }
        return;
      }
      if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
        return;
      }
      const requestedWorkspacePath = requestedInput.activeWorkspacePath;
      // skipReason already covers this branch; this is only for type narrowing.
      if (!requestedWorkspacePath) return;
      const requestedMcpServers =
        options?.mcpServers ?? useMcpStore.getState().getEnabledMcpServersForZCode("zcode");
      await statusListRefreshQueueRef.current?.request(async () => {
        if (!isRequestCurrent()) {
          return;
        }
        if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
          return;
        }

        const outcome = await refreshMcpServerStatusList({
          beginServerStatusListRefresh,
          getCurrentWorkspaceKey: getCurrentRefreshWorkspaceKey,
          markServerStatusListRefreshFailed,
          mergeServerStatusSnapshots,
          // The settings list may come from the `.agents/mcp.json` fallback; the agent-side
          // mcp/list's own createConfig cannot see these UI-resolved MCPs, so they must be sent
          // explicitly, same as a real session.
          mcpServers: requestedMcpServers,
          mode: options?.mode,
          requestedWorkspaceKey,
          workspaceIdentity: requestedInput.activeWorkspaceIdentity,
          workspacePath: requestedWorkspacePath,
          mcpSyncService: services.mcpSyncService,
        }).catch((error) => {
          logger.warn("[mcp] list server statuses failed", {
            error: error instanceof Error ? error.message : String(error),
            workspacePath: requestedWorkspacePath,
          });
          if (trigger === "manual") {
            // Bugfix: a manual refresh failure used to go only to the log, leaving the user on stale state with no hint.
            const message = error instanceof Error ? error.message : String(error);
            toast(intl.formatMessage({ id: "settings.mcp.refreshFailed" }, { error: message }), {
              durationMs: 8_000,
            });
          }
          return "failed" as const;
        });
        if (outcome === "stale-workspace" || !isRequestCurrent()) {
          return;
        }
        if (outcome === "status-mode-unsupported") {
          // Old agents reliably reject mode=status; keeping the pending timer and focus listener
          // running would produce the same protocol error every second and could never advance the
          // OAuth state.
          mcpStatusOnlyUnsupportedRef.current = true;
          lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
          setMcpOAuthAuthorizationFollowupRefresh(null);
          setMcpStatusOnlyUnsupported(true);
          logger.warn("[mcp] status-only refresh unsupported; stop OAuth status polling", {
            workspacePath: requestedWorkspacePath,
          });
          toast(intl.formatMessage({ id: "settings.mcp.statusOnlyUnsupported" }), {
            durationMs: 8_000,
          });
        } else if (outcome === "refreshed" && options?.mode !== "status") {
          mcpStatusOnlyUnsupportedRef.current = false;
          setMcpStatusOnlyUnsupported(false);
        }
      });
    },
    [
      activeWorkspaceKey,
      beginServerStatusListRefresh,
      intl,
      markServerStatusListRefreshFailed,
      mergeServerStatusSnapshots,
      services.mcpSyncService,
    ],
  );

  const [refreshingStatusList, setRefreshingStatusList] = useState(false);
  // The refresh button used to give no visible feedback — the request could be silently dropped
  // by a guard or still be in flight. Unified here: ensure config is loaded first, then send one
  // request with the manual trigger while the button shows loading.
  const handleManualRefresh = useCallback(async () => {
    if (refreshingStatusList) return;
    setRefreshingStatusList(true);
    try {
      await loadMcpFromUserDirectory();
      if (activeWorkspacePath && !mcpConfigReadyWorkspaceKey) {
        const loaded = await ensureLoadedForWorkspace(
          activeWorkspacePath,
          services.mcpSyncService,
          activeWorkspaceIdentity,
          cacheAuthorityKey,
        );
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loaded && loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
          // The ref syncs only at render; write it again here, or the request firing later in the
          // same tick is still skipped as config-not-ready and the user must click refresh again.
          latestStatusListRefreshInputRef.current = {
            ...latestStatusListRefreshInputRef.current,
            configReadyWorkspaceKey: activeWorkspaceKey,
          };
        }
      }
      await requestMcpServerStatusList({ trigger: "manual" });
    } finally {
      setRefreshingStatusList(false);
    }
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    loadMcpFromUserDirectory,
    mcpConfigReadyWorkspaceKey,
    refreshingStatusList,
    requestMcpServerStatusList,
    services.mcpSyncService,
  ]);

  useEffect(() => {
    lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
    setMcpOAuthAuthorizationFollowupRefresh(null);
    mcpStatusOnlyUnsupportedRef.current = false;
    setMcpStatusOnlyUnsupported(false);
  }, [activeWorkspaceKey, services.mcpSyncService]);

  useEffect(() => {
    let cancelled = false;
    setMcpConfigReadyWorkspaceKey("");
    if (!activeWorkspacePath || !activeWorkspaceKey) {
      return;
    }

    void ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    )
      .then((loaded) => {
        if (cancelled || !loaded) {
          return;
        }
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
        }
      })
      .catch((error) => {
        logger.warn("[mcp] load workspace config before status refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          workspacePath: activeWorkspacePath,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    services.mcpSyncService,
  ]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }
    void initializePlugins({
      pluginService: services.pluginManagementService,
      workspaceIdentity: activeWorkspaceIdentity,
      workspacePath: activeWorkspacePath,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    scopeFilter,
    services.pluginManagementService,
  ]);

  useEffect(() => {
    const transition = transitionMcpAutoStatusListRefreshKey(
      lastAutoStatusListRefreshKeyRef.current,
      autoStatusListRefreshKey,
    );
    lastAutoStatusListRefreshKeyRef.current = transition.lastRefreshKey;
    if (!transition.shouldRefresh) {
      return;
    }
    void requestMcpServerStatusList();
  }, [autoStatusListRefreshKey, requestMcpServerStatusList]);

  useEffect(() => {
    if (!activeWorkspaceKey || mcpConfigReadyWorkspaceKey !== activeWorkspaceKey) {
      lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
      setMcpOAuthAuthorizationFollowupRefresh(null);
      return;
    }
    const transition = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey,
      existingFollowup: mcpOAuthAuthorizationFollowupRefresh,
      mcpServers: pendingMcpOAuthAuthorizationRefreshServers,
      pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
      previous: lastPendingMcpOAuthAuthorizationRefreshRef.current,
    });
    lastPendingMcpOAuthAuthorizationRefreshRef.current = transition.pending;
    // Between OAuth callback completion and MCP reconnection, authorizationUrl is briefly cleared;
    // the follow-up must carry the original workspaceKey and must not reuse old config across a
    // workspace switch.
    setMcpOAuthAuthorizationFollowupRefresh(transition.followup);
  }, [
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;
    const deadline = pendingMcpOAuthAuthorizationRefreshDeadline;

    const scheduleNextRefresh = () => {
      if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
          return;
        }
        attempts += 1;
        logger.debug("[mcp] refresh status while OAuth authorization is pending", {
          attempt: attempts,
          deadline,
          pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
          workspacePath: activeWorkspacePath,
        });
        // Fix reason: to return authorizationUrl quickly, mcp/list has the agent wait for the OAuth
        // callback and reconnect in the background; if this settings page stops pulling snapshots,
        // the UI stays at connecting until a tab switch remounts. OAuth polling is high-frequency
        // and must go status-only, so the pending subset cannot trigger replace semantics and
        // disconnect unrelated MCPs.
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            pendingMcpOAuthAuthorizationRefreshServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    scheduleNextRefresh();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshDeadline,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !mcpOAuthAuthorizationFollowupRefresh ||
      mcpOAuthAuthorizationFollowupRefresh.workspaceKey !== activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;

    const scheduleNextRefresh = () => {
      if (cancelled) {
        return;
      }
      if (attempts >= MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS) {
        setMcpOAuthAuthorizationFollowupRefresh((current) =>
          current?.refreshKey === mcpOAuthAuthorizationFollowupRefresh.refreshKey ? null : current,
        );
        return;
      }
      timeoutId = window.setTimeout(() => {
        attempts += 1;
        logger.debug("[mcp] refresh status after OAuth authorization state changed", {
          attempt: attempts,
          followupKey: mcpOAuthAuthorizationFollowupRefresh.refreshKey,
          workspacePath: activeWorkspacePath,
        });
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            mcpOAuthAuthorizationFollowupRefresh.mcpServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    void requestMcpServerStatusList(
      buildMcpOAuthAuthorizationStatusRefreshOptions(
        mcpOAuthAuthorizationFollowupRefresh.mcpServers,
      ),
    ).finally(scheduleNextRefresh);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    mcpStatusOnlyUnsupported,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    const refreshAfterReturnFromBrowser = () => {
      logger.debug("[mcp] refresh status after returning from OAuth browser", {
        pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
        workspacePath: activeWorkspacePath,
      });
      void requestMcpServerStatusList(
        buildMcpOAuthAuthorizationStatusRefreshOptions(pendingMcpOAuthAuthorizationRefreshServers),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshAfterReturnFromBrowser();
      }
    };

    window.addEventListener("focus", refreshAfterReturnFromBrowser);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshAfterReturnFromBrowser);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  const scopedServers = useMemo(
    () =>
      servers.filter(
        (server) =>
          server.scope === scopeFilter || (scopeFilter === "user" && server.scope === "common"),
      ),
    [scopeFilter, servers],
  );
  const filteredServers = useMemo(
    () => filterLocalMcpServers(scopedServers, query),
    [query, scopedServers],
  );
  const connectedRemoteSyncTarget =
    shouldShowRemoteSyncActions({ remoteSessionId, remoteTarget, isWebRemoteControl }) &&
    activeWorkspacePath
      ? remoteTarget
      : null;
  const isRemoteSyncContext = Boolean(connectedRemoteSyncTarget);
  const pluginMcpServers = useMemo(() => {
    if (!shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext)) {
      // The plugin MCP list comes from the local plugin-management store, not the current remote
      // target. A remote MCP settings page must, like Skills, show only resources the remote
      // workspace can read and write.
      return [];
    }
    // The plugin store key must match pluginManagementStoreLoading.buildWorkspaceKey's format
    // (authority\0identity|path), or an activeWorkspaceKey carrying a Source authority never matches.
    const pluginStoreWorkspaceKey = `${pluginStoreAuthorityKey?.trim() || "workspace"}\0${
      pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || ""
    }`;
    const pluginStoreMatchesTarget =
      pluginStoreWorkspaceKey === activeWorkspaceKey && pluginConfigScope === scopeFilter;
    if (!pluginStoreMatchesTarget) {
      return [];
    }
    const scopedPlugins = selectPluginsForScope(plugins, installedPlugins, scopeFilter).filter(
      (plugin) => plugin.enabled,
    );
    return buildPluginMcpServerItems(scopedPlugins, query, statusSnapshots);
  }, [
    installedPlugins,
    activeWorkspaceKey,
    isRemoteSyncContext,
    pluginConfigScope,
    pluginStoreAuthorityKey,
    pluginStoreWorkspaceIdentity,
    pluginStoreWorkspacePath,
    plugins,
    query,
    scopeFilter,
    statusSnapshots,
  ]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const filteredMcpCount = filteredServers.length + pluginMcpServers.length;
  const pluginMcpGroups = useMemo(
    () => groupPluginMcpServersByPlugin(pluginMcpServers),
    [pluginMcpServers],
  );
  const mcpProjectionReady =
    !activeWorkspacePath ||
    (mcpStoreMatchesActiveWorkspace && mcpConfigReadyWorkspaceKey === activeWorkspaceKey);
  const hasEmptySearchResult = Boolean(query.trim()) && filteredMcpCount === 0;
  const installedServers = useMemo(
    () =>
      filteredServers
        .map((server, index) => ({ index, server }))
        .toSorted((left, right) => {
          // Bug cause: a Source authority commit replayed from an old baseline restored the retired
          // "needs attention" group, splitting the diagnostic regrouping back into two lists.
          // Attention items only pin to the top inside Installed, avoiding duplicate grouping.
          const leftAttention = Boolean(
            left.server.authorization?.authorizationUrl || left.server.status === "error",
          );
          const rightAttention = Boolean(
            right.server.authorization?.authorizationUrl || right.server.status === "error",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ server }) => server),
    [filteredServers],
  );
  const hideInstalledGroup = Boolean(query.trim()) && installedServers.length === 0;
  useEffect(() => {
    onVisibleCountChange?.(filteredMcpCount);
  }, [filteredMcpCount, onVisibleCountChange]);
  const remoteMcpSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSyncTargetLabel(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";
  // The sync button opens the data-sync dialog's MCP category. The settings entry passes no workspace mapping: MCP only rewrites home.
  const dataSync = useSettingsDataSyncEntry({
    category: "mcp",
    sourceServerId: dataSyncSourceServerId,
    onPushFinished: async () => {
      const loaded = await loadMcpFromUserDirectory();
      if (loaded) {
        await requestMcpServerStatusList();
      }
    },
  });

  async function handleToggle(id: string, enabled: boolean) {
    await toggleServer(id, enabled);

    if (!enabled) {
      // The post-disable unknown is a local display state only; toggleServer already invalidated
      // old requests. Do not advance the epoch again, or the just-returned mcp/list gets dropped
      // and the spinner loops.
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }

    // A renderer-side shallow check cannot really start a stdio MCP and once misjudged a
    // nonexistent command as connected. On enable, show connecting only; the final green/red
    // state waits for the agent-side mcp/list's real connect/listTools write-back.
    if (!activeWorkspacePath) {
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }
    // connecting is a temporary display state while awaiting the real mcp/list; it must not invalidate the batch request issued right after.
    updateServerStatus(id, "connecting", undefined, {
      invalidateStatusListRequests: false,
    });
    void requestMcpServerStatusList();
  }

  const trustTargetRef = useRef({
    workspaceKey: activeWorkspaceKey,
    service: services.mcpSyncService,
  });
  trustTargetRef.current = { workspaceKey: activeWorkspaceKey, service: services.mcpSyncService };

  const trustAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      trustAbortRef.current?.abort();
      trustAbortRef.current = null;
    },
    [activeWorkspaceKey, services.mcpSyncService],
  );

  async function handleWorkspaceMcpTrust(server: ZCodeMcpServer) {
    const review = server.workspaceTrust;
    if (trustAbortRef.current) return;
    const controller = new AbortController();
    const target = trustTargetRef.current;
    const isCurrentTarget = () =>
      !controller.signal.aborted &&
      target.workspaceKey === trustTargetRef.current.workspaceKey &&
      target.service === trustTargetRef.current.service;
    const workspacePath = activeWorkspacePath;
    const decide = services.mcpSyncService.setWorkspaceMcpTrust;
    if (!review || !workspacePath || !decide || server.scope !== "workspace") return;
    trustAbortRef.current = controller;
    const trusted = !review.trusted;
    const confirmed = await confirmDialog(
      {
        title: intl.formatMessage(
          { id: trusted ? "settings.mcp.trust.title" : "settings.mcp.trust.revokeTitle" },
          { name: server.name },
        ),
        description: [
          intl.formatMessage({ id: "settings.mcp.trust.description" }),
          ...review.sourcePaths,
        ].join("\n\n"),
        // The Host already redacts and formats the declaration; the code component keeps indentation without re-reading raw config.
        codeBlock: { code: review.display, language: "json" },
        scrollableDescription: true,
        intent: "workspace-mcp-trust",
        confirmLabel: intl.formatMessage({
          id: trusted ? "settings.mcp.trust.action" : "settings.mcp.trust.revoke",
        }),
      },
      controller.signal,
    );
    if (!confirmed) {
      if (trustAbortRef.current === controller) trustAbortRef.current = null;
      return;
    }
    try {
      const current = await applyWorkspaceMcpTrustDecision(
        {
          workspacePath,
          ...(activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : {}),
          serverName: server.name,
          declarationDigest: review.declarationDigest,
          trusted,
        },
        isCurrentTarget,
        (request) => decide.call(services.mcpSyncService, request),
      );
      if (current) await requestMcpServerStatusList({ mode: "status" });
    } catch {
      if (isCurrentTarget()) toast(intl.formatMessage({ id: "settings.mcp.trust.failed" }));
    } finally {
      if (trustAbortRef.current === controller) trustAbortRef.current = null;
    }
  }

  async function handleSave(form: FormState, prev?: ZCodeMcpServer) {
    if (!activeWorkspacePath) {
      return;
    }
    const loaded = await ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    );
    if (!loaded) {
      return;
    }
    const config = {
      ...formToConfig(form),
      ...(prev?.enabled === false ? { enable: false } : {}),
    };
    // The form's Scope can switch independently of the parent page; it must not keep reading a
    // currentProjectPath that may still belong to the old target. The save target must use the
    // workspace props the form has resolved and finished loading.
    const projectPath = formScopeKey === "user" ? undefined : activeWorkspacePath;

    if (prev) {
      await updateScopedMcpServer(DEFAULT_MCP_SOURCE, prev.name, config, projectPath);
    } else {
      await addScopedMcpServer(DEFAULT_MCP_SOURCE, form.name, config, projectPath);
    }

    setShowForm(false);
    setEditingServer(null);
    onFormScopeKeyChange?.(null);
  }

  async function handleDelete(server: ZCodeMcpServer) {
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage({ id: "settings.mcp.deleteConfirmTitle" }, { name: server.name }),
      description: intl.formatMessage({
        id: "settings.mcp.deleteConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({
        id: "settings.mcp.deleteConfirmAction",
      }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });

    if (!confirmed) {
      return;
    }

    await deleteScopedMcpServer(server.source, server.name, server.projectPath);
    setEditingServer(null);
    setShowForm(false);
    setEditorMode("form");
    onFormScopeKeyChange?.(null);
  }

  function handleEdit(server: ZCodeMcpServer) {
    const ownerWorkspace = workspaceTabs.find((tab) => tab.workspacePath === server.projectPath);
    const ownedScopeKey =
      server.scope === "workspace"
        ? ownerWorkspace
          ? getPluginWorkspaceKey(ownerWorkspace)
          : parentScopeKey
        : "user";
    setFormScopeKey(ownedScopeKey);
    onFormScopeKeyChange?.(ownedScopeKey);
    setEditingServer(server);
    setShowForm(false);
    setEditorMode("form");
  }

  function handleCreate() {
    setFormScopeKey(parentScopeKey);
    onFormScopeKeyChange?.(parentScopeKey);
    setEditingServer(null);
    setEditorMode("form");
    setShowForm(true);
  }

  function handleOpenAuthorization(server: ZCodeMcpServer) {
    const authorizationUrl = server.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  function handleOpenPluginAuthorization(item: PluginMcpServerItem) {
    const authorizationUrl = item.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  if (isFormView) {
    const closeFormView = () => {
      setShowForm(false);
      setEditingServer(null);
      setEditorMode("form");
      onFormScopeKeyChange?.(null);
    };
    const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
    const formBreadcrumbLabel =
      editingServer?.name ?? intl.formatMessage({ id: "settings.mcp.form.createTitle" });
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  { label: pluginsBreadcrumbLabel, onSelect: closeFormView },
                  { label: formBreadcrumbLabel },
                ]
              : [{ label: formBreadcrumbLabel }]
          }
          onSectionSelect={
            showMarketplaceBreadcrumb && onOpenPluginStore ? onOpenPluginStore : closeFormView
          }
        />
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="text-ui-xl font-semibold text-foreground">
                {editingServer
                  ? intl.formatMessage({ id: "settings.mcp.form.editTitle" })
                  : intl.formatMessage({ id: "settings.mcp.form.createTitle" })}
              </h3>
              <p className="text-ui-base text-foreground-subtle">
                {editingServer
                  ? intl.formatMessage({
                      id: "settings.mcp.form.editDescription",
                    })
                  : intl.formatMessage({
                      id: "settings.mcp.form.createDescription",
                    })}
              </p>
            </div>
            <div className="shrink-0 self-end">
              <SettingsSegmentedTabs
                value={editorMode}
                items={[
                  {
                    value: "form",
                    label: intl.formatMessage({
                      id: "settings.mcp.form.mode.form",
                    }),
                  },
                  { value: "json", label: "JSON" },
                ]}
                onValueChange={setEditorMode}
              />
            </div>
          </div>

          <McpServerForm
            initial={editingServer ?? undefined}
            editingId={editingServer?.id}
            editorMode={editorMode}
            source={editingServer?.source ?? DEFAULT_MCP_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={(nextScopeKey) => {
              setFormScopeKey(nextScopeKey);
              onFormScopeKeyChange?.(nextScopeKey);
            }}
            onEditorModeChange={setEditorMode}
            onSave={handleSave}
            onDelete={editingServer ? handleDelete : undefined}
            onCancel={closeFormView}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {dataSync.visible ? (
        <div className="flex justify-end">
          <ControlHintTooltip title={intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              data-testid="data-sync-entry-mcp"
              disabled={dataSync.disabled}
              aria-label={intl.formatMessage({
                id: "settings.mcp.remoteSync.open",
              })}
              onClick={dataSync.open}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      ) : null}

      {connectedRemoteSyncTarget ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.mcp.remoteContext" },
            { target: remoteMcpSyncTargetLabel },
          )}
        </div>
      ) : null}

      {!mcpProjectionReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.mcp.searchEmpty",
          })}
        />
      ) : null}
      <div
        className={!mcpProjectionReady || hasEmptySearchResult ? "hidden" : "space-y-6"}
        data-mcp-list-layout="grouped"
      >
        <section
          className={hideInstalledGroup ? "hidden" : "space-y-4"}
          data-mcp-plugin-group="installed"
        >
          <div data-mcp-plugin-installed-actions="true">
            <SettingsResourceGroupHeader
              actions={
                <SettingsResourceHeaderActions
                  refreshTestId="mcp-settings-refresh"
                  onRefresh={() => void handleManualRefresh()}
                  refreshing={refreshingStatusList}
                  onImport={() => setImportDialogOpen(true)}
                  onNew={handleCreate}
                  importActionId="settings.mcp.import.open"
                  newActionId="settings.mcp.create.open"
                />
              }
              count={installedServers.length}
              title={intl.formatMessage({
                id: "settings.plugin.mcp.installed",
              })}
            />
          </div>
          {installedServers.length > 0 ? (
            <McpServerList
              hideMetadata
              servers={installedServers}
              onCreate={handleCreate}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onOpenAuthorization={handleOpenAuthorization}
              onTrust={handleWorkspaceMcpTrust}
              emptyTitle={intl.formatMessage({ id: "settings.mcp.emptyTitle" })}
              emptyDescription={intl.formatMessage({
                id: "settings.mcp.emptyDescription",
              })}
            />
          ) : scopedServers.length === 0 && !query.trim() ? (
            <PluginInstallEmptyState
              title={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledTitle",
              })}
              description={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledDescription",
              })}
              actions={
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    onClick={() => {
                      handleCreate();
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({
                      id: "settings.plugin.mcp.newServer",
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={() => setImportDialogOpen(true)}
                  >
                    <Import data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.mcp.import.action" })}
                  </Button>
                </>
              }
            />
          ) : null}
        </section>
        {pluginMcpGroups.map((group) => (
          <section
            key={group.pluginId}
            className="space-y-4"
            data-mcp-plugin-group={group.pluginId}
          >
            <SettingsResourceGroupHeader
              count={group.items.length}
              title={resolvePluginDisplayName(
                {
                  name: group.pluginName,
                  listing: pluginListingById.get(group.pluginId),
                },
                locale,
              )}
            />
            <PluginMcpServerList
              items={group.items}
              pluginListingById={pluginListingById}
              onOpenAuthorization={handleOpenPluginAuthorization}
            />
          </section>
        ))}
      </div>
      <McpServersImportDialog
        // The dialog carries mcpStore's currentProjectPath; only when it matches the current
        // target is it same-origin with the services' host. A mismatched transition frame must not
        // let the import write B's path under A's host.
        open={importDialogOpen && mcpStoreMatchesActiveWorkspace}
        workspacePath={currentProjectPath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await loadMcpFromUserDirectory();
        }}
      />
      {dataSync.dialog}
    </div>
  );
}
