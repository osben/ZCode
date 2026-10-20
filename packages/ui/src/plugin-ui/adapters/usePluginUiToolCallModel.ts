import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTaskSidePaneMemoryKey,
  claimPluginUiSidePaneAutoOpen,
} from "@/lib/taskSidePaneMemory.js";
import { createPluginUiInteractions } from "@/plugin-ui/adapters/pluginUiInteractions.js";
import { usePluginUiHost } from "@/plugin-ui/adapters/usePluginUiHost.js";
import {
  getPluginUiManualPin,
  setPluginUiManualPin,
  subscribePluginUiDisclosure,
} from "@/plugin-ui/app/pluginUiDisclosureStore.js";
import {
  getPluginUiRowDisposition,
  subscribePluginUiInstances,
} from "@/plugin-ui/app/pluginUiInstanceStore.js";
import {
  claimPluginUiSurface,
  getPluginUiSurface,
  subscribePluginUiSurfaces,
} from "@/plugin-ui/app/pluginUiSurfaceStore.js";
import { buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { appAllowsDisplayMode } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import {
  buildPluginUiToolResult,
  isPluginUiToolCancelled,
  readPluginUiToolInput,
} from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { resolveTheme } from "@/useTheme.js";
import type {
  McpAppsDisplayMode,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";

import type { PluginUiToolCallViewProps } from "@/plugin-ui/contract.js";

const INLINE_AND_FULLSCREEN: readonly McpAppsDisplayMode[] = ["inline", "fullscreen"];
const host_resourceShowInline = (handle: PluginSandboxHandle | null) =>
  handle?.resourceMeta?.showInline === true;
const INLINE_ONLY: readonly McpAppsDisplayMode[] = ["inline"];

/** Adapter from a tool row to plugin UI; React lifecycle and host actions are centralized here, the view only receives a display model. */
export function usePluginUiToolCallModel(
  context: ToolCallBlockRenderContext,
): Omit<PluginUiToolCallViewProps, "fallback"> {
  const { intl, locale } = useZCodeIntl();
  const presentation = useMemo(
    () => readPluginUiPresentation(context.toolCallNode.toolCall.raw),
    [context.toolCallNode.toolCall.raw],
  );
  const scope = context.pluginUi?.scope;
  const onOpenSidePane = context.pluginUi?.onOpenSidePane;
  const toolCall = context.toolCallNode.toolCall;
  const [width, setWidth] = useState(0);
  const [displayMode, setDisplayMode] = useState<McpAppsDisplayMode>("inline");
  // Resource-level showInline arrives only with the handle; read via ref so the host result is not pulled into render-time derivation.
  const hostHandleRef = useRef<PluginSandboxHandle | null>(null);
  const sessionId = scope?.sessionId ?? "";
  const toolScope = useMemo<PluginUiScopeRef>(
    () =>
      presentation?.surface
        ? { kind: "surface", surfaceId: presentation.surface }
        : { kind: "toolCall", toolCallId: toolCall.toolId },
    [toolCall.toolId, presentation?.surface],
  );
  const surfaceTarget = {
    workspacePath: scope?.workspacePath ?? context.workspacePath,
    workspaceIdentity: scope?.workspaceIdentity,
    sessionId,
    pluginId: presentation?.pluginId ?? "",
    serverName: presentation?.serverName,
    resourceUri: presentation?.resourceUri,
  };
  const toolSurfaceKey = buildPluginUiSurfaceKey(
    surfaceTarget,
    resolvePluginUiLogicalScope(presentation ?? {}, toolScope),
  );
  // Surface routing target: when the tool declares a surface, "has the side pane taken over" looks at the surface tab rather than the tool card tab.
  const routedSurfaceKey = presentation?.surface
    ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "surface", surfaceId: presentation.surface })
    : null;
  const sidePaneActive = useSyncExternalStore(
    subscribePluginUiSurfaces,
    () =>
      getPluginUiSurface(toolSurfaceKey) === "side-pane" ||
      (routedSurfaceKey !== null && getPluginUiSurface(routedSurfaceKey) === "side-pane"),
    () => false,
  );

  const toolInput = useMemo(() => readPluginUiToolInput(toolCall), [toolCall]);
  const toolResult = useMemo(
    () => buildPluginUiToolResult(toolCall, presentation),
    [presentation, toolCall],
  );
  // 4b-1: timeline-derived display disposition (superseded / forced inline) and the user's manual pin state.
  const disposition = useSyncExternalStore(
    subscribePluginUiInstances,
    () => getPluginUiRowDisposition(sessionId, toolCall.toolId),
    () => undefined,
  );
  const manualPin = useSyncExternalStore(
    subscribePluginUiDisclosure,
    () => getPluginUiManualPin(sessionId, toolCall.toolId),
    () => undefined,
  );
  const superseded = disposition?.superseded === true;
  const forcedInline =
    disposition?.forcedInline === true || host_resourceShowInline(hostHandleRef.current);
  const pinned = manualPin ?? (forcedInline || disposition?.autoExpand === true);
  const togglePin = useCallback(() => {
    setPluginUiManualPin(sessionId, toolCall.toolId, !pinned);
  }, [pinned, sessionId, toolCall.toolId]);

  const openInSidePane = useCallback(() => {
    if (!presentation) return;

    onOpenSidePane?.({
      // Surface tools open a surface tab (the result is later routed into it); plain tools open a tool card tab.
      ...(presentation.surface
        ? { surfaceId: presentation.surface, serverName: presentation.serverName }
        : { toolCallId: toolCall.toolId, serverName: presentation.serverName }),
      pluginId: presentation.pluginId,
      resourceUri: presentation.resourceUri,
      title: toolCall.title ?? presentation.pluginId,
    });
  }, [
    onOpenSidePane,
    presentation,
    routedSurfaceKey,
    toolCall.title,
    toolCall.toolId,
    toolSurfaceKey,
  ]);

  const handleDisplayModeRequest = useCallback(
    (mode: McpAppsDisplayMode) => {
      if (mode === "fullscreen" && onOpenSidePane) {
        openInSidePane();
        return "fullscreen";
      }
      setDisplayMode(mode);
      return mode;
    },
    [onOpenSidePane, openInSidePane],
  );
  const handleOpenExternal = useCallback(
    (url: string) => context.onOpenBrowserUrl?.(url),
    [context.onOpenBrowserUrl],
  );

  // An MCP business failure can still complete with UI metadata; checking only for a result would let error rows fight over the same page and leave blank cards.
  // Display condition: failed / cancelled rows stay as plain records and must not create an anchor or auto-open the side pane; the raw tool-result is not rewritten.
  const supportedScope =
    Boolean(presentation && scope?.sessionId) &&
    toolCall.status !== "failed" &&
    !isPluginUiToolCancelled(toolCall) &&
    presentation?.isError !== true;
  // availableDisplayModes declared during the page handshake is a hard constraint (spec MUST NOT): when fullscreen is absent, provide no side pane entry and do not auto-open.
  // Capabilities arrive only after initialized, so start assuming "all supported"; once they arrive, host-context-changed is pushed via the availableDisplayModes change.
  const [appAllowsFullscreen, setAppAllowsFullscreen] = useState(true);
  const canOpenSidePane = Boolean(onOpenSidePane) && appAllowsFullscreen;
  const interactions = useMemo(
    () =>
      scope?.sessionId && presentation
        ? createPluginUiInteractions({
            ...scope,
            sessionId: scope.sessionId,
            pluginId: presentation.pluginId,
            scope: toolScope,
          })
        : undefined,
    [presentation, scope, toolScope],
  );
  // When the side pane takes over, the inline display anchor is withdrawn while the manager keeps holding the same live page.
  // Superseded rows stay as plain records; while the result is not ready (pending / running) only a placeholder exists, and the sandbox is created once the result arrives.
  const resultReady = toolResult !== undefined;
  const inlineActive = supportedScope && !sidePaneActive && !superseded && resultReady;
  const host = usePluginUiHost({
    presentation: presentation ?? { serverName: "", pluginId: "", resourceUri: "" },
    scope: {
      workspacePath: scope?.workspacePath ?? context.workspacePath,
      remoteSessionId: scope?.remoteSessionId ?? undefined,
      ...(scope?.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      sessionId,
      scope: toolScope,
    },
    theme: resolveTheme(context.theme ?? "system"),
    locale,
    displayMode,
    toolInput,
    toolResult,
    toolCallId: toolCall.toolId,
    toolCancelled: isPluginUiToolCancelled(toolCall),
    hostVersion: "zcode",
    // Without a side pane entry (e.g. read-only / non-desktop shell) or when the page does not support fullscreen, declare inline only.
    availableDisplayModes: canOpenSidePane ? INLINE_AND_FULLSCREEN : INLINE_ONLY,
    onDisplayModeRequest: handleDisplayModeRequest,
    onOpenExternal: handleOpenExternal,
    width,
    enabled: inlineActive,
    ...(interactions ? { interactions } : {}),
  });
  hostHandleRef.current = host.handle;
  useEffect(() => {
    setAppAllowsFullscreen(appAllowsDisplayMode(host.appCapabilities, "fullscreen"));
  }, [host.appCapabilities]);
  // Resource-level showInline (arrives with the handle): when there is no manual record, write a fixed pin; the collapse boundary is later recomputed from it.
  useEffect(() => {
    if (!supportedScope || host.handle?.resourceMeta?.showInline !== true || !sessionId) return;
    if (getPluginUiManualPin(sessionId, toolCall.toolId) === undefined) {
      setPluginUiManualPin(sessionId, toolCall.toolId, true);
    }
  }, [host.handle, sessionId, supportedScope, toolCall.toolId]);

  useEffect(() => {
    if (!inlineActive || !host.supported) return;
    return claimPluginUiSurface(toolSurfaceKey, "inline");
  }, [inlineActive, host.supported, toolSurfaceKey]);

  // preferredDisplayMode: fullscreen → auto-open the side pane once as soon as the tool card appears.
  // Do not wait for the result: under replay / very fast models, result arrival and turn collapse can land in the same commit batch, and waiting would leave the effect no chance to run.
  // The result is later read by the side pane itself from the live projection by toolCallId / surfaceId.
  const autoOpenKey =
    presentation?.preferredDisplayMode === "fullscreen"
      ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "toolCall", toolCallId: toolCall.toolId })
      : null;
  const sidePaneMemoryKey = buildTaskSidePaneMemoryKey({
    workspacePath: surfaceTarget.workspacePath,
    workspaceIdentity: surfaceTarget.workspaceIdentity,
    taskId: sessionId,
  });
  useEffect(() => {
    if (
      !supportedScope ||
      // Historical expansion remounts old fullscreen rows; auto-open must be blocked synchronously, otherwise old cards would steal the side pane back.
      superseded ||
      !host.supported ||
      !autoOpenKey ||
      !canOpenSidePane
    )
      return;
    // Calls already in the side pane must still consume the claim; otherwise a remount after closing would fire again and override the user's closed state.
    if (!claimPluginUiSidePaneAutoOpen(sidePaneMemoryKey, autoOpenKey)) return;
    if (getPluginUiSurface(routedSurfaceKey ?? toolSurfaceKey) === "side-pane") return;
    openInSidePane();
  }, [
    supportedScope,
    superseded,
    host.supported,
    autoOpenKey,
    sidePaneMemoryKey,
    canOpenSidePane,
    openInSidePane,
    routedSurfaceKey,
    toolSurfaceKey,
  ]);

  return {
    supported: supportedScope && host.supported,
    surface: presentation?.surface,
    preferredDisplayMode: presentation?.preferredDisplayMode ?? "inline",
    sidePaneActive,
    host,
    // Resource-level declaration wins, tool-level is the fallback, and neither means draw a border by default.
    prefersBorder: host.handle?.resourceMeta?.prefersBorder ?? presentation?.prefersBorder ?? true,
    superseded,
    ...(supportedScope && !superseded ? { pinned, onTogglePin: togglePin } : {}),
    pinLabel: intl.formatMessage({ id: "pluginUi.pin" }),
    unpinLabel: intl.formatMessage({ id: "pluginUi.unpin" }),
    loadingLabel: intl.formatMessage({ id: "pluginUi.loading" }),
    errorLabel: intl.formatMessage({ id: "pluginUi.loadFailed" }),
    retryLabel: intl.formatMessage({ id: "pluginUi.retry" }),
    openedLabel: intl.formatMessage({ id: "pluginUi.openedInSidePane" }),
    openLabel: intl.formatMessage({ id: "pluginUi.openInSidePane" }),
    onWidthChange: setWidth,
    onOpenSidePane: canOpenSidePane ? openInSidePane : undefined,
  };
}
