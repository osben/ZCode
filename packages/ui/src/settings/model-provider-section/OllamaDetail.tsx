/**
 * The Ollama entry of Model Settings (specs/ollama-local-provider.md): probes the server on the workspace's host,
 * lists its models, and syncs the checked ones into the `ollama` personal provider through the existing provider
 * mutations. Model details (context window, name) are edited in that provider's own settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ServerIcon } from "lucide-react";
import { OLLAMA_DEFAULT_BASE_URL, type OllamaModelSummary } from "@zcode/services";
import type { ModelConfigObject, ProviderConfigObject } from "@zcode/provider";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useOllamaDetection } from "@/hooks/useOllamaDetection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { logger } from "@/logger.js";
import { DetailSection } from "./AcpAgentDetailSections.js";
import {
  OLLAMA_PROVIDER_ID,
  OLLAMA_PROVIDER_NAME,
  isOllamaModelSelectable,
  isOllamaSyncPlanEmpty,
  ollamaModelEligibility,
  ollamaProviderModelIds,
  ollamaRootFromProvider,
  planOllamaSync,
} from "./ollamaSync.js";

function formatContext(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

export function OllamaDetail({
  workspacePath,
  workspaceIdentity,
  provider,
  onCreateProvider,
  onAddModel,
  onDeleteModel,
  onOpenProvider,
}: {
  /** The active workspace: its host runs the detection probe (a remote workspace probes its own machine). */
  workspacePath: string;
  workspaceIdentity?: string;
  /** The `ollama` personal provider, or null before the first sync. */
  provider: ProviderSettingsFormProvider | null;
  onCreateProvider: (input: {
    providerId: string;
    providerName: string;
    initialConfig: ProviderConfigObject;
  }) => Promise<unknown>;
  onAddModel: (providerId: string, modelId: string, config: ModelConfigObject) => Promise<unknown>;
  onDeleteModel: (providerId: string, modelId: string) => Promise<unknown>;
  onOpenProvider: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: `settings.modelProvider.ollama.${id}` }, values),
    [intl],
  );
  const providerRoot = ollamaRootFromProvider(provider);
  const [address, setAddress] = useState(providerRoot ?? OLLAMA_DEFAULT_BASE_URL);
  const effectiveAddress = providerRoot ?? address;
  // The probe follows the workspace's host; the provider mutations above stay on the local Host.
  const detection = useOllamaDetection(workspacePath, workspaceIdentity);
  const detect = detection.detect;
  const [checked, setChecked] = useState<ReadonlySet<string> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Detection runs once when the detail opens (and again when the stored address changes); Rescan is explicit,
  // so typing in the address never probes per keystroke.
  const openedAddressRef = useRef(address);
  useEffect(() => {
    void detect(providerRoot ?? openedAddressRef.current);
  }, [detect, providerRoot]);

  const result = detection.result;
  const models: readonly OllamaModelSummary[] = result?.reachable ? result.models : [];
  const providerModelKey = ollamaProviderModelIds(provider).join("\n");
  // A fresh detection resets the checklist to the provider's models. A provider view commit must
  // not reset it: mid-sync that would drop the requested set, so a partial failure leaves no plan
  // (OL8); a completed sync re-derives the checklist below instead.
  useEffect(() => {
    setChecked(null);
  }, [result]);
  const checkedSet = useMemo(
    () => checked ?? new Set(providerModelKey ? providerModelKey.split("\n") : []),
    [checked, providerModelKey],
  );
  const root = result?.reachable ? result.baseUrl : effectiveAddress;
  const plan = planOllamaSync({ provider, root, detected: models, checked: checkedSet });
  const canSave = result?.reachable === true && !isOllamaSyncPlanEmpty(plan) && !syncing;

  const toggle = (name: string, next: boolean) => {
    const updated = new Set(checkedSet);
    if (next) updated.add(name);
    else updated.delete(name);
    setChecked(updated);
  };

  const save = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      // One write at a time, in plan order; a failure leaves a plan that a second Save finishes.
      if (plan.create) {
        await onCreateProvider({
          providerId: OLLAMA_PROVIDER_ID,
          providerName: OLLAMA_PROVIDER_NAME,
          initialConfig: plan.create,
        });
      }
      for (const step of plan.add) await onAddModel(OLLAMA_PROVIDER_ID, step.modelId, step.config);
      for (const modelId of plan.remove) await onDeleteModel(OLLAMA_PROVIDER_ID, modelId);
      // Completed: the provider now holds the requested set; re-derive the checklist from it.
      setChecked(null);
    } catch (error) {
      logger.warn("[OllamaDetail] sync failed", error);
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  };

  const status = (() => {
    if (detection.loading && !result) return <Spinner className="size-3" />;
    if (!result) return null;
    if (result.reachable) {
      return (
        <span data-testid="ollama-status" data-reachable="true">
          {t("connected", { version: result.version || "?", count: result.models.length })}
        </span>
      );
    }
    return (
      <span role="alert" className="text-destructive" data-testid="ollama-status">
        {t("unreachable", { reason: result.error })}
      </span>
    );
  })();

  return (
    <div className="flex min-w-0 flex-col" data-testid="ollama-detail">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
            <ServerIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-ui-lg font-semibold text-foreground">Ollama</div>
            <div className="text-ui-sm text-foreground-subtle">{t("subtitle")}</div>
          </div>
        </div>
        {provider ? (
          <Button type="button" size="sm" variant="outline" onClick={onOpenProvider}>
            {t("openProvider")}
          </Button>
        ) : null}
      </div>

      <DetailSection title={t("sectionServer")}>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="ollama-address"
              className="mb-1 block text-ui-base text-foreground-subtle"
            >
              {t("address")}
            </label>
            <Input
              id="ollama-address"
              size="lg"
              value={effectiveAddress}
              readOnly={providerRoot !== null}
              spellCheck={false}
              onChange={(event) => {
                // Any edit invalidates the previous result and drops an in-flight probe: Save must
                // require a detection of the address that is currently shown (OL10).
                detection.reset();
                setAddress(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void detect(effectiveAddress);
              }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="ollama-detect-button"
            disabled={detection.loading}
            onClick={() => void detect(effectiveAddress)}
          >
            {detection.loading ? <Spinner className="me-1 size-3" /> : null}
            {result ? t("rescan") : t("detect")}
          </Button>
        </div>
        {providerRoot !== null ? (
          <p className="text-ui-sm text-foreground-subtle">{t("addressFromProvider")}</p>
        ) : null}
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
          {status}
        </p>
        {result && !result.reachable ? (
          <p className="text-ui-sm text-foreground-subtle">{t("unreachableHint")}</p>
        ) : null}
      </DetailSection>

      {result?.reachable ? (
        <DetailSection
          title={t("sectionModels")}
          action={
            <Button
              type="button"
              size="sm"
              data-testid="ollama-save-button"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {syncing ? <Spinner className="me-1 size-3" /> : null}
              {provider ? t("updateModels") : t("addToZCode")}
            </Button>
          }
        >
          {models.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">{t("noModels")}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1" data-testid="ollama-models">
              {models.map((model) => {
                const eligibility = ollamaModelEligibility(model);
                const selectable = isOllamaModelSelectable(model);
                const id = `ollama-model-${model.name}`;
                const details = [
                  model.parameterSize,
                  model.contextLength
                    ? t("context", { size: formatContext(model.contextLength) })
                    : null,
                  eligibility === "ok" ? null : t(`eligibility.${eligibility}`),
                ].filter(Boolean);
                return (
                  <label
                    key={model.name}
                    htmlFor={id}
                    className={`flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-ui-base ${selectable ? "cursor-pointer hover:bg-hover" : "cursor-not-allowed opacity-60"}`}
                  >
                    <Checkbox
                      id={id}
                      data-testid="ollama-model-checkbox"
                      data-model-name={model.name}
                      checked={selectable && checkedSet.has(model.name)}
                      disabled={!selectable || syncing}
                      onCheckedChange={(next) => toggle(model.name, next === true)}
                    />
                    <span className="min-w-0 truncate">{model.name}</span>
                    {details.length > 0 ? (
                      <span className="shrink-0 text-ui-sm text-foreground-subtle">
                        {details.join(" · ")}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
          <p className="text-ui-sm text-foreground-subtle">{t("contextHint")}</p>
          {syncError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {t("syncFailed", { message: syncError })}
            </p>
          ) : null}
        </DetailSection>
      ) : null}
    </div>
  );
}
