/**
 * Sections of the ACP agent detail pane (specs/acp-agent-runtime.md "Settings: models and Advanced"): the shared
 * section frame, the collapsed Advanced disclosure, and the Models checklist that chooses which of the agent's
 * models the composer's agent Model select offers.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import type { AcpAgentCatalogHandle } from "@/hooks/useAcpAgentCatalog.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  EXTERNAL_AGENT_CONFIG_SEARCH_THRESHOLD,
  filterExternalAgentConfigValues,
  selectExternalAgentComposerOptions,
} from "@/v4/composer/externalAgentConfig.js";
import { groupAcpModelValues, toggleAcpHiddenModel } from "./acpAgentConfig.js";

/** Same rhythm as the Model settings detail: a separator, then a text-ui-base section title. */
export function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border pt-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Collapsed on open. The content stays mounted while collapsed so the launch form draft survives toggling; it is
 * removed from keyboard and screen-reader navigation instead. `forceExpanded` opens it (an invalid env line).
 */
export function AcpAgentAdvanced({
  label,
  forceExpanded,
  children,
}: {
  label: string;
  forceExpanded: boolean;
  children: ReactNode;
}) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);
  return (
    <section className="mt-4 border-t border-border pt-3" data-acp-agent-advanced="true">
      <button
        type="button"
        data-testid="acp-agent-advanced-trigger"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="-mx-2 flex w-fit cursor-pointer items-center gap-2 rounded-sm bg-transparent px-2 py-1 text-ui-base font-medium text-foreground hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronRightIcon
          className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        {label}
      </button>
      <div
        id={contentId}
        inert={!expanded}
        aria-hidden={!expanded}
        className={`grid transition-[grid-template-rows,opacity,visibility] duration-200 motion-reduce:transition-none ${expanded ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-col gap-4 pt-3 pb-1">{children}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * The agent's model values as checkboxes. The host stores the hidden set; this pane is its only writer and
 * serializes writes (one in flight, the latest set wins). A failed write reverts to the last stored set.
 */
export function AcpAgentModelsList({
  agentId,
  catalog,
  t,
}: {
  agentId: string;
  catalog: AcpAgentCatalogHandle;
  t: (id: string, values?: Record<string, string | number>) => string;
}) {
  const { providerSettingsService } = useServices();
  const model = useMemo(
    () => (catalog.options ? selectExternalAgentComposerOptions(catalog.options).model : undefined),
    [catalog.options],
  );
  const storedHidden = catalog.hiddenModels;
  const [hidden, setHidden] = useState<readonly string[]>(() => storedHidden ?? []);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Write queue state: the set the host last confirmed, the latest wanted set, and whether a write is running.
  const confirmedRef = useRef<readonly string[]>(storedHidden ?? []);
  const wantedRef = useRef<readonly string[] | null>(null);
  const writingRef = useRef(false);

  // A catalog read (mount or reload) is the stored fact; it replaces the shown set unless a write is queued.
  useEffect(() => {
    confirmedRef.current = storedHidden ?? [];
    if (!writingRef.current) setHidden(storedHidden ?? []);
  }, [storedHidden]);

  const flush = useCallback(async () => {
    if (writingRef.current) return;
    writingRef.current = true;
    try {
      while (wantedRef.current !== null) {
        const next = wantedRef.current;
        wantedRef.current = null;
        try {
          await providerSettingsService.setAcpAgentHiddenModels({
            agentId,
            hiddenModels: next,
          });
          confirmedRef.current = next;
        } catch (error) {
          logger.warn("[AcpAgentCard] hidden models write failed", error);
          wantedRef.current = null;
          setHidden(confirmedRef.current);
          setWriteError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
    } finally {
      writingRef.current = false;
    }
  }, [agentId, providerSettingsService]);

  if (!model) {
    // A catalog without a model select is a fact about the agent; only a missing catalog needs a Test.
    return (
      <p className="text-ui-sm text-foreground-subtle" data-testid="acp-agent-models-empty">
        {t(catalog.options ? "modelsNotOffered" : "modelsEmpty")}
      </p>
    );
  }

  const offered = model.options.map((value) => value.value);
  const visibleCount = offered.filter((value) => !hidden.includes(value)).length;
  const values =
    model.options.length > EXTERNAL_AGENT_CONFIG_SEARCH_THRESHOLD
      ? filterExternalAgentConfigValues(model.options, query)
      : model.options;
  const toggle = (value: string, visible: boolean) => {
    const next = toggleAcpHiddenModel(hidden, offered, value, visible);
    setHidden(next);
    setWriteError(null);
    wantedRef.current = next;
    void flush();
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="acp-agent-models">
      <p className="text-ui-sm text-foreground-subtle">
        {t("modelsHint", { visible: visibleCount, total: offered.length })}
      </p>
      {model.options.length > EXTERNAL_AGENT_CONFIG_SEARCH_THRESHOLD ? (
        <Input
          size="lg"
          value={query}
          spellCheck={false}
          placeholder={t("modelsSearch")}
          aria-label={t("modelsSearch")}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <div className="flex max-h-72 min-w-0 flex-col gap-3 overflow-y-auto">
        {groupAcpModelValues(values).map(({ group, values: groupValues }) => (
          <div key={group ?? ""} className="flex min-w-0 flex-col gap-1">
            {group ? (
              <div className="text-ui-sm font-medium text-foreground-subtle">{group}</div>
            ) : null}
            {groupValues.map((value) => {
              const visible = !hidden.includes(value.value);
              const id = `acp-model-${agentId}-${value.value}`;
              return (
                <label
                  key={value.value}
                  htmlFor={id}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-ui-base hover:bg-hover"
                >
                  <Checkbox
                    id={id}
                    data-testid="acp-agent-model-checkbox"
                    data-model-value={value.value}
                    checked={visible}
                    disabled={visible && visibleCount <= 1}
                    onCheckedChange={(next) => toggle(value.value, next === true)}
                  />
                  <span className="min-w-0 truncate" title={value.description ?? value.name}>
                    {value.name}
                  </span>
                  {value.value === model.currentValue ? (
                    <span className="shrink-0 text-ui-sm text-foreground-subtle">
                      {t("modelsCurrent")}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        ))}
      </div>
      {writeError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t("modelsSaveFailed", { message: writeError })}
        </p>
      ) : null}
    </div>
  );
}
