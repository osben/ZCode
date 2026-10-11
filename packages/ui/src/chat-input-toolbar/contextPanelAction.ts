export function runContextPanelActionWithClose({
  action,
  close,
}: {
  action?: () => void;
  close: () => void;
}) {
  // Clicking a button inside HoverCard does not automatically close the panel like an outside hover leave.
  // Entry actions navigate to settings or usage details; close the context panel first so the old overlay does not remain.
  close();
  action?.();
}
