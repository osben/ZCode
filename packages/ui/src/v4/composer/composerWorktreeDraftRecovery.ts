/** Keep both the withdrawn submission and text entered while its worktree was being created. */
export function mergeWithdrawnWorktreeDraftText(
  submittedText: string,
  currentText: string,
): string {
  const submitted = submittedText.trimEnd();
  const current = currentText.trimStart();
  if (!submitted) return current;
  if (!current) return submittedText;
  if (current === submitted || current.startsWith(`${submitted}\n`)) return currentText;
  return `${submitted}\n\n${current}`;
}
