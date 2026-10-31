import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  MCP_APPS_NESTED_FRAMES_EXPERIMENTAL_KEY,
  MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY,
  MCP_APPS_SURFACE_EXPERIMENTAL_KEY,
  MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY,
  buildMcpAppsCspExperimentalCapability,
} from "@zcode/shared/mcp-apps";

/** Interactions actually available to the host instance; capabilities for absent items are not declared, so plugins degrade accordingly. */
export interface PluginUiHostCapabilityInput {
  canSample?: boolean;
  canSendFollowUpMessage: boolean;
  canUpdateModelContext: boolean;
  canSetWidgetState: boolean;
  /** The host can proxy resources/subscribe and route server notifications back to this instance. */
  canSubscribeResources: boolean;
  /** downloadFile is declared only when the platform has saveFile (desktop). */
  canDownloadFile: boolean;
  /** Persistent surface instance: declares `experimental["zcode/surface"]: { id }` so the page can tell it is running in a pane. */
  surfaceId?: string;
  /** Window restore key; only host-derived opaque digests are accepted. */
  surfaceStateKey?: string;
}

/**
 * The single construction point of hostCapabilities. Declarations map one-to-one to handlers: no session-action
 * binding means no message declaration, no composer means no updateModelContext. ZCode extensions (widgetState,
 * resourceSubscribe, surface, csp relaxations, nestedFrames) always go under `experimental["zcode/…"]` —
 * the official SDK's zod strips unknown capability keys beyond the standard slots.
 */
export function buildPluginUiHostCapabilities(
  input: PluginUiHostCapabilityInput,
): McpUiHostCapabilities {
  return {
    openLinks: {},
    serverTools: {},
    serverResources: input.canSubscribeResources ? { listChanged: true } : {},
    logging: {},
    ...(input.canSample ? { sampling: {} } : {}),
    ...(input.canDownloadFile ? { downloadFile: {} } : {}),
    // image is declared alongside text (png / jpeg / webp, single image ≤ 4 MiB).
    ...(input.canSendFollowUpMessage ? { message: { text: {}, image: {} } } : {}),
    ...(input.canUpdateModelContext
      ? { updateModelContext: { text: {}, structuredContent: {}, image: {} } }
      : {}),
    experimental: {
      ...buildMcpAppsCspExperimentalCapability(),
      [MCP_APPS_NESTED_FRAMES_EXPERIMENTAL_KEY]: {},
      ...(input.canSetWidgetState ? { [MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY]: {} } : {}),
      ...(input.canSubscribeResources
        ? { [MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY]: {} }
        : {}),
      ...(input.surfaceId
        ? {
            [MCP_APPS_SURFACE_EXPERIMENTAL_KEY]: {
              id: input.surfaceId,
              stateKey: input.surfaceStateKey,
            },
          }
        : {}),
    },
  };
}
