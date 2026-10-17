/**
 * "ACP agents" section for Model Settings: detects external ACP agent CLIs on
 * the host and lets the user enable/test each one. The section stays hidden
 * when no supported agent is installed.
 */
import { useCallback, useEffect, useState } from "react";
import type { AcpAgentSummary } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { AcpAgentCard } from "./AcpAgentCard.js";
import { acpProviderId, type AcpAgentFormValues, type AcpSavedAccess } from "./acpAgentConfig.js";

interface AcpDetectionState {
  readonly status: "loading" | "ready" | "error";
  readonly agents: readonly AcpAgentSummary[];
  readonly refreshing: boolean;
  readonly error?: string;
}

export interface AcpAgentsPanelProps {
  enabledProviderIds: ReadonlySet<string>;
  providerAccessByAgentId: ReadonlyMap<string, AcpSavedAccess>;
  conflictAgentIds: ReadonlySet<string>;
  onEnableAgent: (agent: AcpAgentSummary, form: AcpAgentFormValues) => Promise<void>;
  onUpdateAgent: (agent: AcpAgentSummary, form: AcpAgentFormValues) => Promise<void>;
  onDisableAgent: (agent: AcpAgentSummary) => Promise<void>;
}

export function AcpAgentsPanel({
  enabledProviderIds,
  providerAccessByAgentId,
  conflictAgentIds,
  onEnableAgent,
  onUpdateAgent,
  onDisableAgent,
}: AcpAgentsPanelProps) {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const [detection, setDetection] = useState<AcpDetectionState>({
    status: "loading",
    agents: [],
    refreshing: false,
  });

  const load = useCallback(
    async (refresh: boolean) => {
      // Keep the current cards mounted while a rescan runs: unmounting them
      // would discard unsaved command/args/env edits.
      setDetection((previous) => ({
        status: previous.agents.length === 0 ? "loading" : "ready",
        agents: previous.agents,
        refreshing: true,
      }));
      try {
        const result = await providerSettingsService.detectAcpAgents(
          refresh ? { refresh: true } : undefined,
        );
        const agents = result.supported ? result.agents.filter((agent) => agent.installed) : [];
        setDetection({ status: "ready", agents, refreshing: false });
      } catch (error) {
        logger.warn("[AcpAgentsPanel] ACP agent detection failed", error);
        setDetection((previous) => ({
          status: previous.agents.length === 0 ? "error" : "ready",
          agents: previous.agents,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [providerSettingsService],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Spec: without a detected agent the section stays hidden entirely.
  if (detection.status === "loading") return null;
  if (detection.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-ui-sm text-destructive">
        <span>
          {intl.formatMessage(
            { id: "settings.modelProvider.acp.scanFailed" },
            { message: detection.error ?? "" },
          )}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void load(true)}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }
  if (detection.agents.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card" data-acp-agents-panel="true">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.acp.title" })}
          </h3>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.acp.description" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.acp.chatPending" })}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={detection.refreshing}
          onClick={() => void load(true)}
        >
          {detection.refreshing ? <Spinner className="me-1 size-3" /> : null}
          {intl.formatMessage({ id: "settings.modelProvider.acp.rescan" })}
        </Button>
      </div>
      {/* A failed rescan keeps the previously detected cards visible; the
          error would otherwise be invisible in the "ready" branch. */}
      {detection.error ? (
        <p className="border-b border-border px-4 py-2 text-ui-sm text-destructive">
          {intl.formatMessage(
            { id: "settings.modelProvider.acp.scanFailed" },
            { message: detection.error },
          )}
        </p>
      ) : null}
      <div className="grid gap-3 p-4">
        {detection.agents.map((agent) => (
          <AcpAgentCard
            key={agent.agentId}
            agent={agent}
            enabled={enabledProviderIds.has(acpProviderId(agent.agentId))}
            conflict={conflictAgentIds.has(agent.agentId)}
            savedAccess={providerAccessByAgentId.get(agent.agentId)}
            onEnable={(form) => onEnableAgent(agent, form)}
            onUpdate={(form) => onUpdateAgent(agent, form)}
            onDisable={() => onDisableAgent(agent)}
          />
        ))}
      </div>
    </section>
  );
}
