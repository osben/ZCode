import {
  collectTelemetryRendererContext,
  resolveWorkspaceTelemetryDetail,
  type RendererTelemetryEventPayload,
} from "@zcode/shared";
import type {
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiReadResourceResult,
  ZCodePluginsListUiSurfacesResult,
} from "@zcode/shared";
import type {
  McpAppResourceMeta,
  PluginSandboxHandle,
  PluginSandboxRegisterInput,
} from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HTML_MAX_BYTES,
  MCP_APPS_HTML_MIME_TYPES,
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  normalizeMcpAppResourceMeta,
} from "@zcode/shared/mcp-apps";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  IPluginUiBridgeService,
  PluginUiCallToolParams,
  PluginUiCancelToolCallParams,
  PluginUiListResourcesParams,
  PluginUiPrepareSandboxParams,
  PluginUiReadResourceParams,
  PluginUiResourceSubscriptionParams,
  PluginUiWorkspaceTarget,
} from "./contract.js";

export interface PluginUiBridgeServiceDependencies {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  recycleInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<boolean>;
  validateInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;
  openInstance?: (
    params: PluginUiPrepareSandboxParams,
  ) => Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  closeInstance?: (params: import("./contract.js").PluginUiPluginScope) => Promise<void>;

  readMcpResource?: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    pluginId: string;
    serverName: string;
    uri: string;
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  }) => Promise<ZCodeMcpReadResourceResult>;
  callMcpToolForUi?: (
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ) => Promise<ZCodeMcpUiCallToolResult>;
  /** Cancels the in-flight call with the given callId. */
  cancelMcpToolCallForUi?: (
    params: PluginUiCancelToolCallParams,
  ) => Promise<ZCodeMcpUiCancelCallResult>;
  /** Page-initiated `resources/read`; the agent-side `mcp/uiReadResource` validates attribution and mimeType. */
  readMcpResourceForUi?: (
    params: PluginUiReadResourceParams,
  ) => Promise<ZCodeMcpUiReadResourceResult>;
  /** Resource list / templates / subscription proxies; when absent (web / remote) the corresponding methods throw unavailable. */
  listMcpResourcesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi?: (
    params: PluginUiListResourcesParams,
  ) => Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  unsubscribeMcpResourceForUi?: (params: PluginUiResourceSubscriptionParams) => Promise<unknown>;
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  /** Workspace-level `plugins/listUiSurfaces`. */
  listPluginUiSurfaces?: (
    params: PluginUiWorkspaceTarget,
  ) => Promise<ZCodePluginsListUiSurfacesResult>;
  /** CSP / prefersBorder from display.ui are passed in via params at prepare time; this is passthrough only. */
}

export class PluginUiBridgeError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "resource_not_found"
      | "resource_too_large"
      | "unsupported_mime_type"
      | "invalid_server_uri",
    message: string,
  ) {
    super(message);
    this.name = "PluginUiBridgeError";
  }
}

/**
 * Server attribution of a `ui://` resource URI is validated by the agent-side catalog; this only splits the URI into a server name.
 * Convention: for `ui://<plugin-name>/<path>` the namespaced server is given explicitly via params.serverName,
 * never guessed from the URI.
 */
export function createPluginUiBridgeService(
  dependencies: PluginUiBridgeServiceDependencies = {},
): IPluginUiBridgeService {
  // prepare runs only once or twice per sandbox, so info-level logs preserve lifecycle traces (resource reads / registrations / failures) for e2e and user-site debugging.
  // Fix: the logger must be created inside the factory, not at module top level — this file is also bundled into the renderer via the @zcode/services entry,
  // and top-level createServiceLogger reads process.pid at import time, causing a ReferenceError in the renderer that prevents the whole main UI from starting.
  const log = createServiceLogger("plugin-ui-bridge");
  const preparing = new Map<string, Promise<PluginSandboxHandle>>();
  const prepareSandboxOnce = async (
    params: PluginUiPrepareSandboxParams,
    instance: import("@zcode/shared/mcp-apps").McpAppInstance,
  ) => {
    if (
      !dependencies.readMcpResource ||
      !dependencies.registerSandbox ||
      !dependencies.openInstance
    ) {
      throw new PluginUiBridgeError(
        "unavailable",
        "Plugin UI sandbox is unavailable in this runtime",
      );
    }
    const bound = { ...params, instance };
    const startedAt = Date.now();
    log.info(undefined, "prepareSandbox start", {
      sessionId: params.sessionId,
      pluginId: params.pluginId,
      scopeId: params.scopeId,
      resourceUri: params.resourceUri,
    });
    let result: ZCodeMcpReadResourceResult;
    try {
      result = await dependencies.readMcpResource({ ...bound, uri: params.resourceUri });
    } catch (error) {
      log.warn(undefined, "prepareSandbox readResource failed", {
        scopeId: params.scopeId,
        resourceUri: params.resourceUri,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
    try {
      const picked = pickHtmlResource(result, params.resourceUri);
      const { html } = picked;
      // Resource-level _meta is authoritative: first check the HTML entry chosen from resources/read, falling back to the resources/list entry
      // (the spec puts csp / prefersBorder on the list entry's _meta, and the official SDK's registerAppResource writes only there);
      // the tool-level declaration is used only when the resource has the field in neither place; csp is all-or-nothing, not a per-domain union.
      const meta =
        picked.meta ?? (await readListLevelResourceMeta(dependencies.listMcpResourcesForUi, bound));
      const csp = meta?.csp ?? params.csp;
      const prefersBorder = meta?.prefersBorder ?? params.prefersBorder;
      log.info(undefined, "prepareSandbox resource ready", {
        scopeId: params.scopeId,
        htmlBytes: Buffer.byteLength(html, "utf8"),
        hasResourceMeta: meta !== null,
        durationMs: Date.now() - startedAt,
      });
      const handle = await dependencies.registerSandbox({
        instance,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ownerWebContentsId: params.ownerWebContentsId,
        sessionId: params.sessionId,
        pluginId: params.pluginId,
        // partition derives from server identity (plugin servers are shared across workspaces; ordinary MCP servers are isolated per workspace).
        serverName: params.serverName,
        scopeId: params.scopeId,
        html,
        ...(csp ? { csp } : {}),
        // Resource-level `_meta["zcode/csp"]`: unsafe-eval / wasm-unsafe-eval relaxations honor only the resource's own declaration.
        ...(meta?.cspRelaxations ? { cspRelaxations: meta.cspRelaxations } : {}),
        ...(meta?.permissions ? { permissions: meta.permissions } : {}),
        ...(prefersBorder !== undefined ? { prefersBorder } : {}),
        ...(meta?.heightHint !== undefined ? { heightHint: meta.heightHint } : {}),
        ...(meta?.minFrameHeight !== undefined ? { minFrameHeight: meta.minFrameHeight } : {}),
        ...(meta?.showInline !== undefined ? { showInline: meta.showInline } : {}),
        ...(meta?.backgroundRetention !== undefined
          ? { backgroundRetention: meta.backgroundRetention }
          : {}),
      });
      log.info(undefined, "prepareSandbox registered", {
        scopeId: params.scopeId,
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        durationMs: Date.now() - startedAt,
      });
      return handle;
    } catch (error) {
      log.warn(undefined, "prepareSandbox register failed", {
        scopeId: params.scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
      await dependencies.closeInstance?.(bound);
      throw error;
    }
  };

  return {
    async recycleInstance(params) {
      return dependencies.recycleInstance ? dependencies.recycleInstance(params) : false;
    },
    async validateInstance(params) {
      await dependencies.validateInstance?.(params);
    },
    async closeInstance(params) {
      await dependencies.closeInstance?.(params);
    },
    async prepareSandbox(params) {
      if (!dependencies.openInstance) throw unavailable("instance identity");
      const instance = await dependencies.openInstance(params);
      // The merge key comes from the Agent's current connection credentials; initialization after a disconnect must not reuse HTML being read by the previous generation.
      const key = JSON.stringify([
        instance.runtimeId,
        instance.token,
        instance.generation,
        params.resourceUri,
      ]);
      const existing = preparing.get(key);
      if (existing) return existing;
      const pending = prepareSandboxOnce(params, instance).finally(() => {
        if (preparing.get(key) === pending) preparing.delete(key);
      });
      preparing.set(key, pending);
      return pending;
    },
    async callTool(params, options) {
      if (!dependencies.callMcpToolForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI tool calls are unavailable in this runtime",
        );
      }
      const startedAt = Date.now();
      const report = (result: "success" | "failure" | "cancelled") => {
        try {
          void Promise.resolve(
            dependencies.reportTelemetryEvent?.({
              elementName: "plugin_usage",
              eventRegion: "app",
              eventType: "result",
              context: collectTelemetryRendererContext(),
              eventExtraDetail: {
                schema_version: "1",
                action: "ui_tool_call",
                result,
                plugin_id: params.pluginId,
                plugin_component: "ui",
                duration_ms: String(Math.max(0, Date.now() - startedAt)),
                ...resolveWorkspaceTelemetryDetail(params),
              },
            }),
          ).catch(() => {});
        } catch {
          /* 观测失败不能改变工具调用结果。 */
        }
      };
      try {
        const result = await dependencies.callMcpToolForUi(params, options);
        report(result.isError ? "failure" : "success");
        return result;
      } catch (error) {
        report(
          options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")
            ? "cancelled"
            : "failure",
        );
        throw error;
      }
    },
    async cancelToolCall(params) {
      // Without the agent dependency (web / remote) treat it as nothing to cancel and do not error: cancellation is a best-effort cleanup action.
      if (!dependencies.cancelMcpToolCallForUi) return { cancelled: false };
      return dependencies.cancelMcpToolCallForUi(params);
    },
    async readResource(params) {
      if (!dependencies.readMcpResourceForUi) {
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI resource reads are unavailable in this runtime",
        );
      }
      const result = await dependencies.readMcpResourceForUi(params);
      assertUiReadResourceSize(result, params.uri);
      return result;
    },
    async listResources(params) {
      if (!dependencies.listMcpResourcesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourcesForUi(params);
    },
    async listResourceTemplates(params) {
      if (!dependencies.listMcpResourceTemplatesForUi) throw unavailable("resource listing");
      return dependencies.listMcpResourceTemplatesForUi(params);
    },
    async subscribeResource(params) {
      if (!dependencies.subscribeMcpResourceForUi) throw unavailable("resource subscriptions");
      await dependencies.subscribeMcpResourceForUi(params);
    },
    async unsubscribeResource(params) {
      // Unsubscribe is a cleanup action: silently succeed when the dependency is missing (same reasoning as cancelToolCall).
      if (!dependencies.unsubscribeMcpResourceForUi) return;
      await dependencies.unsubscribeMcpResourceForUi(params);
    },
    async listSurfaces(params) {
      // Web / remote workspaces have no local agent runtime: return no entries instead of erroring; the launcher hides the group accordingly.
      if (!dependencies.listPluginUiSurfaces) return [];
      return (await dependencies.listPluginUiSurfaces(params)).surfaces;
    },
  };
}

function unavailable(feature: string): PluginUiBridgeError {
  return new PluginUiBridgeError(
    "unavailable",
    `Plugin UI ${feature} are unavailable in this runtime`,
  );
}

/**
 * 8 MiB total guard: results are structured-cloned over the MessagePort into the sandbox.
 * The agent already rate-limits by the same constant; this recomputes the decoded size (text as UTF-8, blob as decoded base64 length)
 * to catch old agents that skip the check.
 */
export function assertUiReadResourceSize(result: ZCodeMcpUiReadResourceResult, uri: string): void {
  let total = 0;
  for (const content of result.contents) {
    if (typeof content.text === "string") total += Buffer.byteLength(content.text, "utf8");
    if (typeof content.blob === "string") total += decodedBase64Length(content.blob);
  }
  if (total > MCP_APPS_UI_READ_RESOURCE_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource ${uri} decodes to ${total} bytes, exceeding the ${MCP_APPS_UI_READ_RESOURCE_MAX_BYTES} byte limit for resources/read`,
    );
  }
}

function decodedBase64Length(value: string): number {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** Legacy compatibility: returns just the HTML text. */
export function pickHtmlContent(result: ZCodeMcpReadResourceResult, uri: string): string {
  return pickHtmlResource(result, uri).html;
}

const LIST_LEVEL_META_MAX_PAGES = 8;

/**
 * When the resources/read HTML entry carries no `_meta`, page through resources/list looking for the same-uri entry's `_meta` (up to 8 pages).
 * Unavailable list, pagination failure, or no match all count as "no declaration" and must not block sandbox preparation.
 */
async function readListLevelResourceMeta(
  list: PluginUiBridgeServiceDependencies["listMcpResourcesForUi"],
  params: PluginUiPrepareSandboxParams & {
    instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  },
): Promise<McpAppResourceMeta | null> {
  if (!list) return null;
  const scope = {
    instance: params.instance,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    serverName: params.serverName,
  };
  let cursor: string | undefined;
  try {
    for (let page = 0; page < LIST_LEVEL_META_MAX_PAGES; page += 1) {
      const result = await list({ ...scope, ...(cursor ? { cursor } : {}) });
      const entry = result.resources.find((item) => item.uri === params.resourceUri);
      if (entry) return normalizeMcpAppResourceMeta(entry._meta);
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Picks the HTML entry actually used: iterate contents and take the first whose mimeType is on the HTML allowlist
 * (entries matching the requested uri take precedence); read resource-level csp / prefersBorder / size hints from **that entry's** `_meta`.
 * Blobs and oversized content are always rejected, no fallback, no truncation; when no HTML entry exists, the error reports the first entry's mimeType.
 */
export function pickHtmlResource(
  result: ZCodeMcpReadResourceResult,
  uri: string,
): { html: string; meta: McpAppResourceMeta | null } {
  if (result.contents.length === 0) {
    throw new PluginUiBridgeError("resource_not_found", `MCP resource has no contents: ${uri}`);
  }
  const isHtml = (mimeType: string | undefined) => {
    const normalized = normalizeMimeType(mimeType);
    return (
      normalized !== null && (MCP_APPS_HTML_MIME_TYPES as readonly string[]).includes(normalized)
    );
  };
  const content =
    result.contents.find((item) => item.uri === uri && isHtml(item.mimeType)) ??
    result.contents.find((item) => isHtml(item.mimeType));
  if (!content) {
    const first = result.contents[0]!;
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      `MCP resource mimeType is not HTML: ${first.mimeType ?? "(missing)"}`,
    );
  }
  if (typeof content.text !== "string") {
    throw new PluginUiBridgeError(
      "unsupported_mime_type",
      "MCP resource must return HTML as text, blob is not accepted",
    );
  }
  if (Buffer.byteLength(content.text, "utf8") > MCP_APPS_HTML_MAX_BYTES) {
    throw new PluginUiBridgeError(
      "resource_too_large",
      `MCP resource exceeds ${MCP_APPS_HTML_MAX_BYTES} bytes`,
    );
  }
  return { html: content.text, meta: normalizeMcpAppResourceMeta(content._meta) };
}

function normalizeMimeType(value: string | undefined): string | null {
  if (!value) return null;
  // Drop secondary parameters such as charset, but keep profile=mcp-app so the allowlist still matches.
  const parts = value
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !part.startsWith("charset="));
  return parts.join(";");
}
