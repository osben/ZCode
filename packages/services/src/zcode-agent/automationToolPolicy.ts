export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;

export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// The off-peak dispatch turn denies only OffPeakCreate (to prevent off-peak tasks from recursively spawning themselves and scheduling indefinitely); keep read-only OffPeakList available.
// Keep this as a separate constant; never merge it into AUTOMATION_MUTATION_TOOL_NAMES. The cron automation turn
// explicitly allows OffPeakCreate (to schedule off-peak tasks), and merging the constants would incorrectly deny it there.
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  const merged = new Set(current);
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}
