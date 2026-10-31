/**
 * ACP agents detection and the catalog detail shown from the "ACP agents"
 * navigation group. Detection has one owner: `useAcpAgentDetection`, called
 * once by ModelProviderSection on the workspace host; navigation and detail read its state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IProviderSettingsService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Spinner } from "@/components/ui/spinner.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { ACP_AGENT_CATALOG, type AcpDetectionState } from "./acpAgentConfig.js";
import { AcpAgentMark } from "./AcpAgentMark.js";
import { AcpRemoteHostNote } from "./AcpAgentDetailSections.js";
import { ModelProviderLoadingCard } from "./StatusCards.js";

export interface AcpAgentDetection extends AcpDetectionState {
  readonly rescan: () => void;
}

const INITIAL_DETECTION: AcpDetectionState = {
  status: "loading",
  agents: [],
  supported: true,
  refreshing: false,
};

// Without a remote attachment no call is sent; the group says the host is not connected
// (specs/acp-agent-runtime.md "Settings: workspace host").
const NOT_ATTACHED_DETECTION: AcpDetectionState = {
  status: "error",
  agents: [],
  supported: true,
  refreshing: false,
  disconnected: true,
  awaitingHost: true,
};

interface OwnedDetectionState {
  readonly service: IProviderSettingsService;
  readonly state: AcpDetectionState;
}

/**
 * Owns the one detection scan of the settings page, on the workspace host's service (`useAcpSettingsHost`).
 * The scan runs once per mount and once per host on every platform: the host answers `supported` from the one
 * availability predicate, and an unsupported host spawns nothing. A rescan keeps the previous agents visible
 * (`refreshing`), so mounted detail forms are not discarded; a new host starts from loading, never with the
 * previous host's agents.
 */
export function useAcpAgentDetection(
  providerSettingsService: IProviderSettingsService,
  rpcReady: boolean,
): AcpAgentDetection {
  const [owned, setOwned] = useState<OwnedDetectionState>(() => ({
    service: providerSettingsService,
    state: INITIAL_DETECTION,
  }));
  const ownedState = owned.service === providerSettingsService ? owned.state : INITIAL_DETECTION;
  const state = rpcReady ? ownedState : NOT_ATTACHED_DETECTION;

  // Each request takes a sequence number; only the newest request may write
  // state, so an older response that arrives late cannot overwrite a rescan
  // or a scan of the next host.
  const latestRequest = useRef(0);
  const load = useCallback(
    async (refresh: boolean) => {
      const request = ++latestRequest.current;
      const update = (next: (previous: AcpDetectionState) => AcpDetectionState) =>
        setOwned((current) => ({
          service: providerSettingsService,
          state: next(
            current.service === providerSettingsService ? current.state : INITIAL_DETECTION,
          ),
        }));
      update((previous) => ({ ...previous, refreshing: true }));
      try {
        const result = await providerSettingsService.detectAcpAgents(
          refresh ? { refresh: true } : undefined,
        );
        if (request !== latestRequest.current) return;
        update(() => ({
          status: "ready",
          agents: result.agents,
          supported: result.supported,
          refreshing: false,
        }));
      } catch (error) {
        if (request !== latestRequest.current) return;
        logger.warn("[AcpAgentsPanel] ACP agent detection failed", error);
        update((previous) => ({
          ...previous,
          // Keep agents from an earlier successful scan; only an empty result becomes an error.
          status: previous.agents.length === 0 ? "error" : "ready",
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
          disconnected: isRemoteWorkspaceDisconnectedError(error),
        }));
      }
    },
    [providerSettingsService],
  );

  useEffect(() => {
    // A host change (or losing the attachment) invalidates every in-flight scan of the previous host.
    latestRequest.current += 1;
    if (rpcReady) void load(false);
  }, [load, rpcReady]);

  const rescan = useCallback(() => {
    if (rpcReady) void load(true);
  }, [load, rpcReady]);
  // Stable identity per state change: the navigation group memo depends on this object.
  return useMemo(() => ({ ...state, rescan }), [state, rescan]);
}

/** The scan error as shown to the user; a missing remote host is never shown as its raw code. */
export function formatAcpScanError(
  detection: Pick<AcpDetectionState, "error" | "disconnected">,
  formatMessage: (id: string) => string,
): string | undefined {
  if (detection.disconnected) return formatMessage("settings.modelProvider.acp.remoteDisconnected");
  return detection.error;
}

/**
 * Catalog of supported agents, shown when no agent is installed (or detection
 * failed). Lists every known agent with its binary, install hint and docs link.
 */
export function AcpAgentCatalogDetail({
  detection,
  status,
  remoteHost = false,
}: {
  detection: AcpAgentDetection;
  status: "empty" | "error" | "loading";
  /** The workspace host is remote: the agents listed are that host's. */
  remoteHost?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.modelProvider.acp.${id}` }, values);
  const scanError = formatAcpScanError(detection, (id) => intl.formatMessage({ id }));

  return (
    <div className="flex min-w-0 flex-col" data-acp-agent-catalog="true">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui-lg font-semibold text-foreground">{t("title")}</h2>
          <p className="mt-1 text-ui-sm text-foreground-subtle">{t("description")}</p>
          {remoteHost ? <AcpRemoteHostNote className="mt-1" text={t("remoteHostNote")} /> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={detection.refreshing || detection.awaitingHost === true}
          onClick={detection.rescan}
        >
          {detection.refreshing ? <Spinner className="me-1 size-3" /> : null}
          {t("rescan")}
        </Button>
      </div>

      <div className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border pt-4">
        {status === "loading" ? <ModelProviderLoadingCard loadingLabel={t("detecting")} /> : null}

        {status === "error" && scanError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-destructive"
          >
            {/* The not-connected message stands alone; it is not a scan failure. */}
            <span>
              {detection.disconnected ? scanError : t("scanFailed", { message: scanError })}
            </span>
            {detection.awaitingHost ? null : (
              <Button type="button" size="sm" variant="outline" onClick={detection.rescan}>
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            )}
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
                  <AcpAgentMark agentId={agent.agentId} name={agent.displayName} />
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
