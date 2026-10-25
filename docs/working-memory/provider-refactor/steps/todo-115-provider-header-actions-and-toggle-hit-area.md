# Todo115: Consolidate Provider Header Actions and Fix Accidental Enable/Disable Clicks

> Status: Implemented on 2026-09-11 and passed focused review, component and browser verification; final acceptance of the
> full batch was pending at that time.
>
> Later decision: Account-type Providers cannot be disabled and show no toggle; existing account disable values no longer
> take effect ([Todo117](./todo-117-preserve-account-domain-on-provider-save.md)). The toggle here applies only to
> manual-key Providers; do not restore an account enable/disable entry.
>
> Follow-up verification (2026-09-12): the Pro full-page More menu delete -> confirmation -> navigation and Personal
> removal passed; template creation, regular detail, reordering and editing regressions passed. An existing E2E that still
> searched for a standalone trash icon was fixed; no product code change was needed. Full-batch type/lint/architecture
> checks and real-browser checks at two sizes passed; mobile shared-host was not tested. See the
> [final review of the batch](./provider-stabilization-20260911-final-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-115-provider-header-actions-and-toggle-hit-area.md`

## Background

The user reported that renaming a Provider made it disabled, then confirmed that clicking the blank space below the name
to finish editing had triggered the toggle by mistake. `InlineEditableProviderCard` wrapped the enable/disable switch in a
full-row `label`, so blank-space clicks toggled it. This was a hit-area issue, not a confirmed rename-persistence overwrite
of `enabled`.

## Confirmed Design

```text
[icon] Kimi                              [switch]   ⋯
                                                     Rename
                                                     ──────────
                                                     Delete provider
```

1. Provider icon and name stay on the left; the separate pencil and delete icons next to the name are removed.
2. Enable/disable moves to the right of the detail header with the More menu to the switch's right, not on a separate row.
   No persistent "Enable" / "Enable provider" text; the switch conveys its state.
3. For manual-key Providers, hover or keyboard focus describes the next action ("Disable provider" when enabled, "Enable
   provider" when disabled), in both locales. Account-type Providers have no switch. An explicit accessible name and switch
   state are kept (a Tooltip does not replace the accessible name).
4. The hit area is the switch itself plus a moderate touch target; the title, text and blank row area must not toggle it.
   The full-row label activation is removed and the touch target must not cover the adjacent menu.
5. Rename and Delete live in an always-available `⋯` dropdown (not hover-revealed), Delete separated from ordinary actions,
   reusing the existing delete-confirmation flow. After the menu closes the existing name-editing flow is reused (no second
   rename/save mechanism). Providers that cannot rename/delete do not offer them; the menu is hidden when no item is available.

## Semantics and Scope

- This changes the **Provider detail header**, not model rows; connection-field layout, section spacing and the model list
  are unchanged, and no previously rejected layout suggestion is added.
- Account Providers show no master switch and no Account Family switch is introduced; the public constraints that prevent
  disabling accounts and the plan-selection fix are Todo117.
- Persistence stays sparse on the outer Provider `enabled` field and the shared status result; no extra state source. After
  disabling, connection and model configuration stay editable; no unbinding or clearing keys, no change to per-model
  enabled state, no Selection deletion, no interruption of pinned execution.
- Desktop and mobile Web share interaction semantics; narrow screens, long names and long translations must not squeeze
  out the switch or menu; sizing, typography, themes and focus follow `DESIGN.md`.

## Acceptance (planned)

Interaction regression first: after renaming, clicking blank space in the old toggle row to finish editing saves the name
without changing `enabled`. Then: header actions consolidated and the old full-row layout and duplicate entries removed;
switch click/keyboard activates once and blank space, title and menu actions do not toggle it; rename preserves enabled
state; rename and delete confirmation/cancel from the menu with existing permission boundaries for account-type and
non-deletable entries; regular Providers and account plans, enabled/disabled, Chinese/English, light/dark, desktop and
narrow mobile with long names and non-overlapping hit areas; related E2E updated and focused regressions, typecheck and
lint run as a batch with observed evidence and untested scope recorded (no claim from static code alone); scope,
persistence and accessibility review recorded and committed.

## Implementation and Review (2026-09-11)

- The header's right side holds the manual-key switch and More menu; Delete/Rename reuse existing callbacks; the menu is
  hidden when there are no actions; accounts have no switch. The full-row label and separate pencil/trash icons are gone;
  connection and model sections are unchanged.
- The switch has localized next-action aria labels and Tooltip copy. Screenshot review found that Tooltip `data-state`
  overrode the Switch and the shared enlarged hit area reached the menu; the state attribute is isolated with a local
  wrapper and the horizontal hit-area expansion reduced to 4px here only (shared controls unchanged).
- With Todo132, 109 unit tests passed, including delete cancel/confirm through the existing
  `confirmAndDeleteModelProvider` and rename persistence leaving `enabled` unchanged. Six real-browser component cases
  passed (390px Chinese light / 1200px English dark, focus, long names, non-overlapping hit areas, menu, switch state, no
  horizontal overflow).
- Root typecheck and lint (0 errors / 41 warnings) passed. Existing Electron create/rename cases were updated for the menu
  and explicit blur; Electron was not actually run here. Real mobile shared-host/Pro remained for full-batch verification.
  Linux lacked Chinese glyphs, so Chinese copy was verified in DOM/interaction but not visually.
- Screenshots and computed styles: `/tmp/zcode-provider-settings-batch/header-options-*.png` and `header-options-*.json`.
  Review confirmed only action layout/name-commit boundaries changed; no new state source, permission, persistence field
  or execution-eligibility check.
