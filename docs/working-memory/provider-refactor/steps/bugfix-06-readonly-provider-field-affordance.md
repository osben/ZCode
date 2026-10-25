# Bugfix 06: Provider Read-Only Field Locking Hint

> Status: Completed
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-06-readonly-provider-field-affordance.md`

## Problem and Cause

A Built-in Provider's Base URL and API Format show the Official Config but used almost the same visual structure as
a normal input, so users read "cannot click" as a control failure. The read-only branch of
`ProviderConnectionSection` copied the input surface without any read-only hint. Provider Config, Registry and
permission judgment are not involved.

## Rules

1. Base URL and API Format keep showing the real Effective Provider Config.
2. The read-only field keeps the normal input background, border, font size and height (no disabled opacity, no
   extra card) and always shows a `LockKeyholeIcon` on the right.
3. The icon carries a localized accessible name: "{field}（只读）" in Chinese, "{field} (read only)" in English.
4. Text uses `min-w-0 + flex-1 + break-all` so long URLs wrap and take the remaining width; the icon is `shrink-0`
   and is never squeezed or covered.
5. Editable Providers still use the original `Input` and `ProviderApiFormatSelect` with no lock icon; save, Overlay
   and Registry are unchanged.

## Acceptance

Normal Built-in Provider Base URL and API Format each show the lock; accessible names exist in both locales;
editable Providers show no lock; Desktop, Web, narrow width and all themes remain usable. Targeted UI tests (36
Provider/Model tests), typecheck, lint, format check and `git diff --check` passed at the time.
