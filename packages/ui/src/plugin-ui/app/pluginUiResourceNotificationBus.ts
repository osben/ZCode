import type { McpAppInstance } from "@zcode/shared/mcp-apps";
import type { PluginUiInstanceDelta } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiResourceNotificationTarget } from "../contract.js";
import { buildPluginUiSessionKey } from "../contract.js";
import type { PluginUiHostControllerDeps, PluginUiHostScope } from "./pluginUiHostController.js";

/**
 * Routing table for server resource notifications (renderer memory).
 * Key = (session key, plugin, sandbox scope, instance generation); the subscribers in projection deltas
 * carry full run credentials, while session and plugin are filled in by the feeder (that session's
 * projection store). Unregistered subscribers are dropped outright — the instance was destroyed or replaced.
 */
const targets = new Map<string, PluginUiResourceNotificationTarget>();

function buildKey(
  sessionKey: string,
  pluginId: string,
  scopeId: string,
  generation: number,
  instance: McpAppInstance,
) {
  return JSON.stringify([
    sessionKey,
    pluginId,
    scopeId,
    generation,
    instance.runtimeId,
    instance.appIdentity,
    instance.token,
  ]);
}

export function registerPluginUiResourceTarget(
  sessionKey: string,
  pluginId: string,
  scopeId: string,
  generation: number,
  target: PluginUiResourceNotificationTarget,
  instance: McpAppInstance,
): () => void {
  const key = buildKey(sessionKey, pluginId, scopeId, generation, instance);
  targets.set(key, target);
  return () => {
    if (targets.get(key) === target) targets.delete(key);
  };
}

/** Returns the number of instances actually delivered to (for unit tests and logs). */
export function dispatchPluginUiResourceDelta(
  sessionKey: string,
  delta: PluginUiInstanceDelta,
): number {
  let delivered = 0;
  for (const subscriber of delta.subscribers) {
    const target = targets.get(
      buildKey(
        sessionKey,
        delta.serverName,
        subscriber.scopeId,
        subscriber.generation,
        subscriber.instance,
      ),
    );
    if (!target) continue;
    delivered += 1;
    if (delta.op === "pluginUi.instanceClosed") target.notifyInstanceClosed?.();
    else if (delta.op === "pluginUi.resourceUpdated") target.notifyResourceUpdated(delta.uri);
    else if (delta.op === "pluginUi.appToolCall") {
      target.notifyAppToolCall({
        activity: delta.activity,
        cancelled: delta.cancelled,
        callId: delta.callId,
        toolName: delta.toolName,
        arguments: delta.arguments,
      });
    } else target.notifyResourceListChanged();
  }
  return delivered;
}

/** Registration entry for the controller: instance identity (session / plugin / scope) is fixed, the generation is supplied by the controller when the port arrives. */
export function createPluginUiResourceNotificationRegistrar(
  scope: PluginUiHostScope,
  pluginId: string,
): NonNullable<PluginUiHostControllerDeps["resourceNotifications"]> {
  const sessionKey = buildPluginUiSessionKey(scope);
  return {
    register: (generation, target, instance) =>
      registerPluginUiResourceTarget(
        sessionKey,
        pluginId,
        instance.token,
        generation,
        target,
        instance,
      ),
  };
}

export function resetPluginUiResourceTargetsForTest(): void {
  targets.clear();
}
