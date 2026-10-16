# Bugfix 06: Provider Read-Only Field Locking Hint

> Status: Completed

## Problem

The Built-in Provider's Base URL and API Format are displayed according to the Official Config, but the settings page uses almost the same visual structure as a normal input box. Although the field cannot be focused or edited, the user still cannot directly judge from browsing that it is a read-only fact, and is prone to understanding "cannot click" as a control failure.

## Target Behavior

- The Base URL and the API Format continue to display the real Effective Provider Config;
- The read-only field maintains the normal input box's background, border, font size, and height, without adding disabled opacity or an extra card;
- Each read-only field fixes the display of a lock icon on the right, clearly expressing that the current field is not editable;
- The lock icon provides a localized accessibility name, and does not rely only on visual graphics to convey the state;
- The long Base URL can continue to wrap; the text occupies the remaining space, and the lock icon is not squeezed;
- The editable Provider, API Key, model config, save, and Overlay semantics remain completely unchanged.

## Root Cause and Fix Boundary

The root cause is that the read-only branch of the `ProviderConnectionSection` only replicates the input box's surface and does not provide a visual hint of the read-only state. The fix only adds a unified read-only field component and a lock icon to that display branch, without modifying the Provider Config, Registry, or permission judgment.

## Acceptance

- The normal Built-in Provider's Base URL and API Format each display a lock icon;
- The lock icon has an accessible name in both Chinese and English environments;
- The editable Provider still uses the original Input/Select, and no lock icon appears;
- The Desktop, Web, narrow-width layout, and all themes remain usable;
- The UI targeted test, the typecheck, the lint, the format check, and the `git diff --check` pass.

## Implementation Result

- The `ProviderConnectionSection`'s read-only branch uniformly uses a single-layer read-only field appearance; the Base URL and the visible API Format fix the display of the `LockKeyholeIcon` on the right;
- The text uses `min-w-0 + flex-1 + break-all` to occupy the remaining width, and the lock icon stays `shrink-0`; the long URL does not cover or squeeze off the status hint;
- The Chinese and English provide the accessibility names "{field}（只读）" and "{field} (read only)" respectively;
- The editable branch still uses the original `Input` and `ProviderApiFormatSelect`; the save, the Overlay, and the Registry are not changed;
- 36 Provider/Model UI targeted tests pass, the root `pnpm typecheck` passes, the root `pnpm lint` passes (0 error, 34 pre-existing warnings), the format check of the modified files and the `git diff --check` pass.
