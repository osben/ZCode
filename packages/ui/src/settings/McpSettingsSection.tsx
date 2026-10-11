/* eslint-disable max-lines -- The MCP settings page centralizes the list, Plugin groups, form entry point, and title-row mode switch; splitting it would increase cross-state complexity. */
/**
 * MCP Settings Section
 *
 * Manages MCP server configuration in the settings page.
 * Supports the unified ZCode Agent MCP source backed by settings directories.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  convertToZCodeAgentMcpServer,
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_PLUGIN_MCP_SERVER_ROW,
  testId,
} from "@zcode/shared";
import type {
  RemoteTarget,
  ZCodeAvailablePluginSummary,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
} from "@zcode/shared";
import { isZCodeAgentMcpStatusModeUnsupportedError, type IMcpSyncService } from "@zcode/services";
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
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { ExternalLink, Import, Plus, UploadCloud } from "lucide-react";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { selectPluginsForScope } from "@/settings/pluginCapabilityProjection.js";

const DEFAULT_MCP_SOURCE: ServerScope = "zcodeagentmcp";
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS = 1_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS = 5 * 60_000;
const MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS = 10;

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
  // mcp/list now goes through IMcpSyncService; the UI does not access zcodeAgentService directly.
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
    // Workspace switching clears server/status first; if the empty state retains A's deduplication key,
    // returning to the same A config is mistaken for an already-refreshed state, leaving the list and OAuth polling stuck at unknown.
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
    // keep the bounded retry window for the same workspace as the same object, or it will clean itself up after the first response.
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

/** Refresh source: manual means the user clicked refresh; auto means it was triggered by list/configuration changes. */
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
  // serverStatusListKey is empty when only host/plugin built-in MCPs exist and there are no user MCPs.
  // This is fine for deduplicating automatic refreshes, but a user click must issue a request or the button appears unresponsive.
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
    const zcodeAgentServer = convertToZCodeAgentMcpServer(server.name, server.config);
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
    // OAuth pending/follow-up/focus refreshes read runtime state only; do not let a pending subset enter the connect replace path.
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
                  className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
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
  localWorkspacePath?: string;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
}

export function McpSettingsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
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
}: McpSettingsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const platform = usePlatform();
  const baseServices = useBaseWorkspaceServices();

  const storedServers = useMcpStore((s) => s.servers);
  const storedStatusSnapshots = useMcpStore((s) => s.statusSnapshots);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const currentProjectPath = useMcpStore((s) => s.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((s) => s.currentWorkspaceIdentity);
  const storeActiveWorkspacePath = useTabStore((s) => s.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((s) => s.activeWorkspaceIdentity ?? undefined);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity;
  const activeWorkspaceKey = activeWorkspaceIdentity?.trim() || activeWorkspacePath || "";
  const currentMcpStoreWorkspaceKey = currentWorkspaceIdentity?.trim() || currentProjectPath;
  // Reason for the fix: The active tab can change before the asynchronous MCP catalog loads; during the transition, do not combine A’s settings with
  // snapshot onto B, and a later effect must not send this sensitive configuration to B's Agent.
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
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
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
    // Merging a status snapshot recreates the pending server array and restarts the polling effect.
    // The deadline must change only with workspace/pending authorization windows; otherwise slow requests continually renew the five-minute window.
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
      // The queue runner and in-flight response may outlive a workspace; active/store/readiness keys
      // must still match before sending a request or merging its result.
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
        // These guards previously returned silently, leaving no request or trace after the user clicked refresh;
        // logs could not show whether the request was never sent or was sent but returned stale state.
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
          // The settings list may come from the `.agents/mcp.json` fallback; the Agent's mcp/list createConfig cannot read
          // these UI-resolved MCPs, so send them explicitly as we do for a real session.
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
            // Bugfix: Manual refresh failures used to appear only in logs, leaving users with stale state and no feedback.
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
          // Older Agents consistently reject mode=status. Keeping the pending timer and focus listener running
          // would produce the same protocol error every second without advancing OAuth state.
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
  // The refresh button previously gave no visible feedback: the request could be silently dropped by a guard or still be in flight.
  // First ensure configuration is loaded, then issue one manual request and show the button's loading state while it runs.
  const handleManualRefresh = useCallback(async () => {
    if (refreshingStatusList) return;
    setRefreshingStatusList(true);
    try {
      await loadMcpFromUserDirectory(services.mcpSyncService, activeWorkspaceIdentity);
      if (activeWorkspacePath && !mcpConfigReadyWorkspaceKey) {
        const loaded = await ensureLoadedForWorkspace(
          activeWorkspacePath,
          services.mcpSyncService,
          activeWorkspaceIdentity,
        );
        const state = useMcpStore.getState();
        const loadedWorkspaceKey =
          state.currentWorkspaceIdentity?.trim() || state.currentProjectPath;
        if (loaded && loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
          // The ref is synchronized only during render; update it here too or a request immediately following in the same tick
          // will still be skipped as config-not-ready and the user will have to click refresh again.
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
    )
      .then((loaded) => {
        if (cancelled || !loaded) {
          return;
        }
        const state = useMcpStore.getState();
        const loadedWorkspaceKey =
          state.currentWorkspaceIdentity?.trim() || state.currentProjectPath;
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
      configScope: scopeFilter,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
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
    // authorizationUrl is briefly cleared between OAuth callback completion and MCP reconnection.
    // The follow-up must carry the original workspaceKey and must not reuse stale configuration after switching workspaces.
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
        // Reason for the fix: mcp/list returns authorizationUrl quickly and leaves the agent waiting for OAuth in the background
        // callback and reconnection. If the current settings page stops fetching snapshots, the UI stays in connecting until the tab is remounted.
        // OAuth polling is high frequency and must use status-only, preventing a pending subset from triggering replace semantics that disconnect unrelated MCPs.
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
    shouldShowRemoteSyncActions({
      remoteSessionId,
      remoteTarget,
      clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.mcpSyncService),
    }) && activeWorkspacePath
      ? remoteTarget
      : null;
  const isRemoteSyncContext = Boolean(connectedRemoteSyncTarget);
  const pluginMcpServers = useMemo(() => {
    if (!shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext)) {
      // The plugin MCP list comes from the local plugin-management store, not the current remote target.
      // Like Skills, remote MCP settings must show only resources readable/writable in the remote workspace.
      return [];
    }
    const pluginStoreMatchesTarget =
      (pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || "") ===
        activeWorkspaceKey && pluginConfigScope === scopeFilter;
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
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";

  async function handleToggle(id: string, enabled: boolean) {
    await toggleServer(id, enabled);

    if (!enabled) {
      // unknown after disabling is only a local display state; toggleServer has already invalidated old requests.
      // Do not advance the epoch again here, or a just-returned mcp/list will be discarded and the UI may spin repeatedly.
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }

    // A shallow renderer-side check cannot actually start stdio MCP and previously marked nonexistent commands as connected.
    // Show connecting after opening; wait for the Agent's real mcp/list connect/listTools result to set the final green/red state.
    if (!activeWorkspacePath) {
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }
    // connecting is only a temporary display state while waiting for real mcp/list; it must not invalidate subsequent batch requests.
    updateServerStatus(id, "connecting", undefined, {
      invalidateStatusListRequests: false,
    });
    void requestMcpServerStatusList();
  }

  async function handleSave(form: FormState, prev?: ZCodeMcpServer) {
    if (!activeWorkspacePath) {
      return;
    }
    const loaded = await ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
    );
    if (!loaded) {
      return;
    }
    const config = {
      ...formToConfig(form),
      ...(prev?.enabled === false ? { enable: false } : {}),
    };
    // Form Scope can change independently of the parent page; do not keep reading currentProjectPath, which may still belong to the old target.
    // The save target must use the workspace props already resolved and loaded by the form.
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
      {connectedRemoteSyncTarget ? (
        <div className="flex justify-end">
          <ControlHintTooltip title={intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label={intl.formatMessage({
                id: "settings.mcp.remoteSync.open",
              })}
              onClick={() => setRemoteMcpSyncOpen(true)}
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
        // The dialog carries mcpStore's currentProjectPath, which shares a host with services only when it matches the current target.
        // A mismatched transition frame must not import path B using host A.
        open={importDialogOpen && mcpStoreMatchesActiveWorkspace}
        workspacePath={currentProjectPath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await loadMcpFromUserDirectory(services.mcpSyncService, activeWorkspaceIdentity);
        }}
      />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={Boolean(connectedRemoteSyncTarget && activeWorkspacePath)}
        skillOpen={false}
        mcpOpen={remoteMcpSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        localMcpSyncService={baseServices.mcpSyncService}
        remoteMcpSyncService={services.mcpSyncService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath={activeWorkspacePath ?? ""}
        mcpLocalWorkspacePath={localWorkspacePath}
        onSkillsSynced={() => {}}
        onMcpSynced={async () => {
          const loaded = await loadMcpFromUserDirectory(
            services.mcpSyncService,
            activeWorkspaceIdentity,
          );
          if (loaded) {
            await requestMcpServerStatusList();
          }
        }}
      />
    </div>
  );
}
