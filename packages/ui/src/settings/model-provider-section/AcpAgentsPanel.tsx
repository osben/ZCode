/**
 * ACP agents detection and the catalog detail shown from the "ACP agents"
 * navigation group. Detection has one owner: `useAcpAgentDetection`, called
 * once by ModelProviderSection; navigation and detail read its state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Spinner } from "@/components/ui/spinner.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ACP_AGENT_CATALOG, type AcpDetectionState } from "./acpAgentConfig.js";
import { ModelProviderLoadingCard } from "./StatusCards.js";

export interface AcpAgentDetection extends AcpDetectionState {
  readonly rescan: () => void;
}

/**
 * Owns the one detection scan of the settings page. The scan runs once per mount on every platform:
 * the host answers `supported` from the one availability predicate, and an unsupported host spawns
 * nothing. A rescan keeps the previous agents visible (`refreshing`), so mounted detail forms are not discarded.
 */
export function useAcpAgentDetection(): AcpAgentDetection {
  const { providerSettingsService } = useServices();
  const [state, setState] = useState<AcpDetectionState>({
    status: "loading",
    agents: [],
    supported: true,
    refreshing: false,
  });

  // Each request takes a sequence number; only the newest request may write
  // state, so an older response that arrives late cannot overwrite a rescan.
  const latestRequest = useRef(0);
  const load = useCallback(
    async (refresh: boolean) => {
      const request = ++latestRequest.current;
      setState((previous) => ({ ...previous, refreshing: true }));
      try {
        const result = await providerSettingsService.detectAcpAgents(
          refresh ? { refresh: true } : undefined,
        );
        if (request !== latestRequest.current) return;
        setState({
          status: "ready",
          agents: result.agents,
          supported: result.supported,
          refreshing: false,
        });
      } catch (error) {
        if (request !== latestRequest.current) return;
        logger.warn("[AcpAgentsPanel] ACP agent detection failed", error);
        setState((previous) => ({
          ...previous,
          // Keep agents from an earlier successful scan; only an empty result becomes an error.
          status: previous.agents.length === 0 ? "error" : "ready",
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

  const rescan = useCallback(() => {
    void load(true);
  }, [load]);
  // Stable identity per state change: the navigation group memo depends on this object.
  return useMemo(() => ({ ...state, rescan }), [state, rescan]);
}

/**
 * Catalog of supported agents, shown when no agent is installed (or detection
 * failed). Lists every known agent with its binary, install hint and docs link.
 */
export function AcpAgentCatalogDetail({
  detection,
  status,
}: {
  detection: AcpAgentDetection;
  status: "empty" | "error" | "loading";
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.modelProvider.acp.${id}` }, values);

  return (
    <div className="flex min-w-0 flex-col" data-acp-agent-catalog="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui-lg font-semibold text-foreground">{t("title")}</h2>
          <p className="mt-1 text-ui-sm text-foreground-subtle">{t("description")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={detection.refreshing}
          onClick={detection.rescan}
        >
          {detection.refreshing ? <Spinner className="me-1 size-3" /> : null}
          {t("rescan")}
        </Button>
      </div>

      <div className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border pt-4">
        {status === "loading" ? <ModelProviderLoadingCard loadingLabel={t("detecting")} /> : null}

        {status === "error" && detection.error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-destructive">
            <span>{t("scanFailed", { message: detection.error })}</span>
            <Button type="button" size="sm" variant="outline" onClick={detection.rescan}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          </div>
        ) : null}

        {status !== "loading" && !detection.supported ? (
          <p className="text-ui-sm text-foreground-subtle">{t("unsupported")}</p>
        ) : null}

        {status === "empty" && detection.supported ? (
          <p className="text-ui-sm text-foreground-subtle">{t("emptyDescription")}</p>
        ) : null}

        {status !== "loading" && detection.supported && detection.agents.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {detection.agents.map((agent) => {
              const catalog = ACP_AGENT_CATALOG[agent.agentId];
              return (
                <li
                  key={agent.agentId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                  data-acp-catalog-agent={agent.agentId}
                >
                  <span className="text-ui-base font-medium text-foreground">
                    {agent.displayName}
                  </span>
                  {agent.installed ? (
                    <Badge variant="secondary">{t("installed")}</Badge>
                  ) : (
                    <Badge variant="outline">{t("notInstalled")}</Badge>
                  )}
                  <span className="min-w-0 flex-1" />
                  {catalog && !agent.installed ? (
                    <span className="flex w-full min-w-0 flex-col gap-1 text-ui-sm text-foreground-subtle">
                      {t("installHint", { binary: catalog.binary })}
                      <code className="select-all overflow-x-auto rounded-md border border-border bg-background px-2 py-1 font-mono text-ui-sm text-foreground">
                        {catalog.installCommand}
                      </code>
                    </span>
                  ) : null}
                  {catalog ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => platform.openExternal(catalog.docsUrl)}
                    >
                      {t("docs")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <p className="mt-4 border-t border-border pt-4 text-ui-sm text-foreground-subtle">
        {t("chatPending")}
      </p>
    </div>
  );
}
