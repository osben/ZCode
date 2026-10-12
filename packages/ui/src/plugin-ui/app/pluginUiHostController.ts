import { createPluginUiSampling } from "./pluginUiSampling.js";
import type { CallToolResult, Transport } from "@modelcontextprotocol/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle, PluginSandboxTransportPort } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HANDSHAKE_TIMEOUT_MS,
  MCP_APPS_HOST_NAME,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
  buildPluginSandboxScopeId,
} from "@zcode/shared/mcp-apps";
import { createPluginUiAppTools } from "./pluginUiAppTools.js";
import {
  installPluginUiHostAppHandlers,
  installPluginUiHostNotificationHandlers,
} from "./pluginUiHostAppHandlers.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiToolFeed,
} from "./pluginUiHostControllerContract.js";
import { runPluginUiHostTeardown } from "./pluginUiHostTeardown.js";
import { wirePluginUiInteractions } from "./pluginUiInteractionPorts.js";
import { createPluginUiResourceSubscriptions } from "./pluginUiResourceSubscriptions.js";

export type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "./pluginUiHostControllerContract.js";
export function createPluginUiHostController(
  deps: PluginUiHostControllerDeps,
): PluginUiHostController {
  let phase: PluginUiHostPhase = "idle";
  let handle: PluginSandboxHandle | null = null;
  let bridge: PluginUiHostBridge | null = null;
  let boundScope:
    | (ReturnType<typeof baseScope> & { instance: PluginSandboxHandle["instance"] })
    | null = null;
  let transport: Transport | null = null;
  let unsubscribePorts: (() => void) | null = null;
  let hostContext: McpUiHostContext = deps.initialHostContext;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let preparation: Promise<void> | null = null;
  let recycling = false;
  let closedDuringRecycle = false;
  // initialized has arrived: send* may be used directly; earlier notify* calls are not queued — at initialized the latest values are read via getToolFeed.
  let attached = false;
  let cancelHandshakeTimer: (() => void) | null = null;
  // In-flight page tool call ids, each cancelled to the agent on dispose.
  const activeCalls = new Set<string>();
  let unregisterNotifications: (() => void) | null = null;
  const createCallId = deps.createCallId ?? (() => crypto.randomUUID());
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const createAppBridge =
    deps.createAppBridge ??
    ((hostInfo, hostCapabilities, initialContext) =>
      new AppBridge(null, hostInfo, hostCapabilities, {
        hostContext: initialContext,
      }) as unknown as PluginUiHostBridge);

  const setPhase = (
    next: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ) => {
    phase = next;
    deps.onPhase(next, detail);
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.("[plugin-ui] host failed", { message });
    setPhase("error", { error: message });
  };

  /** Attribution scope shared by all requests through the bridge: workspace + session + this plugin's server. */
  const baseScope = () => ({
    workspacePath: deps.scope.workspacePath,
    ...(deps.scope.workspaceIdentity ? { workspaceIdentity: deps.scope.workspaceIdentity } : {}),
    sessionId: deps.scope.sessionId,
    pluginId: deps.presentation.pluginId,
    serverName: deps.presentation.serverName,
  });

  const pluginScope = () => {
    if (!boundScope) throw new Error("MCP App is not prepared");
    return boundScope;
  };

  const sampling = deps.sampling
    ? createPluginUiSampling({
        bridge: deps.sampling,
        scope: pluginScope,
        canSample: () => Boolean(deps.getHostCapabilities().sampling),
        createCallId,
        activeCalls,
        onBusyChange: deps.onBusyChange,
      })
    : undefined;

  const resources = createPluginUiResourceSubscriptions({
    bridge: deps.bridge,
    pluginScope,
    scopeId: buildPluginSandboxScopeId(deps.scope.scope),
    currentGeneration: () => handle?.instance.generation,
    isDisposed: () => disposed,
  });

  // App-Provided Tools: after the handshake, discover page tools and register them; when mailbox deliveries arrive, claim and let the page execute. Skipped entirely without a channel.
  const appTools = deps.appTools
    ? createPluginUiAppTools({
        bridge: deps.appTools,
        pluginScope,
        scopeId: buildPluginSandboxScopeId(deps.scope.scope),
        currentGeneration: () => handle?.instance.generation,
        onBusyChange: deps.onBusyChange,
        setTimer,
        log: deps.log,
      })
    : null;

  const sendFeed = (active: PluginUiHostBridge, feed: PluginUiToolFeed) => {
    if (feed.toolInput) void active.sendToolInput(feed.toolInput).catch(() => undefined);
    if (feed.toolCancelled) {
      void active.sendToolCancelled({}).catch(() => undefined);
    } else if (feed.toolResult) {
      void active.sendToolResult(feed.toolResult as CallToolResult).catch(() => undefined);
    }
  };

  const attachPort = (port: PluginSandboxTransportPort) => {
    sampling?.reset();
    void transport?.close().catch(() => undefined);
    attached = false;
    cancelHandshakeTimer?.();
    // New port = page reload or remount: unsubscribe the old generation's subscriptions, unregister the old instance's tools; notification entries re-register under the new generation.
    resources.unsubscribeAll();
    appTools?.resetForAttach();
    const widgetState = deps.getWidgetState();
    // widgetState initial value ships with the handshake via a hostContext extension key (hostContext allows extra keys); it is never pushed from the host afterwards.
    const contextAtCreate: McpUiHostContext =
      widgetState === undefined
        ? hostContext
        : { ...hostContext, [MCP_APPS_WIDGET_STATE_CONTEXT_KEY]: widgetState };
    const active = createAppBridge(
      { name: MCP_APPS_HOST_NAME, version: deps.hostVersion },
      deps.getHostCapabilities(),
      contextAtCreate,
    );
    const baseContext = hostContext;
    bridge = active;
    // Two Apps in the same page (page-created + alias) each send initialize / initialized: only the first enters running and gets fed.
    let initializedOnce = false;
    active.oninitialized = () => {
      if (disposed || bridge !== active || initializedOnce) return;
      initializedOnce = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      attached = true;
      setPhase("running", { handle: handle ?? undefined });
      deps.onAppCapabilities?.(active.getAppCapabilities());
      appTools?.onInitialized(
        active,
        active.getAppCapabilities(),
        () => !disposed && bridge === active,
      );
      // Updates inside the handshake window must not be lost: replay only the current instance's latest value without adding another session-state owner.
      if (hostContext !== baseContext) active.setHostContext(hostContext);
      sendFeed(active, deps.getToolFeed());
    };
    installPluginUiHostAppHandlers(active, {
      currentContext: () => hostContext,
      applyDisplayMode: (mode) => {
        hostContext = { ...hostContext, displayMode: mode };
        if (attached && bridge === active) active.setHostContext(hostContext);
      },
      onDisplayModeRequest: deps.onDisplayModeRequest,
      pluginScope: () => {
        if (disposed) throw new Error("MCP App instance was closed");
        return pluginScope();
      },
      bridge: deps.bridge,
      createCallId,
      activeCalls,
      onBusyChange: deps.onBusyChange,
      onOpenExternal: deps.onOpenExternal,
    });
    sampling?.install(active, () => !disposed && bridge === active);
    resources.install(active);
    wirePluginUiInteractions(active, deps, deps.platform, () => handle);
    installPluginUiHostNotificationHandlers(active, {
      pluginId: deps.presentation.pluginId,
      onHeight: deps.onHeight,
      log: deps.log,
    });
    const activeTransport = deps.createTransport(port);
    transport = activeTransport;
    cancelHandshakeTimer = setTimer(() => {
      if (disposed || bridge !== active || attached) return;
      fail(new Error("plugin-ui: ui/initialize handshake timed out"));
    }, deps.handshakeTimeoutMs ?? MCP_APPS_HANDSHAKE_TIMEOUT_MS);
    active.connect(activeTransport).catch((error) => {
      if (bridge === active) fail(error);
    });
  };

  return {
    get phase() {
      return phase;
    },
    isBusy: () => activeCalls.size > 0 || (appTools?.isBusy() ?? false),
    async tryRecycle() {
      if (!handle || activeCalls.size || appTools?.isBusy()) return false;
      recycling = true;
      let closed = false;
      try {
        closed = await deps.bridge.recycleInstance(pluginScope());
        return closed;
      } finally {
        recycling = false;
        // A failed recycle RPC must not swallow a source-revocation notification already received while waiting.
        if (!closed && closedDuringRecycle && !disposed) deps.onInstanceClosed?.();
        closedDuringRecycle = false;
      }
    },
    start() {
      if (phase !== "idle") return;
      setPhase("preparing");
      preparation = (async () => {
        try {
          const ownerWebContentsId = await deps.platform.getOwnerWebContentsId();
          if (disposed) return;
          const prepared = await deps.bridge.prepareSandbox({
            ...baseScope(),
            scopeId: buildPluginSandboxScopeId(deps.scope.scope),
            resourceUri: deps.presentation.resourceUri,
            ownerWebContentsId,
            ...(deps.presentation.csp ? { csp: deps.presentation.csp } : {}),
            ...(deps.presentation.prefersBorder !== undefined
              ? { prefersBorder: deps.presentation.prefersBorder }
              : {}),
          });
          // prepare already registered with Host/Main; unloading must not just ignore the reply, otherwise the sandbox would leak.
          if (disposed) {
            await deps.bridge.closeInstance({ ...baseScope(), instance: prepared.instance });
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          try {
            await deps.bridge.validateInstance({ ...baseScope(), instance: prepared.instance });
          } catch (error) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            throw error;
          }
          if (disposed) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          handle = prepared;
          boundScope = { ...baseScope(), instance: prepared.instance };
          // Subscribe to ports before mounting the webview: main delivers the port after the guest's dom-ready, so subscribing after mount could miss it.
          unsubscribePorts?.();
          unsubscribePorts = deps.platform.onPorts((event) => {
            if (disposed || !handle || event.sandboxId !== handle.sandboxId) return;
            // Ports with an older initId are always dropped (guards against cross-wiring on guest reload / duplicate mounts).
            if (event.initId < handle.initId) return;
            handle = { ...handle, initId: event.initId };
            attachPort(event.port);
          });
          unregisterNotifications?.();
          unregisterNotifications =
            deps.resourceNotifications?.register(
              prepared.instance.generation,
              {
                notifyInstanceClosed: () => {
                  if (recycling) closedDuringRecycle = true;
                  else if (!disposed) deps.onInstanceClosed?.();
                },
                notifyResourceUpdated: (uri) => {
                  if (!bridge || !attached || !resources.has(uri)) return;
                  void bridge
                    .notification({ method: "notifications/resources/updated", params: { uri } })
                    .catch(() => undefined);
                },
                notifyResourceListChanged: () => {
                  if (!bridge || !attached) return;
                  void bridge
                    .notification({ method: "notifications/resources/list_changed", params: {} })
                    .catch(() => undefined);
                },
                notifyAppToolCall: (call) => {
                  if (!bridge || !attached) return;
                  appTools?.execute(bridge, call);
                },
              },
              prepared.instance,
            ) ?? null;
          setPhase("mounted", { handle: prepared });
        } catch (error) {
          fail(error);
        }
      })();
    },
    updateHostContext(patch) {
      hostContext = { ...hostContext, ...patch };
      if (bridge && attached) bridge.setHostContext(hostContext);
    },
    notifyToolInput(input) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolInput(input).catch(() => undefined);
    },
    notifyToolResult(result) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolResult(result as CallToolResult).catch(() => undefined);
    },
    notifyToolCancelled() {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolCancelled({}).catch(() => undefined);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      unsubscribePorts?.();
      unsubscribePorts = null;
      const current = handle;
      const scope = current ? { ...baseScope(), instance: current.instance } : null;
      unregisterNotifications?.();
      unregisterNotifications = null;
      const active = bridge,
        activeTransport = transport,
        wasAttached = attached;
      // Unregister requests captured the original credentials; the generation must not be read from a new handle after await.
      bridge = null;
      transport = null;
      attached = false;
      handle = null;
      setPhase("disposed");
      disposal = (async () => {
        if (scope) await deps.bridge.closeInstance(scope).catch(() => undefined);
        sampling?.reset();
        await preparation;
        resources.unsubscribeAll();
        appTools?.dispose();
        activeCalls.clear();
        await runPluginUiHostTeardown({
          bridge: active,
          transport: activeTransport,
          wasAttached,
          handle: current,
          platform: deps.platform,
          setTimer,
          ...(deps.teardownTimeoutMs !== undefined
            ? { teardownTimeoutMs: deps.teardownTimeoutMs }
            : {}),
        });
      })();
      return disposal;
    },
  };
}
