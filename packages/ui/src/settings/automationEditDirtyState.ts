export type AutomationEditDirtyField =
  | "title"
  | "prompt"
  | "schedule"
  | "mode"
  | "thoughtLevel"
  | "model";

export type AutomationEditFieldSignatures = Record<AutomationEditDirtyField, string>;

/** Compare only fields the user actually changed, avoiding false dirty state from system normalization during form initialization. */
export function resolveChangedAutomationEditFields(params: {
  touchedFields: ReadonlySet<AutomationEditDirtyField>;
  current: AutomationEditFieldSignatures;
  baseline: Partial<AutomationEditFieldSignatures>;
}): AutomationEditDirtyField[] {
  return [...params.touchedFields].filter(
    (field) =>
      params.baseline[field] !== undefined && params.current[field] !== params.baseline[field],
  );
}
