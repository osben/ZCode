// ============================================================
// The subagent model's selection surface: shared by the "configure" popover and the confirmation window
// ============================================================
// docs/dynamic-workflow/presentation.md "The settings popover", "The confirmation window".
//
// Extracted from WorkflowRunSettingsPopover.tsx: two places choosing the same thing (which model the
// subagents run on) must share one list (the composer's model menu, session model first), one trigger
// wording, and one "switching models takes its registry default thinking level" rule. Write them
// separately and one day the selectable models in the confirmation window will differ from the
// popover's.

import { useCallback, useMemo } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { describeWorkflowSubagentModel } from "./subagent-model-label.js";
import {
  workflowRunSettingsModelCanonical,
  type WorkflowRunSettingsModel,
} from "./workflowRunSettings.js";

/** The menu's "session model" entry value: outside encodeCustomModelValue's value domain, so it cannot collide with a real model. */
const SESSION_MODEL_VALUE = "workflow-settings:session-model";

/** The model list's scope and session model: provided by the host. */
export interface WorkflowSettingsModelScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** The session's current model (the first item and trigger use its name); absent, the first item just says "session model". */
  sessionModel?: { providerId: string; modelId: string };
}

/** How one model choice looks on screen. */
export interface WorkflowSettingsModelFace {
  /** Menu value (the session model uses a placeholder value). */
  value: string;
  /** Name on the trigger: the session model's name, or a human name for the canonical string. */
  triggerLabel: string;
  /** The list loaded but the model is not in it: deleted or disabled. */
  unavailable: boolean;
  /** Its thinking level; null when it has none (or it is unavailable). */
  thoughtOption: ZCodeConfigOption | null;
}

export function useWorkflowSettingsModelChoices(scope: WorkflowSettingsModelScope) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const modelRead = useModelSelectionView(
    scope.workspacePath,
    scope.remoteSessionId,
    scope.workspaceIdentity,
  );
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups: ModelSelectGroup[] = useMemo(
    () =>
      view === null
        ? []
        : buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyLabel: format("settings.modelProvider.apiKey"),
            apiKeyBadgeLabel: format("settings.modelProvider.connectionMode.apiKeyBadge"),
            codingPlanLabel: format("settings.modelProvider.connectionMode.codingPlan"),
            codingPlanBadgeLabel: format("settings.modelProvider.connectionMode.codingPlanBadge"),
            startPlanLabel: format("settings.modelProvider.connectionMode.startPlan"),
            startPlanBadgeLabel: format("settings.modelProvider.connectionMode.startPlanBadge"),
            teamPlanBadgeLabel: format("settings.modelProvider.connectionMode.teamPlanBadge"),
            teamPlanFallbackLabel: format("settings.modelProvider.connectionMode.teamPlan"),
          }),
    [format, view],
  );
  const providerName = useCallback(
    (providerId: string) =>
      view?.providers.find((provider) => provider.providerId === providerId)?.providerName ??
      undefined,
    [view],
  );

  const sessionModel = scope.sessionModel;
  const sessionModelName =
    sessionModel === undefined
      ? format("chat.toolCall.workflow.run.settings.model.sessionFallback")
      : formatProviderModelLabel(
          sessionModel.providerId,
          providerName(sessionModel.providerId),
          sessionModel.modelId,
        );
  const sessionBadge = format("chat.toolCall.workflow.run.settings.model.session");
  // Both fields are strings, so this item changes reference only when the copy actually changes; the downstream model selector is a memo component.
  const sessionModelItem: ModelSelectGroupItem = useMemo(
    () => ({
      key: "workflow-settings:session-model",
      value: SESSION_MODEL_VALUE,
      name: sessionModelName,
      badgeLabel: sessionBadge,
    }),
    [sessionModelName, sessionBadge],
  );

  const describe = useCallback(
    (model: WorkflowRunSettingsModel): WorkflowSettingsModelFace => {
      const value =
        model.kind === "session"
          ? SESSION_MODEL_VALUE
          : encodeCustomModelValue(model.providerId, model.modelId);
      const listed = groups.some((group) => group.items.some((item) => item.value === value));
      // The list loaded but the model is not in it: it was deleted or disabled. The downstream waits
      // for the user to pick another — keeping it would only make the agent answer model_unavailable
      // (the same tool failure "the carried-over model is unavailable", surfaced before the click).
      const unavailable = model.kind === "model" && view !== null && groups.length > 0 && !listed;
      const canonical = workflowRunSettingsModelCanonical(model);
      const triggerLabel =
        model.kind === "session" || canonical === undefined
          ? sessionModelName
          : describeWorkflowSubagentModel(canonical, {
              formatMessage: intl.formatMessage.bind(intl),
              providerName,
            }).name;
      const thoughtOption =
        model.kind === "model" && view !== null && !unavailable
          ? resolveModelThoughtOption({
              modelSelectionView: view,
              providerId: model.providerId,
              modelId: model.modelId,
              ...(model.level === undefined ? {} : { currentValue: model.level }),
            })
          : null;
      return { value, triggerLabel, unavailable, thoughtOption };
    },
    [groups, intl, providerName, sessionModelName, view],
  );

  /** A menu selection → the new model choice. Switching models takes its registry-default thinking level; the same model keeps the current level. */
  const pick = useCallback(
    (value: string, current: WorkflowRunSettingsModel): WorkflowRunSettingsModel => {
      if (value === SESSION_MODEL_VALUE) return { kind: "session" };
      const picked = parseModelPickerValue(value);
      const same =
        current.kind === "model" &&
        current.providerId === picked.providerId &&
        current.modelId === picked.modelId;
      const level = same
        ? current.level
        : view === null
          ? undefined
          : completeNewModelSelection(view, picked)?.options?.reasoningLevel;
      return {
        kind: "model",
        providerId: picked.providerId,
        modelId: picked.modelId,
        ...(level === undefined ? {} : { level }),
      };
    },
    [view],
  );

  return {
    /** The list has not loaded yet (fields disabled until it does). */
    loading: view === null,
    /** The list loaded but contains no models: the model cell degrades to a single sentence. */
    noCatalog: view !== null && groups.length === 0,
    groups,
    providerName,
    sessionBadge,
    sessionModelItem,
    sessionModelName,
    describe,
    pick,
  };
}
