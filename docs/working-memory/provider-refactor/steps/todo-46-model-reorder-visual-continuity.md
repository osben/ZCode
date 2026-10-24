# Todo 46: Model Reorder Visual Continuity and List Border Closeout

> Status: Completed
>
> Date: 2026-08-28
>
> Source: manual experience on the macOS Provider settings page

## 1. Problem

Dragging a model in Provider settings and releasing made the model row briefly return to its old position and then
jump to the target. The final order usually saved, so `modelOrder` computation and persistence were fine; the problem
sat between `dnd-kit` ending its temporary transform and the formal Settings View confirming the new revision. The
model list also showed a bottom edge thicker than the row dividers: only a single outer frame with one divider
between models is intended. The Provider title's enable pill stays as is (not a Switch: editable Personal Provider
and Account-Overlay-determined read-only states are not the same interaction semantics).

## 2. Root cause

Model reorder only did one synchronous `setModels(next)` in `InlineEditableProviderCard` and, unlike Provider
reorder, did not keep the user's latest order as a pending intent until the formal Settings View confirmed it; the
`provider` prop update then unconditionally ran `setModels(authoritativeModels)`. A single local state update does
not cover the async confirmation window, stale View reprojection or consecutive drags (Bugfix 02 assumed it did,
without a controlled delayed save and stale upstream View test). For the border, the outer frame and `divide-y` sat on
the parent container holding the DnD runtime subtree, so border duties were implicit and the last visible row relied
on "last DOM child".

## 3. Design

Model and Provider reorder share one UI pending semantics:

```text
Authoritative modelOrder ------+
                               +--> Rendered Model Order
Drag End -> Pending Model Reorder --+
      +--> Settings View aligns -> clear Pending
      `--> save failure -> roll back to Authoritative
```

- Personal Config and Settings View stay the persistence and formal read authority; pending exists only in the
  current settings page and never enters Config, Registry, Selection or Runtime.
- An upstream Provider View with the same members but the old order does not overwrite pending.
- Member changes, Provider/Environment switch or save failure exit pending safely.
- Consecutive drags save in interaction order and an old completion cannot overwrite the latest order.
- Model edit, enable/disable and delete locate by stable Model ID, never a display index that can change.

Border: list container has one rounded outer border; each Model row has one bottom divider; the last row has none.

## 4. Implementation and acceptance

- Model reorder reuses `useOptimisticReorder` and projects visible models by `renderedIds`; the hand-written
  `previous/next/setModels` rollback branch is deleted so only one pending mechanism exists.
- Model edit/toggle/delete callbacks use Model ID; the parent `divide-y` is removed in favor of explicit per-row
  `border-b` (last row off), outer frame single layer. Provider enable pill unchanged.
- UI unit tests: controlled delayed save, stale View reprojection, failure rollback, consecutive reorder, member
  change. Border structure test: one outer frame, no divider on the last row. Desktop E2E `MP-UI-03`: a real pointer
  drag records DOM order and asserts the old order does not flash back between release and save confirmation.

## 5. Outcome (2026-08-28)

`pnpm exec vitest run packages/ui/test/modelProviderModelRowEditor.test.ts packages/ui/test/useOptimisticReorder.test.ts`
43 passed; `@zcode/ui` tsc, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck` passed; `pnpm lint` 0
errors (33 pre-existing warnings); changed files formatted with `oxfmt --write`, `git diff --check` passed;
repo-wide `pnpm fmt:check` is still blocked by the Electron upstream fiddle HTML and
`apps/zcode-cli/tests/gb2312.js`. Desktop E2E built for production but the Linux host lacks `xvfb-run`, so
Chromedriver could not create a session before test code ran (the case passes E2E TypeScript validation and awaits a
graphical environment).
