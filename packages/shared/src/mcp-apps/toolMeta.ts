import type {
  McpAppCspRelaxations,
  McpAppResourceMeta,
  McpAppsDisplayMode,
  McpAppsResourcePermission,
  McpAppsToolVisibility,
  McpToolUiCsp,
  McpToolUiDescriptor,
} from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_FLAGS,
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_DEFAULT_TOOL_VISIBILITY,
  MCP_APPS_RESOURCE_PERMISSIONS,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_UI_RESOURCE_SCHEME,
} from "./contract.js";

/**
 * Tool visibility is decoupled from UI presentation. Reads only `_meta.ui.visibility`, defaulting
 * to `["model", "app"]`;
 * pure data tools without a `ui://` resource use it too to decide whether they enter the model's
 * tool table, instead of being dropped wholesale for lacking a resourceUri.
 */
export function readMcpToolVisibility(meta: unknown): McpAppsToolVisibility[] {
  return readVisibility(asRecord(asRecord(meta)?.ui)?.visibility);
}

/**
 * Normalization from a tool's `_meta` to its UI descriptor. Pure function. resourceUri sources, by
 * priority: `_meta.ui.resourceUri` →
 * the deprecated flat key `_meta["ui/resourceUri"]` (spec MUST-compat) → the compat interface's
 * `openai/outputTemplate`.
 * Accepts the `openai/*` aliases; an invalid item only drops that item, except an invalid
 * resourceUri invalidates the whole descriptor (visibility is then reported separately by
 * readMcpToolVisibility).
 */
export function normalizeMcpToolUiMeta(meta: unknown): McpToolUiDescriptor | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const resourceUri =
    readResourceUri(ui?.resourceUri) ??
    readResourceUri(root[MCP_APPS_LEGACY_RESOURCE_URI_META_KEY]) ??
    readResourceUri(root["openai/outputTemplate"]);
  if (!resourceUri) return null;

  const descriptor: McpToolUiDescriptor = {
    resourceUri,
    visibility: readVisibility(ui?.visibility),
  };
  const preferredDisplayMode = readDisplayMode(
    asRecord(root["openai/ui"])?.preferredModelDisplayMode,
  );
  if (preferredDisplayMode) descriptor.preferredDisplayMode = preferredDisplayMode;
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) descriptor.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) descriptor.prefersBorder = prefersBorder;
  const surface = readSurfaceId(ui?.surface);
  if (surface) descriptor.surface = surface;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) descriptor.showInline = showInline;
  return descriptor;
}

/**
 * A `ui://` HTML resource item's own `_meta` (taken from the selected content item's `_meta.ui`).
 * csp and prefersBorder accept the `openai/widgetCSP` / `openai/widgetPrefersBorder` aliases;
 * size hints are only `openai/widgetHeightHint` / `openai/widgetMinFrameHeight`;
 * `openai/widgetShowCodexWidgetInline` → showInline;
 * returns null when nothing is declared.
 */
export function normalizeMcpAppResourceMeta(meta: unknown): McpAppResourceMeta | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const result: McpAppResourceMeta = {};
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) result.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) result.prefersBorder = prefersBorder;
  const heightHint = readPositiveInt(root["openai/widgetHeightHint"]);
  if (heightHint !== undefined) result.heightHint = heightHint;
  const minFrameHeight = readPositiveInt(root["openai/widgetMinFrameHeight"]);
  if (minFrameHeight !== undefined) result.minFrameHeight = minFrameHeight;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) result.showInline = showInline;
  const cspRelaxations = normalizeMcpAppCspRelaxations(meta);
  if (cspRelaxations) result.cspRelaxations = cspRelaxations;
  const permissions = normalizeMcpAppResourcePermissions(ui?.permissions);
  if (permissions.length > 0) result.permissions = permissions;
  return Object.keys(result).length > 0 ? result : null;
}

/** `_meta.ui.permissions`: only the four spec keys with object values (`{}`) are accepted, unknown keys are dropped; returned in fixed order. */
export function normalizeMcpAppResourcePermissions(value: unknown): McpAppsResourcePermission[] {
  const root = asRecord(value);
  if (!root) return [];
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => asRecord(root[key]) !== null);
}

/**
 * Resource-level `_meta["zcode/csp"]`: only boolean keys from `MCP_APPS_CSP_RELAXATION_FLAGS` are
 * accepted, unknown keys and non-boolean values are dropped;
 * returns null when no key is true (false equals "not declared").
 */
export function normalizeMcpAppCspRelaxations(meta: unknown): McpAppCspRelaxations | null {
  const root = asRecord(asRecord(meta)?.[MCP_APPS_CSP_RELAXATION_META_KEY]);
  if (!root) return null;
  const result: McpAppCspRelaxations = {};
  for (const flag of MCP_APPS_CSP_RELAXATION_FLAGS) {
    if (root[flag] === true) result[flag] = true;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Panel id: length and character set restricted; invalid values are dropped (the tool result falls back to an inline card, without an error). */
export function readSurfaceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MCP_APPS_SURFACE_ID_MAX_CHARS) return undefined;
  return MCP_APPS_SURFACE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Validate a single origin in a CSP allowlist; returns the normalized origin (port kept), or null
 * when invalid.
 * - `https:` / `wss:`: any host.
 * - `http:` / `ws:`: only when the hostname is exactly `127.0.0.1` (loopback allowance for the
 *   openpencil H-B), so that a plugin's own local services (e.g. the WebSocket bridge inside the
 *   plugin's MCP server process) can be connected from sandboxed pages. Not `localhost` (can be
 *   rewritten via the hosts file), not `[::1]` (inconsistent with the 127.0.0.1 our MCP bridge
 *   binds to), and no other IPs.
 * - Credentials, query, hash, and path are never accepted.
 */
export function normalizeCspOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "127.0.0.1" && (url.protocol === "http:" || url.protocol === "ws:");
  if (url.protocol !== "https:" && url.protocol !== "wss:" && !loopback) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function readResourceUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)) return null;
  if (trimmed.length > MCP_APPS_RESOURCE_URI_MAX_CHARS) return null;
  return trimmed;
}

function readVisibility(value: unknown): McpAppsToolVisibility[] {
  if (!Array.isArray(value)) return [...MCP_APPS_DEFAULT_TOOL_VISIBILITY];
  const filtered = value.filter(
    (item): item is McpAppsToolVisibility => item === "model" || item === "app",
  );
  return filtered.length > 0 ? [...new Set(filtered)] : [...MCP_APPS_DEFAULT_TOOL_VISIBILITY];
}

function readDisplayMode(value: unknown): McpAppsDisplayMode | undefined {
  return value === "inline" || value === "fullscreen" || value === "pip" ? value : undefined;
}

/** The four domain kinds are read independently; `openai/widgetCSP` accepts both camelCase and snake_case. */
function readCsp(
  modern: Record<string, unknown> | null,
  legacy: Record<string, unknown> | null,
): McpToolUiCsp | undefined {
  const pick = (camel: string, snake: string) =>
    readOriginList(modern?.[camel]) ??
    readOriginList(legacy?.[camel]) ??
    readOriginList(legacy?.[snake]);
  const connect = pick("connectDomains", "connect_domains");
  const resource = pick("resourceDomains", "resource_domains");
  const frame = pick("frameDomains", "frame_domains");
  const baseUri = pick("baseUriDomains", "base_uri_domains");
  if (!connect && !resource && !frame && !baseUri) return undefined;
  const csp: McpToolUiCsp = {};
  if (connect) csp.connectDomains = connect;
  if (resource) csp.resourceDomains = resource;
  if (frame) csp.frameDomains = frame;
  if (baseUri) csp.baseUriDomains = baseUri;
  return csp;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function readOriginList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const origins = value.map(normalizeCspOrigin).filter((item): item is string => item !== null);
  return [...new Set(origins)];
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
