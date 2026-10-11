/* eslint-disable max-lines -- The Plugin Marketplace container coordinates list/details, source dialog, uninstall confirmation, try navigation, and skill-refresh cleanup; keeping them together maintains consistent interactions. */
import { PluginAddMenu } from "@/settings/PluginAddMenu.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { marketingNavigation, finishMarketingNavigation } from "@/lib/marketingNavigation.js";
import { RefreshCw, Settings } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { PluginStoreSourcesDialog } from "@/settings/PluginStoreSourcesDialog.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import {
  buildStoreItems,
  canUpdatePluginItem,
  isPluginUpdatePending,
  resolveItemDisplayName,
  resolvePluginDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import { claimMarketplaceAutoRefresh } from "@/settings/officialMarketplaceAutoRefresh.js";
import { consumePluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";

interface PluginStorePageProps {
  isWebRemoteControl?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onManageInstalled: () => void;
}

type PluginStoreView = "store" | "detail";

export function PluginStorePage({
  isWebRemoteControl = false,
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onManageInstalled,
}: PluginStorePageProps) {
  const { intl, locale } = useZCodeIntl();
  const { order: storeOrder, refresh: refreshStoreOrder } = usePluginStoreOrder();
  const { pluginManagementService, skillsService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    workspacePath ?? undefined,
    undefined,
    workspaceIdentity,
  );
  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const loadedWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const loadedWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const error = usePluginManagementStore((state) => state.error);
  const operationId = usePluginManagementStore((state) => state.operationId);
  const describeCache = usePluginManagementStore((state) => state.describeCache);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const updateMarketplace = usePluginManagementStore((state) => state.updateMarketplace);
  const addMarketplace = usePluginManagementStore((state) => state.addMarketplace);
  const removeMarketplace = usePluginManagementStore((state) => state.removeMarketplace);
  const installPlugin = usePluginManagementStore((state) => state.installPlugin);
  const describePlugin = usePluginManagementStore((state) => state.describePlugin);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const restoreBuiltin = usePluginManagementStore((state) => state.restoreBuiltin);

  const [view, setView] = useState<PluginStoreView>("store");
  const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addMarketplaceError, setAddMarketplaceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Restore the scroll position from before entering details when returning to the list (the Settings main container scrolls).
  const storeScrollTopRef = useRef(0);
  const [initialNavigationTarget] = useState(() => consumePluginStoreOpenTarget());
  const initialNavigationTargetRef = useRef(initialNavigationTarget);
  useEffect(() => {
    if (initialNavigationTarget?.intent === "add-marketplace") setAddSourceOpen(true);
  }, [initialNavigationTarget]);

  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;

  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    // Marketplace manages only the Host User inventory. Even when opened from a Workspace window, do not include
    // Workspace config in its projection, or project configuration will appear to be an installation scope.
    void initialize({
      workspacePath,
      workspaceIdentity,
      configScope: "user",
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, workspaceIdentity, workspacePath]);

  // Catalog Auto-Refresh applies only to the official ZCode marketplace. Refresh the CDN catalog whenever entering the marketplace page,
  // so newly listed Plugins do not require a manual refresh; throttle to a 10-minute window and reserve a slot on start to debounce (do not repeat failures/in-flight requests).
  // See officialMarketplaceAutoRefresh for conditions. Keep state at module scope rather than a component ref because the page remounts on every entry.
  useEffect(() => {
    const official = marketplaces.find((item) => item.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
    if (
      official &&
      claimMarketplaceAutoRefresh(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, official.lastUpdated)
    ) {
      void updateMarketplace(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, pluginManagementService);
    }
  }, [marketplaces, pluginManagementService, updateMarketplace]);

  const items = useMemo(
    () =>
      buildStoreItems({
        marketplaces,
        marketplaceAvailabilityKnown,
        availablePlugins,
        installedPlugins,
        plugins,
        restorableBuiltins,
      }),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const detailItem = detailPluginId ? (itemById.get(detailPluginId) ?? null) : null;
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  const isMarketingDestinationVisible = useOptionalTabStore((state) => {
    const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return Boolean(
      tab &&
      isWorkspaceTab(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
        (workspaceIdentity?.trim() || workspacePath),
    );
  });
  useEffect(() => {
    if (marketingRequest?.target.page !== "plugin_marketplace") return;
    if (!isMarketingDestinationVisible) return;
    const pluginId = marketingRequest.target.plugin_id;
    if (!workspacePath) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
      return;
    }
    if (
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    )
      return;
    if (error || (pluginId && !itemById.has(pluginId))) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_plugin_unavailable"));
    } else if (pluginId ? view === "detail" && detailPluginId === pluginId : view === "store") {
      finishMarketingNavigation(marketingRequest.id);
    } else {
      setDetailPluginId(pluginId ?? null);
      setView(pluginId ? "detail" : "store");
      setQuery("");
    }
  }, [
    marketingRequest,
    isMarketingDestinationVisible,
    workspacePath,
    loading,
    loadedWorkspacePath,
    loadedWorkspaceIdentity,
    normalizedWorkspaceIdentity,
    error,
    itemById,
    view,
    detailPluginId,
  ]);
  // Show Plugin warning diagnostics (such as an empty scan of declared skill paths) in the detail page's advanced section to avoid silent failure.
  const detailPluginInfo = detailItem?.info;
  const detailPluginWarnings = detailPluginInfo
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === detailPluginInfo.id && diagnostic.severity === "warning",
      )
    : [];

  // Fill in detail-page data: call describe on demand for entries without runtime info (uninstalled candidates) to get component lists and manifest fallback fields.
  useEffect(() => {
    if (view !== "detail" || !detailItem || detailItem.info) return;
    void describePlugin(
      detailItem.id,
      detailItem.name,
      detailItem.marketplace,
      pluginManagementService,
    );
  }, [describePlugin, detailItem, pluginManagementService, view]);

  // Return to the list when a detail entry disappears (for example, a restorable built-in record is removed after uninstall) to avoid an empty detail page.
  useEffect(() => {
    if (view === "detail" && detailPluginId && !itemById.has(detailPluginId)) {
      setView("store");
      setDetailPluginId(null);
    }
  }, [detailPluginId, itemById, view]);

  const scrollContainer = (): HTMLElement | null => rootRef.current?.closest("main") ?? null;

  const openDetail = useCallback((pluginId: string) => {
    storeScrollTopRef.current =
      (rootRef.current?.closest("main") as HTMLElement | null)?.scrollTop ?? 0;
    setDetailPluginId(pluginId);
    setView("detail");
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    const target = initialNavigationTargetRef.current;
    if (
      !target?.pluginId ||
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    ) {
      return;
    }
    initialNavigationTargetRef.current = null;
    if (itemById.has(target.pluginId)) {
      openDetail(target.pluginId);
      return;
    }
    // If the candidate is still missing after refresh, keep searching by stable ID so users see an explicit empty result instead of an erroneous detail page.
    setView("store");
    setQuery(target.pluginId);
  }, [
    itemById,
    loadedWorkspaceIdentity,
    loadedWorkspacePath,
    loading,
    normalizedWorkspaceIdentity,
    openDetail,
    workspacePath,
  ]);

  const backToStore = useCallback(() => {
    setView("store");
    setDetailPluginId(null);
    requestAnimationFrame(() => {
      const main = scrollContainer();
      if (main) main.scrollTop = storeScrollTopRef.current;
    });
  }, []);

  // Top-bar refresh means a real network update: updateMarketplace(null) refetches all marketplace manifests (CDN and git sources,
  // then reloads the overview internally), followed by a completion notice based on the number of update badges. A local reload alone
  // would not show newly added CDN Plugins after the user clicks Refresh, contrary to the spec ("Refresh → update(null)").
  const handleRefresh = async () => {
    void refreshStoreOrder(true);
    setRefreshing(true);
    try {
      await handleCheckForUpdates();
    } finally {
      setRefreshing(false);
    }
  };

  // After a Plugin package change (install / uninstall / update), run shared cleanup: invalidate draft sessions and refresh skills,
  // preventing stale or old-version capabilities from remaining in a conversation.
  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      zcodeSessionService,
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-plugin-enabled",
    });
    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      skillsService,
    });
  }, [normalizedWorkspaceIdentity, skillsService, workspacePath, zcodeSessionService]);

  const uninstall = usePluginUninstall({
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    operationId,
    onAfterUninstall: async () => {
      await refreshAfterPluginChange();
    },
  });

  const handleInstall = useCallback(
    async (item: StorePluginItem) => {
      if (item.restorable) {
        await restoreBuiltin(item.id, pluginManagementService);
      } else {
        await installPlugin(item.name, item.marketplace, pluginManagementService, "user");
      }
      // Install/restore introduces new skills and commands, so run cleanup just as for enable/disable/uninstall.
      await refreshAfterPluginChange();
    },
    [installPlugin, pluginManagementService, refreshAfterPluginChange, restoreBuiltin],
  );

  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) {
        return;
      }
      // Upgrade replaces Skill, Command, and MCP definitions together. The old entry point refreshed only the marketplace list,
      // leaving prewarmed draft sessions with old or even empty capabilities, so new conversations remained unusable after "Upgrade successful."
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );

  const handleCheckForUpdates = useCallback(async () => {
    const succeeded = await updateMarketplace(null, pluginManagementService);
    if (!succeeded) {
      const message = usePluginManagementStore.getState().error;
      if (message) {
        toast(message);
      }
      return;
    }
    const pendingCount = usePluginManagementStore
      .getState()
      .installedPlugins.filter((item) => isPluginUpdatePending(item.updateStatus)).length;
    if (pendingCount > 0) {
      toast(
        intl.formatMessage(
          { id: "settings.plugins.checkForUpdates.found" },
          { count: String(pendingCount) },
        ),
      );
      return;
    }
    toast(intl.formatMessage({ id: "settings.plugins.checkForUpdates.none" }));
  }, [intl, pluginManagementService, updateMarketplace]);

  const handleAddMarketplace = useCallback(
    async (source: string) => {
      const succeeded = await addMarketplace(source, pluginManagementService);
      // Show marketplace-source errors at the same layer as the submit entry; otherwise the dialog overlay covers the global error banner.
      setAddMarketplaceError(
        succeeded ? null : (usePluginManagementStore.getState().error ?? null),
      );
      // Custom marketplaces are not part of the public section; switch to Personal after adding one so users immediately see the new source.
      if (succeeded) setSegment("personal");
      return succeeded;
    },
    [addMarketplace, pluginManagementService],
  );

  const handleUsePrompt = useCallback(
    (item: StorePluginItem, prompt: string) => {
      // If not installed, selecting a prompt first guides the user through installation; do not create a conversation.
      if (!item.installed) {
        void handleInstall(item);
        return;
      }
      if (!workspacePath || !onCreateTask) {
        return;
      }
      // The old entry point bypassed Root's standard new-task flow and wrote only to the session store,
      // so the Settings overlay stayed open and a Composer remount could overwrite the prefill. Delegate to Root now,
      // reusing the @ Picker's canonical Plugin link without adding a second reference semantic.
      onCreateTask({
        initialPrompt: buildPluginStoreTryPrompt({ item, locale, prompt }),
        initialPromptMention: buildPluginStoreTryMention({ item, locale }),
      });
    },
    [handleInstall, locale, onCreateTask, workspacePath],
  );

  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: openDetail,
      onInstall: (item) => void handleInstall(item),
      onUninstall: uninstall.requestUninstall,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      operationId,
      togglingPluginId: null,
    }),
    [handleInstall, handleUpdatePlugin, openDetail, operationId, uninstall.requestUninstall],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.noWorkspace" })}
      </div>
    );
  }

  const detailUpdatePending = canUpdatePluginItem(detailItem);

  return (
    <div ref={rootRef} className="space-y-5" data-testid="plugin-store-root" data-view={view}>
      <SettingsBreadcrumbReporter
        items={
          view === "detail" && detailItem
            ? [{ label: resolveItemDisplayName(detailItem, locale) }]
            : []
        }
        onSectionSelect={backToStore}
      />
      {view === "store" ? (
        <h1
          data-testid="plugin-store-title"
          className="text-2xl font-semibold tracking-tight text-foreground lg:text-3xl"
        >
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </h1>
      ) : null}
      {view === "store" ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.store.subtitle" })}
          </p>
          {/* Top-bar actions: refresh / manage marketplace sources (gear) / add marketplace source. */}
          <div className="flex shrink-0 items-center gap-2">
            <ControlHintTooltip
              title={
                refreshing
                  ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                  : intl.formatMessage({ id: "settings.plugins.refresh" })
              }
            >
              <Button
                type="button"
                data-testid="plugin-store-refresh"
                variant="outline"
                size="icon-lg"
                aria-label={
                  refreshing
                    ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                    : intl.formatMessage({ id: "settings.plugins.refresh" })
                }
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <RefreshCw
                  className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
            >
              <Button
                type="button"
                data-testid="plugin-store-sources-open"
                variant="outline"
                size="icon-lg"
                aria-label={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
                onClick={() => setSourcesOpen(true)}
              >
                <Settings className="size-3.5" aria-hidden="true" />
              </Button>
            </ControlHintTooltip>
            <PluginAddMenu
              testId="plugin-store-create"
              isWebRemoteControl={isWebRemoteControl}
              onCreateTask={onCreateTask}
              onAddMarketplace={() => {
                setAddMarketplaceError(null);
                setAddSourceOpen(true);
              }}
            />
          </div>
        </div>
      ) : null}

      {error && !addSourceOpen ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="plugin-store-error"
        >
          {error}
        </div>
      ) : null}

      {view === "detail" && detailItem ? (
        <PluginStoreDetailView
          item={detailItem}
          actions={actions}
          describeEntry={describeCache[detailItem.id]}
          onRetryDescribe={() =>
            void describePlugin(
              detailItem.id,
              detailItem.name,
              detailItem.marketplace,
              pluginManagementService,
              true,
            )
          }
          onUsePrompt={handleUsePrompt}
          advanced={
            detailItem.info ? (
              <div className="space-y-4">
                {detailUpdatePending ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-ui-base font-medium text-foreground">
                        {detailItem.installedMeta?.updateStatus === "update-available"
                          ? intl.formatMessage(
                              { id: "settings.plugins.detail.updateAvailable" },
                              { version: detailItem.installedMeta?.latestVersion ?? "" },
                            )
                          : intl.formatMessage({ id: "settings.plugins.detail.versionChanged" })}
                      </p>
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id: "settings.plugins.detail.updateNewSessionsNote",
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      data-testid="plugin-store-detail-update"
                      variant="outline"
                      size="sm"
                      disabled={operationId === `plugin:update:${detailItem.id}`}
                      onClick={() => void handleUpdatePlugin(detailItem.id)}
                    >
                      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
                    </Button>
                  </div>
                ) : null}
                <PluginStoreAdvancedSection>
                  {detailPluginWarnings.length > 0 ? (
                    <div>
                      <div className="mb-2 text-ui-xs font-medium text-foreground">
                        {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                      </div>
                      <PluginWarningList warnings={detailPluginWarnings} />
                    </div>
                  ) : null}
                  <PluginDetailRow
                    label={intl.formatMessage({ id: "settings.plugins.detail.rootPath" })}
                    value={detailItem.info.rootPath}
                  />
                  {(detailItem.info.hookDetails ?? []).length > 0 ? (
                    <PluginHookDetails hooks={detailItem.info.hookDetails ?? []} />
                  ) : null}
                </PluginStoreAdvancedSection>
              </div>
            ) : undefined
          }
        />
      ) : (
        <PluginStoreListView
          order={storeOrder}
          items={items}
          marketplaces={marketplaces}
          actions={actions}
          loading={loading || (operationId?.startsWith("marketplace:update:") ?? false)}
          query={query}
          onQueryChange={setQuery}
          segment={segment}
          onSegmentChange={setSegment}
          onOpenManage={onManageInstalled}
        />
      )}

      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                itemById.get(uninstall.pendingPlugin.id) ?? {
                  name: uninstall.pendingPlugin.name,
                },
                locale,
              )
            : ""
        }
        pending={uninstall.uninstalling}
        onCancel={uninstall.cancelUninstall}
        onConfirm={() => void uninstall.confirmUninstall()}
      />
      <PluginStoreSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        marketplaces={marketplaces}
        onUpdateMarketplace={(marketplace) =>
          void updateMarketplace(marketplace, pluginManagementService)
        }
        onRemoveMarketplace={(marketplace) =>
          void removeMarketplace(marketplace, pluginManagementService)
        }
        operationId={operationId}
      />
      <AddMarketplaceSourceDialog
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onAddMarketplace={handleAddMarketplace}
        operationId={operationId}
        error={addMarketplaceError}
      />
    </div>
  );
}
