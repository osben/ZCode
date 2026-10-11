# Sidebar task hover card

## Behavior

- Hovering or keyboard-focusing a task row in either sidebar layout reveals the same compact information card.
- The card does not repeat the task title. It shows task status and last activity, workspace, the observed branch or a compact merged label with available line-change totals, model, and reasoning effort. It does not expose the local merge target.
- The card reads existing task metadata and the per-workspace branch-status store only; opening it does not trigger GitHub, Git, or provider requests.
- Pull-request number/status are not currently available in task/sidebar metadata. Keep a code TODO for a trustworthy future source; do not infer PR state from a branch name.
- Touch behavior remains the existing row interaction; the card is available to keyboard focus as well as pointer hover.

## Acceptance scenarios

- Hover or focus a regular task row: the card shows the available status/time, workspace, branch, model/effort, and change totals.
- Hover or focus a grouped task row: it shows the same fields and layout.
- Missing optional branch, model, or change metadata omits that row without showing placeholders.
