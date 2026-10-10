// Protocol handler for the Plugin conversation-reference catalog.
// Kept separate from plugins.ts (installation/marketplace/start-stop management): this query is a
// read-only projection for the session/draft Picker, and plugins.ts is near the max-lines limit.
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  zcodeProtocolNotifications,
  zcodePluginsReferenceCatalogParamsSchema,
  zcodePluginsResolveSuggestedReferenceParamsSchema,
  type ZCodePluginReferenceCatalogEntry,
  type ZCodePluginDiagnostic as SharedPluginDiagnostic,
  type ZCodePluginsReferenceCatalogResult,
  type ZCodePluginsResolveSuggestedReferenceResult,
} from "@zcode/shared";
import type { PluginReferenceCatalogEntry } from "@zcode/contracts";
import { buildPluginReferenceCatalog } from "@zcode/core";
import {
  getZCodePluginsOverview,
  resolveZCodePlugins,
  updateZCodePluginMarketplace,
} from "../plugins.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// Picker authority: with sessionId, use the identity catalog frozen when that Session was created
// (session-owned); without one, use the current workspace catalog (new draft). If the session does
// not exist, fail closed with a protocol error. Do not silently fall back to workspace authority,
// which would confuse draft and session authority.
export async function getPluginReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  includeCategory = false,
): Promise<ZCodePluginsReferenceCatalogResult> {
  const params = parseParams(zcodePluginsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const displayByPluginId = resolveReferenceListingDisplayByPluginId(
      params.workspace.workspacePath,
    );
    return {
      authority: "session",
      plugins: record.app
        .getPluginReferenceCatalog()
        .plugins.map((entry) => toReferenceCatalogEntry(entry, displayByPluginId, includeCategory)),
    };
  }
  const outcome = resolveZCodePlugins({
    workingDirectory: params.workspace.workspacePath,
  });
  const displayByPluginId = resolveReferenceListingDisplayByPluginId(
    params.workspace.workspacePath,
  );
  return {
    authority: "workspace",
    plugins: buildPluginReferenceCatalog(outcome.plugins).plugins.map((entry) =>
      toReferenceCatalogEntry(entry, displayByPluginId, includeCategory),
    ),
  };
}

const SUGGESTED_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID;
const SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS = 10_000;

/** Trusted pre-install resolution for a recommended Prompt; refresh the official catalog before resolving missing entries, and do not install from a stale snapshot if refresh fails. */
export async function resolveSuggestedPluginReference(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodePluginsResolveSuggestedReferenceResult> {
  const params = parseParams(zcodePluginsResolveSuggestedReferenceParamsSchema, rawParams);
  const stableId = params.stableId.trim();
  const at = stableId.lastIndexOf("@");
  const pluginName = at > 0 ? stableId.slice(0, at) : "";
  const marketplace = at > 0 ? stableId.slice(at + 1) : "";
  const diagnostic = (code: string, message: string): SharedPluginDiagnostic => ({
    code,
    message,
    severity: "error",
    pluginId: stableId,
  });
  const unavailable = (code: string, message: string) => ({
    stableId,
    status: "unavailable" as const,
    diagnostics: [diagnostic(code, message)],
  });

  if (
    !pluginName ||
    marketplace !== SUGGESTED_PLUGIN_MARKETPLACE ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stableId)
  ) {
    return unavailable(
      "plugin_suggested_reference_untrusted_source",
      "推荐插件不是受信任的官方 zcode-plugins-official 来源",
    );
  }

  const workingDirectory = params.workspace.workspacePath;
  const readState = () => {
    const outcome = resolveZCodePlugins({ logger: context.logger, workingDirectory });
    const entry = buildPluginReferenceCatalog(outcome.plugins).plugins.find(
      (candidate) => candidate.pluginId === stableId,
    );
    return { outcome, entry };
  };
  let displayByPluginId: Map<string, PluginReferenceListingDisplay> | undefined;
  const resolveIcon = () => {
    // Icons come only from the target Host's cached official listing and are returned with trusted
    // resolution. The UI no longer reads workspace referenceCatalog for them. overview does not
    // wait for the network and falls back to no icon when unavailable.
    displayByPluginId ??= resolveReferenceListingDisplayByPluginId(workingDirectory);
    return displayByPluginId.get(stableId)?.icon;
  };
  const toResult = (entry: PluginReferenceCatalogEntry) => {
    const icon = resolveIcon();
    return {
      stableId,
      status: (entry.conflictingPluginIds.length > 0
        ? "conflict"
        : entry.enabled
          ? "ready"
          : "disabled") as "conflict" | "ready" | "disabled",
      marketplace,
      pluginName,
      sourceTrust: "official" as const,
      ...(icon ? { icon } : {}),
      diagnostics:
        entry.conflictingPluginIds.length > 0
          ? [
              diagnostic(
                "plugin_suggested_reference_conflict",
                "推荐插件存在同名冲突，不能自动安装或引用",
              ),
            ]
          : [],
    };
  };

  const initial = readState();
  if (initial.entry) return toResult(initial.entry);

  // The old flow returned a missing result to the UI only after refreshing the official Marketplace,
  // providing no feedback during the network wait and making the click look ineffective. After the
  // first local check finds a missing entry, notify the same operation that it is loading.
  context.notify({
    method: zcodeProtocolNotifications.pluginOperationProgress,
    params: { operationId: params.operationId, state: "refreshing" },
  });

  const refreshController = new AbortController();
  const abortRefresh = () => refreshController.abort(signal?.reason);
  if (signal?.aborted) abortRefresh();
  else signal?.addEventListener("abort", abortRefresh, { once: true });
  let refreshTimedOut = false;
  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const refreshRequest = updateZCodePluginMarketplace({
      abortSignal: refreshController.signal,
      logger: context.logger,
      marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
      workingDirectory,
    });
    const refreshTimeoutRequest = new Promise<never>((_, reject) => {
      // A refresh timeout must abort the underlying network/process; ending only the protocol wait
      // would let the old operation continue modifying the catalog snapshot.
      refreshTimeout = setTimeout(() => {
        refreshTimedOut = true;
        const timeoutError = new Error("刷新 zcode-plugins-official 超时（10000 ms）");
        timeoutError.name = "TimeoutError";
        refreshController.abort(timeoutError);
        reject(timeoutError);
      }, SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS);
    });
    const refreshed = await Promise.race([refreshRequest, refreshTimeoutRequest]);
    if (signal?.aborted) return unavailable("plugin_operation_cancelled", "插件操作已取消");
    const failure = refreshed.diagnostics.find(
      (item) => item.pluginId === SUGGESTED_PLUGIN_MARKETPLACE,
    );
    if (failure) return unavailable("marketplace_refresh_failed", failure.message);
  } catch (error) {
    if (refreshTimedOut) {
      return unavailable(
        "marketplace_refresh_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal?.aborted) {
      return unavailable("plugin_operation_cancelled", "插件操作已取消");
    }
    return unavailable(
      "marketplace_refresh_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (refreshTimeout !== undefined) clearTimeout(refreshTimeout);
    signal?.removeEventListener("abort", abortRefresh);
  }

  const afterRefresh = readState();
  if (afterRefresh.entry) return toResult(afterRefresh.entry);
  const overview = getZCodePluginsOverview({ logger: context.logger, workingDirectory });
  const candidate = overview.availablePlugins.find((item) => item.id === stableId);
  if (
    !candidate ||
    candidate.name !== pluginName ||
    candidate.marketplace !== SUGGESTED_PLUGIN_MARKETPLACE
  ) {
    return unavailable("plugin_suggested_reference_not_listed", "刷新后的官方目录中未找到该插件");
  }
  const icon = candidate.listing?.icon?.trim();
  return {
    stableId,
    status: "missing",
    marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
    pluginName: candidate.name,
    sourceTrust: "official",
    ...(icon ? { icon } : {}),
    ...(candidate.listing ? { listing: candidate.listing } : {}),
    diagnostics: [],
  };
}

/**
 * icon/displayName(I18n) is a mutable display projection from the target Host Marketplace listing,
 * not part of the frozen Session identity. The marketplace listing is the source of truth for the
 * original icon/localized display name; plugin manifest/runtime metadata do not contain them.
 * workingDirectory is used only to locate data through the existing Host/config boundary. Join by
 * stable ID for Picker/chip display and search only; reminders still consume the core identity catalog.
 */
interface PluginReferenceListingDisplay {
  category?: string;
  icon?: string;
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
}

function resolveReferenceListingDisplayByPluginId(
  workspacePath: string,
): Map<string, PluginReferenceListingDisplay> {
  const overview = getZCodePluginsOverview({ workingDirectory: workspacePath });
  const displayByPluginId = new Map<string, PluginReferenceListingDisplay>();
  for (const plugin of [
    ...overview.availablePlugins,
    ...overview.installedPlugins,
    ...overview.restorableBuiltins,
  ]) {
    const category = plugin.listing?.category?.trim();
    const icon = plugin.listing?.icon?.trim();
    const displayName = plugin.listing?.displayName?.trim();
    const displayNameI18n = plugin.listing?.displayNameI18n;
    const description = plugin.description?.trim();
    const descriptionI18n = plugin.listing?.descriptionI18n;
    if (!category && !icon && !displayName && !displayNameI18n && !description && !descriptionI18n)
      continue;
    displayByPluginId.set(plugin.id, {
      ...displayByPluginId.get(plugin.id),
      ...(category ? { category } : {}),
      ...(icon ? { icon } : {}),
      ...(displayName ? { displayName } : {}),
      ...(displayNameI18n ? { displayNameI18n } : {}),
      ...(description ? { description } : {}),
      ...(descriptionI18n ? { descriptionI18n } : {}),
    });
  }
  return displayByPluginId;
}

// Identity/capability projection explicitly drops rootPath (runtime provenance only; paths do not
// leave the protocol). icon/displayName(I18n)/description(I18n) are display-only and do not change
// the identifiers-only reminder contract.
function toReferenceCatalogEntry(
  entry: PluginReferenceCatalogEntry,
  displayByPluginId: ReadonlyMap<string, PluginReferenceListingDisplay>,
  includeCategory = false,
): ZCodePluginReferenceCatalogEntry {
  const display = displayByPluginId.get(entry.pluginId);
  return {
    ...(includeCategory ? { category: display?.category ?? "other" } : {}),
    pluginId: entry.pluginId,
    name: entry.name,
    marketplace: entry.marketplace,
    ...(display?.icon ? { icon: display.icon } : {}),
    ...(display?.displayName ? { displayName: display.displayName } : {}),
    ...(display?.displayNameI18n ? { displayNameI18n: display.displayNameI18n } : {}),
    ...(display?.description ? { description: display.description } : {}),
    ...(display?.descriptionI18n ? { descriptionI18n: display.descriptionI18n } : {}),
    enabled: entry.enabled,
    conflictingPluginIds: entry.conflictingPluginIds,
    skillQualifiedNames: entry.skillQualifiedNames,
    mcpServerNames: entry.mcpServerNames,
    subagentNames: entry.subagentNames ?? [],
  };
}
