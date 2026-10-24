# Todo153: Thought-level display mapping and config-order alignment

> Status (2026-09-16): implemented with local unit tests, browser interaction and visual verification;
> not pushed. The full native / phone remote-control chain was not rerun. The user authorized
> implementation on 2026-09-16: shared UI control and zh/en copy change; model config and request
> parameters stay as they are.

## Goal and scope

Unify zh/en copy of thought levels, distinguish `minimal` from `low`, add `ultra`, and remove front-end
forced classification that lacks a clear contract. Menu and cyclic switching respect the order declared by
model config instead of guessing strength from names.

Related: [thought-level control spec](../../../ui/chat-thought-level-control.md),
[Todo66 option display formatting](./todo-66-option-map-variable-naming-and-display-formatting.md),
[Todo138 generic reasoning fallback](./todo-138-reasoning-level-ui-and-api-defaults.md). This overrides the
old display mapping and front-end ordering convention; it does not reopen Model Config, default selection
or request mapping decisions.

## Confirmed display mapping

| Raw value                                                                   | zh-CN | English    |
| --------------------------------------------------------------------------- | ----- | ---------- |
| `disabled`, `false`, `no`, `none`, `nothink`, `no-think`, `no_think`, `off` | 关闭  | Off        |
| `enable`, `enabled`, `on`, `true`                                           | 开启  | On         |
| `minimal`                                                                   | 极低  | Minimal    |
| `low`                                                                       | 低    | Low        |
| `medium`                                                                    | 中    | Medium     |
| `high`                                                                      | 高    | High       |
| `xhigh`, `extra-high`, `extra_high`                                         | 极高  | Extra high |
| `max`                                                                       | 最高  | Max        |
| `ultra`                                                                     | 极致  | Ultra      |

- "No thinking" is folded into "关闭 / Off"; only the copy is unified — raw option values are never merged, deleted or rewritten.
- `minimal` is shown separately and no longer shares a name with `low`. `extra-high` / `extra_high` pre-existed and are kept; no other spelling aliases are added.
- Matching keeps the existing trim and lowercase behavior; selection, saving and submission still use the raw value.
- `ultra` only gains display support: the level is not auto-added to models and acceptance of raw `ultra` by every API is not assumed.

## Removed fixed classification and unknown-value fallback

The front-end fixed copy mapping and name-based rank sorting for `light`, `shallow`, `balanced`, `default`,
`normal`, `standard`, `deep`, `maximum`, `very-high`, `very_high` are removed. They remain valid custom
levels: display the source's `entry.name` through the existing generic fallback. Unknown values are handled
the same way: options are not filtered or replaced by the nearest known level. In particular `default` is
no longer interpreted as `medium`.

## Order and interaction

- The model config's level array is the order source; the front end keeps the received order, with no name-rank table and no level guessing from `entry.name`.
- Config should declare low to high: off, minimal, low, medium, high, extra high, max, ultra (minimal before low, ultra after max). This is a convention, not a front-end reorder algorithm, and existing config is not bulk-rewritten here.
- "On" is switch semantics: a two-level model shows "Off -> On" per config, no longer inserted between High and Extra high.
- Dropdown, button cycling and `Ctrl+T` share one source order and return to the first item at the end; changing a display name never changes the current selection.
- The step bar expresses relative position by the actual option order, with off-type at zero strength. Kept: placeholder and zero progress for unselected/invalid values, single valid option read-only, invalid values not submittable.
- Desktop and phone share the display contract; zh/en, light/dark, keyboard and touch are verified; other pages that reuse the component take the change.

## Research basis and compatibility

On 2026-09-16 CLI, protocol projection, history migration, tests and external docs beyond the built-in
config were checked; "absent from built-in config" does not imply "unused externally".

- `extra-high` / `extra_high` are existing xhigh aliases in external tools and user configs, hence kept; `default` restores the default and cannot be fixed to mid.
- "Balanced", "Deep" etc. are common display names in external tools, usually with values medium/high, which only shows the vocabulary exists, not a universal value-equivalence contract.
- `packages/shared/src/model-config.ts` accepts any non-empty, non-duplicate string level (custom names), so the display table cannot narrow the config value domain.
- `ultra` in external tools may carry runtime orchestration semantics; "极致 / Ultra" here is a display decision only and imports no external runtime policy nor changes `reasoningLevel.map`.
- No sufficient basis was found for global forced classification of the other removed words; no claim that they were never used.

Kept: saved selections, raw values, validity checks, Provider/model identity, default level policy and
request parameter mapping. No schema, migration, builtin revision, runtime state or cross-end sync.

## Implementation entries and acceptance (all done)

Main entries: `packages/ui/src/chat-input-toolbar/thoughtLevelOptions.ts`, `ThoughtLevelCycleControl.tsx`,
zh/en locales; V4 composer and other reusing pages checked; config projection in
`packages/ui/src/lib/modelThoughtOption.ts`, `zcodeSessionProjection.ts`.

- [x] Spec updated first; shared-control callers checked (sessions, scheduled/off-peak tasks, Subagent, Repo Wiki); TL-01/02 acceptance items added.
- [x] Tests first: zh/en mapping; minimal and low differ; ultra shown; all off aliases are Off/关闭.
- [x] `extra-high`/`extra_high` kept; the ten removed values and other unknown values show the source name, stay selectable and submit the raw value.
- [x] Explicit custom order: menu and cycling do not reorder; minimal/low, max/ultra, off/on and wrap to first covered.
- [x] Step bar, empty/invalid values, single-option read-only, same-value confirmation; copy normalization never changes the selection or dedupes options.
- [x] Real shared control and Subagent field browser interaction at desktop / touch phone sizes, zh/en, light/dark; scheduled-task etc. callers by targeted unit tests; browser candidate stays pending (not auto-promoted); full native and phone remote control not rerun.
- [x] typecheck, lint, architecture and affected tests pass; diff reviewed.

Implementation notes: the front-end name rank/sort functions were removed; off-copy unified, minimal/ultra
added, both extra-high aliases kept, unknown values fall back to the source name. Off detection reads the
raw value only; the step bar computes progress by the position of non-off items in the source array (so an
off item in the middle does not distort progress). Unknown strings also cover `constructor` / `__proto__`
and never hit mapping-table prototype properties.

## Verification

- 45 targeted tests failed before the change and the browser reproduced `minimal` showing Low; after: level/control/same-value-confirm three files 102 pass, six caller test files 90 pass (192 total).
- `node --test packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs`: eight groups pass (390/1200 x zh/en x Zai Light/Dark) covering the real menu, touch, keyboard selection, production shortcut hook, click cycling and the Subagent field; screenshots/logs in the temporary artifact dir `todo153-thought-level-display`.
- Linux used existing isolated libraries and CJK fonts via `LD_LIBRARY_PATH` / `FONTCONFIG_FILE` (no product environment change). Early fixture/keyboard-timing issues in verification were fixed; screenshots wait for the entrance animation to end.
- `pnpm typecheck`, `pnpm lint` (47 existing warnings, 0 errors), `pnpm architecture:check --changed` pass; format, link and diff checks pass. Full Electron, phone reconnect and real-provider requests were not run (not changed); browser evidence is not formal desktop E2E admission.
