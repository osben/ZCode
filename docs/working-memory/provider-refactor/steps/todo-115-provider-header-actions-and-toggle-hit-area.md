# Todo115: Consolidate Provider Header Actions and Fix Accidental Enable/Disable Clicks

> Status: Implemented on 2026-09-11 and passed focused review, component, and browser verification; final acceptance of the full batch remained pending.

> Later decision: Account-type Providers cannot be disabled and do not show a toggle; existing account disable values no longer take effect. See [Todo117](./todo-117-preserve-account-domain-on-provider-save.md). The toggle in this layout change applies only to manual-key Providers; do not restore an account enable/disable entry point.

> Follow-up verification on 2026-09-12: the Pro full-page More menu delete → confirmation → navigation and Personal removal passed; template creation, regular detail, reordering, and editing regressions passed. Fixed an existing E2E that still searched for a standalone trash icon; no product code change was needed. Full-batch type/lint/architecture checks and real-browser checks at two sizes passed; mobile shared-host was not tested. See [final review of the batch](./provider-stabilization-20260911-final-review.md) for the current result. “Batch acceptance pending / Pro not tested” below is historical process context.

## Background

The user reported that renaming a Provider caused it to become disabled, then confirmed that clicking the blank space below the name to finish editing had triggered the toggle by mistake.

`InlineEditableProviderCard` currently wraps the enable/disable switch in a full-row `label`, so clicking blank space also triggers it. This is a hit-area issue, not a confirmed case of rename persistence overwriting `enabled`.

## Confirmed Design

```text
[icon] Kimi                              [switch]   ⋯
                                                     Rename
                                                     ──────────
                                                     Delete provider
```

- Keep the Provider icon and name on the left; remove the separate pencil and separate delete icons next to the name.
- Move enable/disable to the right side of the detail header, with the More menu to the switch's right; do not put it on a separate row.
- Do not show persistent “Enable” or “Enable provider” text; the switch conveys its current state.
- For manual-key Providers, on hover or keyboard focus, describe the next action: “Disable provider” when enabled and “Enable provider” when disabled. Add both locales. Account-type Providers have no switch.
- Keep an explicit accessible name and switch state; a Tooltip does not replace the accessible name.
- Restrict the hit area to the switch itself and a moderate touch target. The title, text, and blank row area must not toggle it. Remove the full-row label activation area; the touch target must not cover the adjacent menu.
- Put Rename and Delete in an always-available `⋯` dropdown; do not require hover to reveal them. Separate Delete from ordinary actions and reuse the existing delete-confirmation flow.
- After the menu closes, reuse the existing name-editing flow; do not create a second rename/save mechanism. Do not offer Rename/Delete for Providers that cannot perform those actions. Hide the menu when there are no available items.

## Semantics and Scope

- This changes the **Provider detail header**, not model rows. Keep connection-field layout, section spacing, and model list unchanged; do not add previously rejected layout suggestions.
- Account Providers do not show a master switch; do not introduce an Account Family switch. Public write/parse constraints that prevent disabling accounts and the plan-selection fix are handled by Todo117; do not implement them again here.
- Continue using sparse persistence for the outer Provider `enabled` field and the shared status result; do not add another source of state. After disabling, users may still edit connection and model configuration. Do not unbind or clear keys, change per-model enabled state, delete Selection, or interrupt pinned execution.
- Desktop and mobile Web share the interaction semantics. Narrow screens, long names, and long translations must not squeeze out the switch or menu. Follow `DESIGN.md` for sizing, typography, themes, and focus.

## Implementation and Acceptance

- [ ] Add interaction regression first: after renaming, clicking blank space in the old toggle row to finish editing saves the name without changing Provider `enabled`.
- [ ] Consolidate header actions, fix the switch hit area, and remove the old full-row toggle layout and duplicate action entries.
- [ ] Verify that switch click/keyboard activates once; blank space, title, and More-menu actions do not toggle it; rename preserves the enabled state.
- [ ] Verify rename and delete confirmation/cancel from the More menu; preserve existing permission boundaries for account-type and non-deletable entries.
- [ ] Verify regular Providers and account plans, enabled/disabled, Chinese/English, light/dark themes, desktop and narrow mobile screens, including long names and non-overlapping switch/menu hit areas.
- [ ] Update related E2E and run focused regressions, typecheck, and lint as a batch. Record observed evidence and untested scope; do not claim interaction success from static code alone.
- [ ] Review scope, persistence semantics, and accessibility; record results in this Todo and commit.

## Implementation and Review on 2026-09-11

- The header's right side contains the manual-key switch and More menu; Delete/Rename reuse existing callbacks. Hide the menu when there are no actions; accounts have no switch. Removed the full-row label and separate pencil/trash icons; connection and model sections are unchanged.
- The switch has localized next-action aria labels and Tooltip copy. Browser screenshot review revealed that Tooltip `data-state` overrode the Switch and the shared enlarged hit area reached the menu. Isolated the state attribute with a local wrapper and reduced the horizontal hit-area expansion to 4px here only; did not change shared controls.
- In combination with Todo132, 109 unit tests passed, including delete cancellation/confirmation through existing `confirmAndDeleteModelProvider` and rename persistence leaving `enabled` unchanged. Six real-browser component cases passed. Coverage included 390px Chinese light / 1200px English dark, focus, long names, non-overlapping hit areas, menu, switch state, and no horizontal overflow.
- Root typecheck and lint (0 errors / 41 warnings) passed. Updated existing Electron create/rename cases for the menu and explicit blur; do not claim Electron was actually run. Real mobile shared-host/Pro remained for full-batch verification. Linux lacked Chinese glyphs, so Chinese copy was verified in the DOM/interaction but not visually for font rendering.
- Screenshots and computed styles: `/tmp/zcode-provider-settings-batch/header-options-*.png` and `header-options-*.json`. Review confirmed only action layout/name-commit boundaries changed; no new state source, permission, persistence field, or execution-eligibility check was added.
