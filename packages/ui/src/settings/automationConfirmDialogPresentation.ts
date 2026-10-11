/** Automation fixes only the outer size of the shared ConfirmDialog; the shared component continues to own its internal styling. */
export const AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS =
  "min-h-[180px] w-[min(448px,calc(100vw-2rem))] max-w-none";

// Merge rationale: the remote change added protection for long text, but should not also override the locally approved internal dialog styling.
export const AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS =
  "line-clamp-3 break-words whitespace-pre-line";
