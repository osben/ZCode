import { Cpu } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  getModelProviderFamilySpec,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const LIST_MODELS_TOOL_ICON = <Cpu className="size-4 shrink-0 text-foreground-subtle" />;

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** providerId → provider name in the session model catalog; absent when not found (see useWorkflowSubagentModelProviderName). */
type ProviderNameLookup = ((providerId: string) => string | undefined) | undefined;

interface ListModelsEntryView {
  id: string;
  providerId: string;
  modelId: string;
  providerLabel: string | undefined;
  reasoningLevels: string[];
  defaultReasoningLevel: string | undefined;
  contextWindow: number | undefined;
  disabledReason: string | undefined;
}

interface ListModelsResult {
  current: string | undefined;
  models: ListModelsEntryView[];
  truncated: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseJsonCandidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function readResultRecord(value: unknown): ListModelsResult | null {
  const normalized = parseJsonCandidate(value);
  if (!isPlainRecord(normalized) || !Array.isArray(normalized.models)) {
    return null;
  }

  const models: ListModelsEntryView[] = [];
  for (const entry of normalized.models) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const id = readTrimmedString(entry.id);
    const providerId = readTrimmedString(entry.providerId);
    const modelId = readTrimmedString(entry.modelId);
    if (id === undefined || providerId === undefined || modelId === undefined) {
      continue;
    }
    models.push({
      id,
      providerId,
      modelId,
      providerLabel: readTrimmedString(entry.providerLabel),
      reasoningLevels: readStringArray(entry.reasoningLevels),
      defaultReasoningLevel: readTrimmedString(entry.defaultReasoningLevel),
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
      disabledReason: readTrimmedString(entry.disabledReason),
    });
  }

  return {
    current: readTrimmedString(normalized.current),
    models,
    truncated: normalized.truncated === true,
  };
}

/**
 * Read results in the same order as list-saved-workflows: **prefer the display channel** (`list_models` kind—
 * on the v4 wire, output.text is the `<models>` projection from formatModelContent, so the JSON probe below never
 * matches it, which is why it falls through to the raw fallback card today); the legacy JSON probe supports old sessions and non-v4 hosts. If neither can be read,
 * return null—"this machine has no models" and "this result could not be read" must remain distinguishable.
 */
export function readListModelsResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ListModelsResult | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "list_models") {
    return {
      current: display.current,
      models: display.models.map((model) => ({
        id: model.id,
        providerId: model.providerId,
        modelId: model.modelId,
        providerLabel: model.providerLabel,
        reasoningLevels: [...model.reasoningLevels],
        defaultReasoningLevel: model.defaultReasoningLevel,
        contextWindow: model.contextWindow,
        disabledReason: model.disabledReason,
      })),
      truncated: display.truncated === true,
    };
  }

  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  for (const candidate of [toolCall.output, raw?.rawOutput, raw?.output, raw?.result]) {
    const result = readResultRecord(candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * Group name = provider **name**, following the model-menu rule (same convention as subagent-model-label.ts):
 * use the built-in family name; otherwise providerLabel from the payload; otherwise the name from the session model catalog; if none exists,
 * use the generic term "model provider." **Never fall back to providerId**—for team plans it is a UUID, so showing it would make users skip 36 characters before reaching the model name.
 */
function listModelsGroupName(
  providerId: string,
  providerLabel: string | undefined,
  providerName: ProviderNameLookup,
  formatMessage: FormatMessage,
): string {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  if (familyId !== null) {
    return getModelProviderFamilySpec(familyId).label;
  }
  const label = providerLabel?.trim();
  if (label !== undefined && label.length > 0 && label !== providerId) {
    return label;
  }
  // If the session catalog has no match, zcodeSessionSettingsToConfigOptions falls back to providerId itself; treat that as not found.
  const resolved = providerName?.(providerId)?.trim();
  if (resolved !== undefined && resolved.length > 0 && resolved !== providerId) {
    return resolved;
  }
  return formatMessage({ id: "chat.toolCall.workflow.models.provider" });
}

/**
 * Context-window formatting: preserve values below one thousand; round to K below one million; above that, show M and retain one decimal only when needed
 * (`1M` / `1.5M`). This column is for quickly comparing sizes, not verifying exact token counts.
 */
export function formatContextWindow(contextWindow: number): string {
  if (contextWindow < 1_000) {
    return String(contextWindow);
  }
  if (contextWindow < 1_000_000) {
    return `${Math.round(contextWindow / 1_000)}K`;
  }
  const millions = contextWindow / 1_000_000;
  return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
}

function levelWord(level: string, formatMessage: FormatMessage): string {
  // Use the same table of tier labels as the reasoning control; display values not in the table as-is (provider-defined tier names).
  const labelId = thoughtLevelLabelId(level);
  return labelId === undefined ? level : formatMessage({ id: labelId });
}

/**
 * Row tooltip: first line is reasoning tier (or that there is no tier), followed by the canonical id on a new line.
 * The canonical id is used to populate `subagent_model` programmatically and belongs only here (same separation as in subagent-model-label.ts).
 */
function listModelsRowTooltip(model: ListModelsEntryView, formatMessage: FormatMessage): string {
  let levelsLine: string;
  if (model.reasoningLevels.length === 0) {
    levelsLine = formatMessage({ id: "chat.toolCall.workflow.models.noLevels" });
  } else {
    const levels = model.reasoningLevels
      .map((level) => levelWord(level, formatMessage))
      .join(" · ");
    levelsLine =
      model.defaultReasoningLevel === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.models.levelsNoDefault" }, { levels })
        : formatMessage(
            { id: "chat.toolCall.workflow.models.levels" },
            { default: levelWord(model.defaultReasoningLevel, formatMessage), levels },
          );
  }
  return `${levelsLine}\n${model.id}`;
}

interface ListModelsGroup {
  providerId: string;
  models: ListModelsEntryView[];
}

/** Groups by providerId while preserving first-seen order—the catalog follows the host registry order, and the card does not reorder it. */
function groupModelsByProvider(models: ListModelsEntryView[]): ListModelsGroup[] {
  const groups: ListModelsGroup[] = [];
  const byProviderId = new Map<string, ListModelsGroup>();
  for (const model of models) {
    let group = byProviderId.get(model.providerId);
    if (group === undefined) {
      group = { providerId: model.providerId, models: [] };
      byProviderId.set(model.providerId, group);
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/**
 * Chat card for ListModels.
 *
 * Why this needs a dedicated renderer: the tool name is not in shared's known-tool table, so the generic path is
 * `FallbackToolCallBlock`, which spreads the model-facing `<models>` text as-is—each line starts with
 * providerId (possibly a UUID-length identifier), with "current" hidden in brackets at the end.
 *
 * The card answers three things: which models exist, where they come from, and which is current. Each row's tier table and canonical id belong in the tooltip;
 * never show providerId on screen.
 */
export function ListModelsToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const providerName = useWorkflowSubagentModelProviderName(context.workspacePath);

  const result = useMemo(() => readListModelsResult(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.models.listing"
      : "chat.toolCall.workflow.models.listed",
  });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.empty" });
  const currentLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.current" });
  const truncatedLabel = intl.formatMessage({ id: "chat.toolCall.workflow.models.truncated" });

  const modelCount = result?.models.length ?? 0;
  const countLabel = intl.formatPlural({ id: "chat.toolCall.workflow.models.count" }, modelCount);

  const groups = useMemo(
    () => (result === null ? [] : groupModelsByProvider(result.models)),
    [result],
  );

  // ToolLayout is memoized; an inline JSX prop is a new reference on every render and defeats memoization.
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {modelCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, modelCount],
  );

  const renderContent = useCallback(() => {
    if (result === null) {
      return null;
    }

    return (
      <div className="mb-2 space-y-2" data-model-list="true">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 space-y-0.5">
            <div className="text-ui-xs text-foreground-subtlest">
              {listModelsGroupName(
                group.providerId,
                group.models.find((model) => model.providerLabel !== undefined)?.providerLabel,
                providerName,
                intl.formatMessage,
              )}
            </div>
            {group.models.map((model) => (
              <div
                key={model.id}
                className="flex min-w-0 items-baseline gap-x-2"
                title={listModelsRowTooltip(model, intl.formatMessage)}
                data-model-id={model.id}
              >
                <span
                  className={
                    model.disabledReason === undefined
                      ? "min-w-0 truncate font-mono text-ui-base text-foreground-subtle"
                      : "min-w-0 truncate font-mono text-ui-base text-foreground-subtlest"
                  }
                >
                  {model.modelId}
                </span>
                {model.id === result.current ? (
                  <span
                    className="shrink-0 text-ui-xs text-foreground-subtlest"
                    data-model-current="true"
                  >
                    {currentLabel}
                  </span>
                ) : null}
                {model.disabledReason === undefined ? null : (
                  <span className="min-w-0 truncate text-ui-xs text-warning">
                    {model.disabledReason}
                  </span>
                )}
                {model.contextWindow === undefined ? null : (
                  <span className="ml-auto shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                    {formatContextWindow(model.contextWindow)}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}

        {result.truncated ? (
          <p className="text-ui-sm text-foreground-subtlest">{truncatedLabel}</p>
        ) : null}
      </div>
    );
  }, [currentLabel, groups, intl.formatMessage, providerName, result, truncatedLabel]);

  // On failure, **do not** fall back to the generic card: it would expose error JSON, while the real message here is "this session cannot read the model
  // catalog." That differs from "there are no models," so the card shows neither a list nor that empty-state sentence (matching
  // model_catalog_unavailable on the model channel).
  if (result === null && toolCall.status === "failed") {
    return (
      <>
        <ToolLayout
          toolId={toolCall.toolId}
          icon={LIST_MODELS_TOOL_ICON}
          showIcon={context.showIcon !== false}
          canToggle={false}
          forceOpen={false}
          kindLabel={context.kindLabelOverride ?? kindLabel}
          sourceLabel={context.sourceLabel}
          // On failure, the summary row contains only the kind and status; a count or "no models configured" would be false.
          primaryText={null}
          statusLabel={context.statusLabel}
          statusTooltip={context.errorText}
          showFailureStatus
          isRunning={context.isRunning}
          title={toolCall.title}
        />
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            context.onLoadFullToolCallFields
              ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
              : undefined
          }
        />
      </>
    );
  }

  // If the structured result cannot be read (old session or fallback path), return to the generic card instead of rendering an empty catalog.
  if (result === null) {
    return <FallbackToolCallBlock {...context} iconOverride={LIST_MODELS_TOOL_ICON} />;
  }

  // When there are no models, the summary row is the whole message and there is no content to expand; an empty card body is harder to read than no body.
  const hasDetails = modelCount > 0;

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_MODELS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
