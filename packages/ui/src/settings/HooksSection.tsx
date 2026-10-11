/* eslint-disable max-lines -- The Hooks page aggregates Scope, Plugin projection, search, and configuration writes. */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Hook, HookConfig, ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useHooksStore } from "@/store/hooksStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { HookForm } from "./HookForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import { HooksList, type HookScope, type PluginHookRow } from "./HooksList.js";
import { useWorkspaceHookInlineTrust } from "./useWorkspaceHookInlineTrust.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

interface HooksSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

function isEditableHook(hook: Hook): boolean {
  // workspace-hook-trust: runtime discovery provides an editable flag (workspace Hooks cannot be configured directly by Runtime); prefer it.
  // Local Settings discovery paths without the flag fall back to the old rule.
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// workspace-hook-trust: rows with editable=false and source=zcode are "readonly workspace Hooks from an upstream/ancestor zcode.json."
// They are not imports from a compatible external format; putting them in Legacy would make the Import button fail
// (importHook rejects source=zcode) and violate the "readonly but individually trustable" contract.
// Keep these rows in Installed, gate the Switch by trust state, and use the inline Trust flow.
export function isReadOnlyZCodeHook(hook: Hook): boolean {
  return hook.editable === false && (hook.location?.source ?? "zcode") === "zcode";
}

function isInCompatibilitySection(hook: Hook): boolean {
  return !isEditableHook(hook) && !isReadOnlyZCodeHook(hook);
}

/**
 * workspace-hook-trust: resolve the scope-switch target for the latest review binding.
 * Pure function shared by HooksSection and unit tests:
 * - Select the newest binding by request.createdAt (an incremented generation in the same runtime flow also refreshes createdAt,
 *   representing the "most recently surfaced review").
 * - Prefer exact matching of identity to a tab's scope key; only older local bindings without identity fall back to
 *   workspacePath (matching the fallback rule in matchesWorkspaceBinding).
 * - Return null when no matching tab exists (workspace closed/unknown); the caller must not switch to another tab.
 */
export function resolveLatestReviewScopeTarget(
  bindings: Record<
    string,
    {
      request: { interactionId: string; createdAt: number; workspaceIdentity?: string };
      workspacePath: string;
    }
  >,
  workspaceTabs: readonly { workspacePath: string; workspaceIdentity?: string }[],
): { interactionId: string; scopeKey: string } | null {
  let latest: {
    interactionId: string;
    createdAt: number;
    workspaceIdentity?: string;
    workspacePath: string;
  } | null = null;
  for (const binding of Object.values(bindings)) {
    if (!latest || binding.request.createdAt > latest.createdAt) {
      latest = {
        interactionId: binding.request.interactionId,
        createdAt: binding.request.createdAt,
        workspaceIdentity: binding.request.workspaceIdentity,
        workspacePath: binding.workspacePath,
      };
    }
  }
  if (!latest) return null;
  // Use the same key rule as getPluginWorkspaceKey (identity first, then workspacePath),
  // inlined here instead of reusing it to avoid depending on the full WorkspaceTabState type and to simplify unit tests.
  const scopeKeyOf = (tab: { workspacePath: string; workspaceIdentity?: string }) =>
    tab.workspaceIdentity?.trim() || tab.workspacePath;
  const identity = latest.workspaceIdentity?.trim();
  const tab = identity
    ? workspaceTabs.find((candidate) => scopeKeyOf(candidate) === identity)
    : workspaceTabs.find((candidate) => candidate.workspacePath === latest!.workspacePath);
  return tab ? { interactionId: latest.interactionId, scopeKey: scopeKeyOf(tab) } : null;
}

export function buildPluginHookRows(
  plugins: readonly Pick<ZCodePluginInfo, "enabled" | "hookDetails" | "id" | "name">[],
  installedPlugins: readonly Pick<ZCodeInstalledPluginSummary, "id" | "scope">[],
  scopeMetadataKnown: boolean,
): PluginHookRow[] {
  const scopeByPluginId = new Map(
    installedPlugins.map((plugin) => [plugin.id, plugin.scope] as const),
  );
  return plugins.flatMap((plugin) =>
    (plugin.hookDetails ?? []).map((detail) => ({
      detail,
      pluginEnabled: plugin.enabled,
      pluginId: plugin.id,
      pluginName: plugin.name,
      // When overview degrades, installedPlugins=[] means scope is unknown; do not pretend it is User.
      pluginScope: scopeMetadataKnown ? scopeByPluginId.get(plugin.id) : undefined,
    })),
  );
}

export function filterPluginHooksByScope(
  pluginHooks: readonly PluginHookRow[],
  scope: HookScope,
): PluginHookRow[] {
  const expectedScope = scope === "project" ? "workspace" : "user";
  // Retain unknown-scope entries in both tabs and mark them in the list, preventing real Plugin Hooks from being hidden during degradation.
  return pluginHooks.filter(
    (hook) => hook.pluginScope === undefined || hook.pluginScope === expectedScope,
  );
}

export function HooksSection({ workspacePath, workspaceIdentity }: HooksSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const hooksState = useHooksStore();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const pluginsError = usePluginManagementStore((state) => state.error);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const [viewMode, setViewMode] = useState<"list" | "form">("list");
  const [editingHook, setEditingHook] = useState<Hook | null>(null);
  const [query, setQuery] = useState("");
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    return tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = getPluginWorkspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [tabs]);
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const deferredQuery = useDeferredValue(query);
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  const activeScope: HookScope = selectedWorkspace ? "project" : "user";
  const targetWorkspacePath = selectedWorkspace?.workspacePath ?? workspacePath;
  const targetWorkspaceIdentity = selectedWorkspace?.workspaceIdentity ?? workspaceIdentity;
  const targetWorkspaceKey = targetWorkspacePath
    ? getWorkspaceKey(targetWorkspacePath, targetWorkspaceIdentity)
    : null;
  const targetServiceResolution = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
  );
  // After Scope switches to another remote workspace, the path changes but Hooks/Plugin services still come from
  // the active workspace. Resolve the service host from the same target identity and send no out-of-scope RPC while connecting.
  const { hooksService, pluginManagementService } = targetServiceResolution.services;
  const zcodeSessionService = useZCodeSessionService(
    targetWorkspacePath ?? undefined,
    undefined,
    targetWorkspaceIdentity,
  );
  // workspace-hook-trust: bind trust operations to the currently selected workspace (in multi-workspace Scope, a review binding
  // may belong to another workspace, in which case switch the Scope menu to that workspace).
  // hooksService must receive the target's resolved service: when Scope selects a remote workspace, context services point at
  // the active tab's host, and an out-of-scope RPC would hit the wrong host.
  const { trustActionAvailable, trustingHookId, trustHook } = useWorkspaceHookInlineTrust({
    workspacePath: targetWorkspacePath,
    workspaceIdentity: targetWorkspaceIdentity,
    hooksService: targetServiceResolution.rpcReady ? hooksService : undefined,
    rpcReady: targetServiceResolution.rpcReady,
  });
  const reviewBindings = useWorkspaceHookReviewStore((state) => state.bindings);

  const editableHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          (isEditableHook(hook) || isReadOnlyZCodeHook(hook)) &&
          (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const compatibilityHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          isInCompatibilitySection(hook) && (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const pluginHooks = useMemo(
    () => buildPluginHookRows(plugins, installedPlugins, marketplaceAvailabilityKnown),
    [installedPlugins, marketplaceAvailabilityKnown, plugins],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const scopedPluginHooks = useMemo(
    () =>
      filterPluginHooksByScope(pluginHooks, activeScope).map((hook) => ({
        ...hook,
        pluginIconItem: {
          name: hook.pluginName,
          listing: pluginListingById.get(hook.pluginId),
        },
      })),
    [activeScope, pluginHooks, pluginListingById],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEditableHooks = useMemo(
    () => editableHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [editableHooks, normalizedQuery],
  );
  const filteredCompatibilityHooks = useMemo(
    () => compatibilityHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [compatibilityHooks, normalizedQuery],
  );
  const filteredPluginHooks = useMemo(
    () =>
      scopedPluginHooks.filter((hook) =>
        [
          hook.pluginName,
          hook.detail.event,
          hook.detail.type,
          hook.detail.matcher,
          hook.detail.command,
          hook.detail.sourcePath,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, scopedPluginHooks],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) return;
    void hooksState.initialize(
      targetWorkspacePath ?? undefined,
      targetWorkspaceIdentity,
      hooksService,
    );
  }, [
    hooksService,
    hooksState.initialize,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (!targetWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!targetServiceResolution.rpcReady) return;
    await Promise.all([
      hooksState.initialize(
        targetWorkspacePath ?? undefined,
        targetWorkspaceIdentity,
        hooksService,
      ),
      targetWorkspacePath
        ? initializePlugins({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            pluginService: pluginManagementService,
          })
        : Promise.resolve(),
    ]);
  }, [
    hooksService,
    hooksState.initialize,
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (
      selectedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === selectedScopeKey)
    ) {
      setSelectedScopeKey("user");
    }
  }, [selectedScopeKey, workspaceTabs]);

  // workspace-hook-trust fix: when the conversation starts a review for workspace B, switch the Scope menu to B once. Two constraints:
  // 1. Switch only when a new interaction appears. If the user manually switches to A/User while B's review is pending,
  //    respect that choice instead of repeatedly taking them back (which would lock Settings to B during the pending review).
  // 2. The target workspace must still exist in workspaceTabs. Switching to a closed/disconnected workspace would stop at Connecting
  //    and create a ping-pong loop with the "reset invalid scope to user" effect above.
  const latestReviewScopeTarget = useMemo(
    () => resolveLatestReviewScopeTarget(reviewBindings, workspaceTabs),
    [reviewBindings, workspaceTabs],
  );
  const handledReviewInteractionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestReviewScopeTarget) return;
    if (handledReviewInteractionRef.current === latestReviewScopeTarget.interactionId) return;
    handledReviewInteractionRef.current = latestReviewScopeTarget.interactionId;
    if (latestReviewScopeTarget.scopeKey !== selectedScopeKey) {
      setSelectedScopeKey(latestReviewScopeTarget.scopeKey);
    }
  }, [latestReviewScopeTarget, selectedScopeKey]);

  const invalidateDraft = useCallback(
    async (reason: string) => {
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "hooks",
        reason,
        workspaceIdentity: targetWorkspaceIdentity,
        workspacePath: targetWorkspacePath,
        zcodeSessionService,
      });
    },
    [targetWorkspaceIdentity, targetWorkspacePath, zcodeSessionService],
  );

  const handleSaveHook = useCallback(
    async (config: HookConfig) => {
      try {
        if (editingHook) {
          await hooksState.updateHook(editingHook.id, config, hooksService);
          await invalidateDraft("hook-updated");
        } else {
          await hooksState.addHook(config, hooksService);
          await invalidateDraft("hook-added");
        }
        setViewMode("list");
        setEditingHook(null);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [editingHook, hooksService, hooksState.addHook, hooksState.updateHook, invalidateDraft],
  );
  const handleCreateHook = useCallback(() => {
    setEditingHook(null);
    setViewMode("form");
  }, []);

  const handleDelete = useCallback(
    async (hook: Hook) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.hooks.delete" }),
        description: intl.formatMessage(
          { id: "settings.hooks.deleteDescription" },
          { event: hook.event },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) return;
      try {
        await hooksState.deleteHook(hook.id, hooksService);
        await invalidateDraft("hook-deleted");
        setEditingHook(null);
        setViewMode("list");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [confirmDialog, hooksService, hooksState.deleteHook, intl, invalidateDraft],
  );

  const handleToggle = useCallback(
    async (hook: Hook, enabled: boolean) => {
      try {
        await hooksState.toggleHook(hook.id, enabled, hooksService);
        await invalidateDraft(enabled ? "hook-enabled" : "hook-disabled");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.toggleHook, invalidateDraft],
  );

  const handleImport = useCallback(
    async (hook: Hook) => {
      try {
        await hooksState.importHook(hook.id, hooksService);
        await invalidateDraft("hook-imported");
        toast(intl.formatMessage({ id: "settings.hooks.imported" }));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.importHook, intl, invalidateDraft],
  );

  if (viewMode === "form" && targetServiceResolution.rpcReady) {
    return (
      <>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingHook?.event ?? intl.formatMessage({ id: "settings.hooks.add" }),
            },
          ]}
          onSectionSelect={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
        />
        <HookForm
          hook={editingHook ?? undefined}
          workspaceAvailable={Boolean(targetWorkspacePath)}
          defaultStorageLevel={activeScope}
          selectedScopeKey={selectedScopeKey}
          workspaceTabs={workspaceTabs}
          onScopeKeyChange={setSelectedScopeKey}
          onSave={handleSaveHook}
          onDelete={editingHook ? handleDelete : undefined}
          onCancel={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
          isEditing={Boolean(editingHook)}
        />
      </>
    );
  }

  const loading = hooksState.loading || pluginsLoading;
  const error = hooksState.error || pluginsError;
  const visibleCount =
    filteredEditableHooks.length + filteredCompatibilityHooks.length + filteredPluginHooks.length;
  const totalCount = editableHooks.length + compatibilityHooks.length + scopedPluginHooks.length;
  const hasSearchResultEmpty = Boolean(normalizedQuery) && visibleCount === 0;
  const showWorkspaceHookTrustNotice = shouldShowWorkspaceHookTrustNotice({
    hooks: editableHooks,
    loadedWorkspaceKey: hooksState.loadedWorkspaceKey,
    rpcReady: targetServiceResolution.rpcReady,
    targetWorkspaceKey,
  });
  return (
    <div className="space-y-6" data-testid="hooks-settings-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>{intl.formatMessage({ id: "settings.hooks.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.hooks.searchPlaceholder",
          })}
        />
      </div>

      {showWorkspaceHookTrustNotice ? <WorkspaceHookTrustNotice hooks={editableHooks} /> : null}

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading && totalCount === 0 ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.hooks.searchEmpty" })} />
      ) : (
        <HooksList
          compatibilityHooks={filteredCompatibilityHooks}
          editableHooks={filteredEditableHooks}
          operatingHookId={hooksState.operatingHookId}
          pluginHooks={filteredPluginHooks}
          showInstalledSection={!normalizedQuery}
          installedEmptyTitle={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledTitle",
          })}
          installedEmptyDescription={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledDescription",
          })}
          installedEmptyActions={
            <Button type="button" variant="default" size="lg" onClick={handleCreateHook}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.add" })}
            </Button>
          }
          installedAction={
            <SettingsResourceHeaderActions
              onRefresh={() => void handleRefresh()}
              onNew={handleCreateHook}
              newActionId="settings.hooks.add"
            />
          }
          formatPluginName={(name, pluginId) =>
            resolvePluginDisplayName(
              {
                name,
                listing:
                  (pluginId ? pluginListingById.get(pluginId) : undefined) ??
                  resolveUniquePluginListingByName(availablePlugins, name),
              },
              locale,
            )
          }
          onEdit={(target) => {
            setEditingHook(target);
            setViewMode("form");
          }}
          onImport={handleImport}
          onTrust={trustHook}
          trustActionAvailable={trustActionAvailable}
          trustingHookId={trustingHookId}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}

function hookMatchesQuery(hook: Hook, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    hook.event,
    hook.type,
    hook.matcher,
    hook.command,
    ...(hook.args ?? []),
    hook.location?.directoryPath,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}
