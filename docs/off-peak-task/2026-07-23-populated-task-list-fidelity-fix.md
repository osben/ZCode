# Populated task list visual fidelity

## Design reference

- Date: 2026-07-23
- Figma file: `IGDrByFuL2wY5fLUWku4sb`, node `4835:5515`
- Design state: `Automations - Task list all`
- Scope: populated `All` state of the desktop Automations main view

## Rules

- When `All` contains both Idle-time and Scheduled tasks, the parent owns one shared grid:
  - two columns on desktop, one column below the mobile breakpoint;
  - fixed 132px row height;
  - 16px horizontal and vertical gaps;
  - Idle-time cards first, Scheduled cards right after them.
- The mixed state removes the extra layout boxes of the two child lists with `display: contents`,
  keeping the card components, menus, keyboard interaction and their own data semantics.
- The mixed state hides the `Task created` heading; single-type lists keep the original heading and
  list structure.
- In the populated state Keep-awake renders before the task grid, with a 16px gap between the
  action row and the banner. The empty state keeps its existing order (large empty card, then
  Keep-awake).
- In the populated action row: unselected tabs keep the surface pill; `Create via chat` uses the
  outline appearance; `Idle-time task` keeps the primary button.

## Boundaries

- Mobile `/remote` does not host Automations; remote routing and realtime semantics are unchanged.
- Display conditions for Scheduled-only, Idle-only, empty state and remote workspaces are unchanged.
- Out of scope (low-severity audit items): content column horizontal offset, sidebar information
  architecture, Keep-awake brand color.

## Verification

- `packages/ui/test/automationsPopulatedListFidelity.test.ts`: populated Keep-awake sits before the
  task grid with the right spacing; mixed `All` shares one grid; the extra heading is hidden; tab
  pill and outline action styles.
- Isolated Electron mock E2E at a 1440x960 CSS viewport: Idle-time and Scheduled cards both start at
  `273px` with width `393px` and a `16px` column gap; Keep-awake spans `213-257px`, fully before the
  grid; computed columns are `393px 393px` and `Task created` is not rendered.
- `pnpm typecheck` and `pnpm lint` as the mechanical gates.
