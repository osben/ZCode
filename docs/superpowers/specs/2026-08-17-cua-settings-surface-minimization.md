# CUA Settings Surface Minimization (Helper Status and Experimental Toggles Retired)

- Date: 2026-08-17
- Status: implemented (accompanies MR z-code!2068)
- Scope: CUA surfaces only; non-CUA settings and other feature areas are untouched

## Background

The 2026-08-15 Helper instance isolation design (zcode-cua
`docs/refactor-port-specs/CUA-HELPER-INSTANCE-ISOLATION-PLAN.md`, step 7) exposed controller status/takeover/stop
to the permission service and rendered two desktop UIs:

1. the Input controller row in the Settings "Computer Use" section (owner badge + Take control/Stop buttons);
2. the persistent `CuaControllerStatusControl` status pill in the workspace title bar.

Settings also gained three Helper startup toggles (Agent pointer feedback / Picture-in-Picture / Background
mode). Product review concluded all of these surfaces are redundant:

- Helper running state has no actionable value for users (permission guidance has its own status rows, and
  fault self-healing goes through the restart chain).
- The controller lease is a Helper-side safety arbitration and takes effect automatically; users need no manual
  take/stop.
- Agent pointer feedback and Picture-in-Picture are simply on by default; there is no product scenario for
  turning them off.
- Background mode (AX-only, no focus stealing) does not fit the current interaction model and is no longer
  offered.

## Target behavior

### Settings page (macOS / Windows converge the same way)

The "Computer Use" section keeps only:

1. the master switch (zcode-cua plugin enablement, linked to MCP + skill);
2. the macOS Accessibility / Screen Recording permission rows (including Grant guidance and, when stale, the
   Helper restart + ZCode restart fallback; the current recovery chain is unaffected).

When not authorized, the action order on the right of a permission row is fixed as `[Open... button] [status
badge]`; button and status belong to the same control area, and the Open button is no longer in the detail area
below the row. The stale Helper/ZCode restart recovery action stays in the detail area without duplicating the
Open button. The wide control layout applies only to Computer Use permission rows: wide screens use a 280px
action column with no wrapping of button and status; narrow screens switch to a single column with the whole
control area below the description. Other `SettingsRow` instances keep the 192px action column. The Open action
reuses the MCP "open authorization" button look: `link` size, blue link state, ExternalLink icon; small screens
keep only the icon but still expose the full action name via `aria-label` / `title`.

Removed rows: Helper runtime row (version/path/Running badge/restart icon), Input controller row, Agent pointer
feedback row, Picture-in-Picture row, Background mode row.

### Title bar

Remove `CuaControllerStatusControl` and its `showCuaControllerStatus` wiring in `WorkspaceHeader` /
`WorkspaceHeaderActionSection`. The title bar shows no CUA status.

### Runtime defaults (no longer configurable)

| Capability                         | Before                            | Now                                           |
| ---------------------------------- | --------------------------------- | --------------------------------------------- |
| Agent pointer overlay (ghost cursor) | `cuaGhostCursorEnabled` default on | Always on (producer product factory fixes true) |
| Picture-in-Picture window          | `cuaPipMode` default on           | Always on (producer product factory fixes true) |
| Background mode (no focus stealing) | `cuaBackgroundMode` default off   | Removed (host no longer passes the startup arg) |

### Settings storage

The three keys `AppSettings.cuaGhostCursorEnabled` / `cuaPipMode` / `cuaBackgroundMode` are deleted from
`packages/shared/src/protocol.ts` and `validationAppSettings.ts` (full + patch schema). Old keys in existing
user config are ignored by zod strip semantics; no migration.

## Boundaries (explicitly not done)

- **The controller lease itself stays.** The zcode-cua Helper-side user-level lease arbitration (multi-instance
  coexistence, only the owner may dispatch side effects and overlay) is a safety mechanism; only the desktop's
  manual UI is retired.
- **The desktop controller facade is retired.** Producer 0.5.7 removed
  `takeController/stopController/getHelperStatus` from `ICuaPermissionService`, and z-code removed the
  zero-caller implementation. The raw broker controller protocol, lease/admission and the Helper's internal
  explicit takeover safety machinery are unaffected.
- Permission guidance flow (onboarding, return-from-authorization recovery, stale verification, ZCode restart
  fallback) is unchanged; the `restartHelper` / `getStatus` service surface is unchanged.

## Impact list

- UI: `packages/ui/src/CuaControllerStatusControl.tsx` (deleted), `WorkspaceHeader*.tsx/shared.ts` (wiring
  removed), `settings/ComputerUseSection.tsx` (rows removed + helper heartbeat polling removed), i18n keys
  `settings.computerUse.controller*/pipMode*/backgroundMode*/ghostCursor*/helper{Label,Running,NotRunning}`
  (removed in zh/en).
- Protocol/validation: the three `AppSettings` keys removed.
- services: producer product factory fixes ghost cursor/PiP=true, `node.ts` no longer passes a pseudo-dynamic
  getter; desktop controller query/command facade deleted, raw broker controller safety boundary kept.
- Tests: delete `cuaControllerStatusControl.test.ts`; rewrite `computerUseWindowsSettings.test.ts` (assert the
  converged row set), `computerUseNoAutoPermissionModal.test.ts`, `workspaceHeader.test.ts`,
  `appSettings.test.ts`; `cuaGhostCursorSettingsWiring.test.ts` now locks the "always on" wiring.

## Verification

- `pnpm vitest run` (CUA-related suites in ui/shared/services)
- `pnpm typecheck`, `pnpm lint`
- The three integrity gates (skill-sync / version-coherence) stay green on the merge base
