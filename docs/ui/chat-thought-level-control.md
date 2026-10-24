# Chat Thought Level Control

## Goal

The thought level control in the composer toolbar shows the current thinking level text directly, so users can see the current level without opening an extra popover.

## Current implementation

- `packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx`
  - The control defaults to select-menu interaction: a click expands the list of thought levels supported by the current model.
  - The old click-to-cycle interaction is kept as the `interactionMode="cycle"` parameter, so it can be restored where faster switching is needed.
  - The trigger shows a brain icon, the current level text and a vertical level bar; the text is the localized display name of the current `thought_level` option.
  - When the level text changes a light vertical scroll animation is used; under system reduced motion it is replaced statically.
  - Desktop width shows the current level text; narrow screens collapse the text via the toolbar's `labelVisibilityClassName`, so mobile Web does not squeeze the input.
  - The vertical level progress bar shows only between the composer's `sm` and `xl`: below `sm` the bar is hidden and only the brain icon remains; from `xl` the bar is hidden as the level text appears.
  - The V4 composer hides the dropdown arrow below `xl` but keeps the brain icon and the level-bar responsive rule above; shrinking below `sm`, the trigger becomes a square icon button. The arrow returns from `xl`.
  - The tooltip switches on whether the level text is shown in the button: when the text is visible it shows the function name, `Thought Level` in English and "思考级别" in Chinese; when the text is collapsed because the input is narrow, the tooltip title becomes the current level text.
  - By default a click expands the select menu; in restored `cycle` mode a click only cycles the level and does not pop up a tooltip.
  - `Ctrl+T` always keeps the quick-switch semantic: it moves to the next thought level in the current display order without opening the select menu.
  - `aria-label` keeps using the current level text so screen readers read the current value directly.

## Level text and order (Todo153)

The model config provides the selectable levels and their order. The control only projects for display and never re-sorts by value or name; the dropdown, click cycle and `Ctrl+T` use the same configured order, and the last item cycles to the first. The config declares levels from low to high, with minimal before low and ultra after max; "on" is a switch semantic and is not fixed between high and extra high.

| Raw value                                                          | Chinese | English    |
| ------------------------------------------------------------------ | ------- | ---------- |
| disabled / false / no / none / nothink / no-think / no_think / off | 关闭    | Off        |
| enable / enabled / on / true                                       | 开启    | On         |
| minimal                                                            | 极低    | Minimal    |
| low                                                                | 低      | Low        |
| medium                                                             | 中      | Medium     |
| high                                                               | 高      | High       |
| xhigh / extra-high / extra_high                                    | 极高    | Extra high |
| max                                                                | 最高    | Max        |
| ultra                                                              | 极致    | Ultra      |

Text matching trims the value and lowercases it; selection and submission keep the raw value and same-name options are not merged. extra-high / extra_high are reserved aliases and no other spellings are added.

light, shallow, balanced, default, normal, standard, deep, maximum, very-high and very_high are no longer fixedly categorized; like other unknown values they show the name provided by the source and remain selectable. Strength or off state is not guessed from the name, and no level is added or config rewritten automatically.

The level bar treats only off-class values as zero strength; non-off items increase by their position in the sequence of non-off items in the config. Even if an off item is not first, an off item after it is not subtracted so zero progress is never shown wrongly. An unselected / invalid value keeps zero progress and a placeholder; a single valid level is read-only.

Acceptance covers Chinese and English text, fallback for unknown names, raw-value submission, custom order, consistency across menu / keyboard / touch / cycle, the level bar, and empty / invalid / single-level boundaries. Desktop and mobile sizes and light/dark themes use the shared control; automation tasks and Subagent reuse the same rules.

## Compatibility boundary

- Todo153 adjusts UI display and removes the frontend name sorting, keeping the source order; it does not change currentValue writes, the workspace default thinking level, request parameter mapping or the task realtime chain.
- Desktop and Web share one React component; mobile is affected only by responsive text visibility and remote replayable semantics are unchanged.
- `Ctrl+T` does not depend on the trigger click, so the default select interaction does not override the quick-switch shortcut.
