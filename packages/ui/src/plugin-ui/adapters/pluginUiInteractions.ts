import { getPluginUiSessionActions } from "@/plugin-ui/adapters/pluginUiSessionActions.js";
import type { PluginUiHostControllerDeps } from "@/plugin-ui/app/pluginUiHostController.js";
import type { PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId, concatMcpAppsTextContent } from "@zcode/shared/mcp-apps";
import { requestPluginUiFollowUpConfirmation } from "../app/pluginUiFollowUpDialogStore.js";
import {
  PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES,
  buildPluginUiFollowUpPrompt,
} from "../domain/pluginUiFollowUp.js";
import { readPluginUiImageBlocks } from "../domain/pluginUiImageBlocks.js";
import { dispatchPluginUiModelContextAdd } from "./pluginUiModelContextEvents.js";

import { type PluginUiSessionScope } from "@/plugin-ui/contract.js";

export interface PluginUiInteractionScope extends PluginUiSessionScope {
  sessionId: string;
  pluginId: string;
  /** Tool card or pane; determines the widgetState surfaceKey and the source marker / context id. */
  scope: PluginUiScopeRef;
}

const JSON_RPC_UNAVAILABLE = -32601;
const JSON_RPC_CANCELLED = -32000;

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** H11-b / S3: image block validation failure → -32602 unsupported_content, with the reason so the page can debug. */
function readImagesOrThrow(content: readonly Record<string, unknown>[] | undefined) {
  const images = readPluginUiImageBlocks(content);
  if (images.ok) return images.images;
  const detail =
    images.reason === "too_large"
      ? `image exceeds 4 MiB (${images.bytes} bytes)`
      : images.reason === "unsupported_mime"
        ? `unsupported image mimeType ${images.mimeType ?? "(missing)"}; use png / jpeg / webp`
        : "image block must carry base64 data and mimeType";
  throw rpcError(-32602, `unsupported_content: ${detail}`);
}

/** Scope id inside source / context markers: tool cards reuse the bare toolCallId (compat), panes use `surface:<id>`. */
function scopeMarker(scope: PluginUiScopeRef): string {
  return scope.kind === "toolCall" ? scope.toolCallId : buildPluginSandboxScopeId(scope);
}

/**
 * Second and third batches of host callbacks:
 * - sendFollowUpMessage: with a user gesture, send directly as the user; without one, show an editable
 *   confirmation dialog; cancelling replies -32000.
 *   structuredContent is appended to the text as a ```json block; the source goes only into metadata `source`.
 * - updateModelContext: delivers plugin context blocks to the current session's composer; with no composer
 *   to receive them, replies -32601.
 * widgetState is written exclusively by the window page manager.
 */
export function createPluginUiInteractions(
  input: PluginUiInteractionScope,
): Pick<PluginUiHostControllerDeps, "onSendFollowUpMessage" | "onUpdateModelContext"> {
  const marker = scopeMarker(input.scope);
  const source = { kind: "pluginUi" as const, pluginId: input.pluginId, toolCallId: marker };
  return {
    async onSendFollowUpMessage(payload, context) {
      const actions = getPluginUiSessionActions(input);
      if (!actions)
        throw rpcError(JSON_RPC_UNAVAILABLE, "Follow-up messages are not available here");
      // H11-a: structuredContent is folded into the prompt (```json block); what the user sees and edits in the confirmation dialog is exactly what gets sent.
      const built = buildPluginUiFollowUpPrompt(payload.prompt, payload.structuredContent);
      if (!built.ok) {
        throw rpcError(
          -32602,
          built.reason === "empty_prompt"
            ? "prompt must not be empty"
            : `structuredContent exceeds ${PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES} bytes (${built.bytes})`,
        );
      }
      let prompt = built.prompt;
      const images = readImagesOrThrow(payload.content);
      const gesture = await context.consumeUserGesture();
      if (!gesture) {
        const confirmed = await requestPluginUiFollowUpConfirmation({
          pluginId: input.pluginId,
          prompt,
        });
        if (confirmed === null || !confirmed.trim()) {
          throw rpcError(JSON_RPC_CANCELLED, "User cancelled the follow-up message");
        }
        prompt = confirmed.trim();
      }
      // Fix: the session may have been switched or closed while the confirmation dialog was pending; the captured stale command entry must not be used.
      if (getPluginUiSessionActions(input) !== actions)
        throw rpcError(JSON_RPC_UNAVAILABLE, "Session binding is no longer available");
      context.assertCurrent();
      await actions.sendFollowUp({ prompt, source, ...(images.length > 0 ? { images } : {}) });
    },
    async onUpdateModelContext(payload) {
      const text = concatMcpAppsTextContent(payload.content);
      const images = readImagesOrThrow(payload.content);
      const delivered = dispatchPluginUiModelContextAdd(input, {
        id: `plugin-ui-context:${input.pluginId}:${marker}`,
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        toolCallId: marker,
        text,
        ...(payload.structuredContent !== undefined
          ? { structuredContent: payload.structuredContent }
          : {}),
        ...(images.length > 0 ? { images } : {}),
      });
      if (!delivered)
        throw rpcError(JSON_RPC_UNAVAILABLE, "No composer is listening for model context");
    },
  };
}
