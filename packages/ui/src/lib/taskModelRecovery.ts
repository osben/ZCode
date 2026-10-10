import type { ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { getZCodeAgentModeSelectOptions } from "@zcode/shared";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

function parseProviderQualifiedModel(
  model: string,
): { providerId: string; modelName: string } | null {
  const normalizedModel = model.trim();
  const separatorIndex = normalizedModel.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedModel.length - 1) {
    return null;
  }

  const providerId = normalizedModel.slice(0, separatorIndex).trim();
  const modelName = normalizedModel.slice(separatorIndex + 1).trim();
  if (!providerId || !modelName) {
    return null;
  }

  return { providerId, modelName };
}

function isSyntheticModelPlaceholder(model: string): boolean {
  return model.trim().toLocaleLowerCase() === "<synthetic>";
}

function resolveGlmRecoveredTaskModelValue(taskModel: string | undefined): string | null {
  const normalizedTaskModel = taskModel?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedTaskModel);
  if (customModel?.providerId && customModel.modelName) {
    return normalizedTaskModel;
  }

  const providerQualifiedModel = parseProviderQualifiedModel(normalizedTaskModel);
  if (providerQualifiedModel) {
    return encodeCustomModelValue(
      providerQualifiedModel.providerId,
      providerQualifiedModel.modelName,
    );
  }

  return normalizedTaskModel;
}

function resolveRecoveredTaskModelValue(
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">,
): string | null {
  const normalizedTaskModel = taskMeta.model?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  if (taskMeta.provider === "glm") {
    return resolveGlmRecoveredTaskModelValue(normalizedTaskModel);
  }

  return normalizedTaskModel;
}

function resolveModelOptionName(modelValue: string): string {
  const customModel = decodeCustomModelValue(modelValue);
  const providerQualifiedModel = parseProviderQualifiedModel(modelValue);
  return customModel?.modelName?.trim() || providerQualifiedModel?.modelName || modelValue;
}

function ensureModelOptionValue(option: ZCodeConfigOption, modelValue: string): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === modelValue);
  if (hasOption && option.currentValue === modelValue) {
    return option;
  }

  return {
    ...option,
    currentValue: modelValue,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: resolveModelOptionName(modelValue),
            value: modelValue,
          },
        ],
  };
}

function createRecoveredModelOption(modelValue: string): ZCodeConfigOption {
  return {
    category: "model",
    currentValue: modelValue,
    id: "model",
    name: "Model",
    options: [
      {
        name: resolveModelOptionName(modelValue),
        value: modelValue,
      },
    ],
    type: "select",
  };
}

function createRecoveredModeOption(modeValue: string): ZCodeConfigOption {
  return {
    category: "mode",
    currentValue: modeValue,
    id: "mode",
    name: "Mode",
    options: getZCodeAgentModeSelectOptions(),
    type: "select",
  };
}

function createRecoveredThoughtLevelOption(thoughtLevel: string): ZCodeConfigOption {
  return {
    category: "thought_level",
    currentValue: thoughtLevel,
    id: "thought_level",
    name: "Effort",
    options: [
      {
        name: thoughtLevel,
        value: thoughtLevel,
      },
    ],
    type: "select",
  };
}

function ensureSelectOptionCurrentValue(
  option: ZCodeConfigOption,
  value: string,
): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === value);
  if (hasOption && option.currentValue === value) {
    return option;
  }

  return {
    ...option,
    currentValue: value,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: value,
            value,
          },
        ],
  };
}

function mergeRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  const recoveredModelValue = resolveRecoveredTaskModelValue(taskMeta);
  if (!recoveredModelValue) {
    return null;
  }

  let hasModelOption = false;
  let changed = false;
  const nextConfigOptions = configOptions.map((option) => {
    if (option.category !== "model" || option.type !== "select") {
      return option;
    }

    hasModelOption = true;
    const nextOption = ensureModelOptionValue(option, recoveredModelValue);
    changed = changed || nextOption !== option;
    return nextOption;
  });

  if (!hasModelOption) {
    // During restoration of a historical task, resume/config_option_update may arrive after the first render.
    // Clearing only the previous task's configuration briefly returns the toolbar to “Select model”; synthesize a minimal model option from task.meta.model
    // to keep the persisted model visible until the real configOptions arrive and replace it.
    return [createRecoveredModelOption(recoveredModelValue), ...nextConfigOptions];
  }

  // During restoration of an old session, task.meta.model may already have been written back to task configuration.
  // Returning a new array here when nothing changed would make callers repeatedly call setTaskConfigOptions, triggering the toolbar restoration effect again and again.
  return changed ? nextConfigOptions : null;
}

export function resolveTaskRestorePreloadConfigOptions({
  taskMeta,
  cachedTaskConfigOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model"> &
    Partial<Pick<ZCodeTaskMeta, "mode" | "thoughtLevel">>;
  cachedTaskConfigOptions?: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] {
  let cachedOptions = [...(cachedTaskConfigOptions ?? [])];
  const recoveredOptions = mergeRecoveredTaskModelConfigOptions({
    taskMeta,
    configOptions: cachedOptions,
  });

  if (recoveredOptions) {
    cachedOptions = recoveredOptions;
  }

  const mode = taskMeta.mode?.trim();
  if (taskMeta.provider === "glm" && mode) {
    let hasModeOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "mode" || option.type !== "select") {
        return option;
      }
      hasModeOption = true;
      return ensureSelectOptionCurrentValue(option, mode);
    });
    if (!hasModeOption) {
      // Before real settings arrive for a task created by a scheduled run, the composer can only access task metadata.
      // Synthesize a minimal mode option from metadata here to avoid briefly showing the workspace default at the permission entry point.
      cachedOptions = [createRecoveredModeOption(mode), ...cachedOptions];
    }
  }

  const thoughtLevel = taskMeta.thoughtLevel?.trim();
  if (taskMeta.provider === "glm" && thoughtLevel) {
    let hasThoughtOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "thought_level" || option.type !== "select") {
        return option;
      }
      hasThoughtOption = true;
      return ensureSelectOptionCurrentValue(option, thoughtLevel);
    });
    if (!hasThoughtOption) {
      // As with mode, first restore the automation's task-local thoughtLevel from task metadata;
      // later session settings will add the full thought options supported by the model.
      cachedOptions = [...cachedOptions, createRecoveredThoughtLevelOption(thoughtLevel)];
    }
  }

  // Once a historical task has been opened, taskConfigOptionsByTaskId contains complete
  // model/mode/thought_level data. If restoration clears it just because task.meta.model is missing,
  // the toolbar first hides mode/thought and shows them again after the new snapshot arrives. Keep the task-level cache here,
  // and let setTaskConfigOptions replace/hide values only when they are actually absent from new settings.
  return cachedOptions;
}
