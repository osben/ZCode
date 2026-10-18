// ============================================================
// Runtime LSP wiring: availability, tool visibility, and post-edit diagnostics (spec §6, §7)
// ============================================================

import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

/** Serializes preference applications per runtime so an older availability result cannot win. */
const lspPreferenceQueues = new WeakMap<AgentRuntimeInternal, Promise<void>>();

/**
 * Re-evaluates code-intelligence availability and refreshes the tool set. Called once at runtime
 * construction and by bootstrap when LSP preferences change. Disabling stops every server.
 */
export function applyLspPreferences(this: AgentRuntimeInternal): Promise<void> {
  const previous = lspPreferenceQueues.get(this) ?? Promise.resolve();
  const next = previous.then(() => applyLspPreferencesNow.call(this));
  lspPreferenceQueues.set(this, next);
  return next;
}

async function applyLspPreferencesNow(this: AgentRuntimeInternal): Promise<void> {
  const service = this.lspService;
  if (!service) return;
  try {
    await service.shutdownIfDisabled();
    const available = await service.isAvailable();
    if (available === this.lspToolAvailable) return;
    this.lspToolAvailable = available;
    if (!available) this.registry.unregister("LSP");
    refreshBranchAwareBuiltInTools(this);
  } catch (error) {
    this.logger?.warn("LSP preference refresh failed", {
      ...traceContextToLogContext(this.rootTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "core.lsp.preference_refresh_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
    });
  }
}

/**
 * Post-edit diagnostics body for the next model request, or undefined. Returns at once when no
 * file was mutated since the previous request; otherwise waits as bounded by the LSP service.
 */
export async function collectLspEditDiagnosticsBody(
  this: AgentRuntimeInternal,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  const service = this.lspService;
  if (!service) return undefined;
  const result = await service.collectEditDiagnostics({ signal: abortSignal });
  return result.attachmentBody;
}
