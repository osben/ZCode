# Chat Empty-State Time-based Greeting

In the draft state for a new conversation, the empty-state heading no longer shows the workspace or project name. Instead, it displays a greeting based on the user's local time. This copy reduces the chance that users think a task has already been created and avoids tying the entry point to a particular project.

## Behavior

- Select the copy using the current local hour in the user's device browser/Renderer; do not use the server, workspace, or remote host timezone.
- Time ranges:
  - `05:00-08:59`: Early morning
  - `09:00-11:59`: Morning
  - `12:00-13:59`: Noon
  - `14:00-17:59`: Afternoon
  - `18:00-22:59`: Evening
  - `23:00-04:59`: Late night
- Copy must come from the i18n locale in `packages/ui`; do not hard-code user-visible strings in the component.
- Do not insert workspace/project names in the heading, which could cause confusion with the current workspace, remote `workspaceIdentity`, or mobile remote-control context.
- The noon greeting should suggest taking a break instead of emphasizing continuing work.
- The afternoon greeting should have a relaxed tone suggesting that the assistant can take it from here; avoid internet slang such as “slacking off” that could undermine professionalism in a work context.
- The late-night greeting should briefly remind users to take care of themselves without assuming they are already tired.

## English Copy

Preserve the intent for each time of day and use natural local phrasing rather than translating Chinese particles word for word.

| Time period   | Copy                                         |
| ------------- | -------------------------------------------- |
| Early morning | Morning, ready when you are                  |
| Morning       | Morning, how can I help?                     |
| Noon          | Noon break?                                  |
| Afternoon     | Good afternoon! Leave the rest to me.        |
| Evening       | Evening, nice work today                     |
| Late night    | It's late—remember to take care of yourself. |

## Simplified Chinese Copy Requirements (English Glosses)

The Simplified Chinese strings are defined in `packages/ui/src/i18n/locales/zh-CN.ts`. These English glosses preserve their meanings; they are references, not literal UI copy.

| Time period   | Intended meaning of the Simplified Chinese copy             |
| ------------- | ----------------------------------------------------------- |
| Early morning | Good morning, a new day is beginning.                       |
| Morning       | Good morning, is there anything you'd like me to help with? |
| Noon          | Hi, it's noon—would you like to take a break first?         |
| Afternoon     | Good afternoon, I'll take it from here.                     |
| Evening       | Good evening, you've worked hard today.                     |
| Late night    | It's late—remember to take good care of yourself.           |

## Visuals

- Use the UI's default sans-serif font for the heading; do not use `font-serif`.
- Keep the existing larger heading hierarchy on desktop and the compact hierarchy in the mobile remote-control draft state.
- The copy must accommodate length differences between Chinese and English; do not rely on project-name concatenation or a fixed width.
- For the empty-state logo, continue using the inline outline graphic in light theme and `packages/ui/src/assets/Z.svg` in dark theme. Render them mutually exclusively through theme classes so they do not both occupy space or appear to screen readers. Keep the bottom fade mask and `opacity-70` on the light outline. The dark asset includes its own gradient and opacity; do not apply another shared mask or opacity.

## Container widening and narrowing

The desktop heading keeps the existing 20-30px fitting range, measured from the heading's own available width and the original copy width; mobile remote keeps 20px. At the minimum size long copy wraps naturally, with no clipping or ellipsis. Re-measure when language, profession mode or time period changes.

The heading font size belongs only to the DOM layout projection. When the container width changes, fitting must finish before paint. The heading must not first wrap at the old size, grow taller and push the input down, and shrink back in a later frame. No delay or extra size animation may hide that intermediate state.

```text
sidebar toggle / drag -> container width changes -> same layout notification measures and updates font size -> paint
language / period / profession mode -> React commits copy -> layout effect measures -> paint
```

## Regression acceptance

| ID    | Scenario                                                                                                                | Assertion                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DGJ01 | Real desktop empty draft, right panel expand, collapse and drag; zh/en, light/dark                                      | The heading fits the current width throughout; a heading that could fit on one line at the fitted size never briefly becomes two lines; the input shows no extra downward shift and rebound |
| DGJ02 | Real heading component, container narrowed directly, continuously widened/narrowed, quickly reversed, language switched | Pre-paint layout sampling shows no extra line height from an old font size; the size is restored when width is restored; no ResizeObserver loop error                                       |
| DGJ03 | Mobile Web compact heading, 390px and narrower, zh/en, light/dark                                                       | Stays 20px; long copy wraps naturally, all text visible, no horizontal overflow                                                                                                             |

DGJ01 uses `ui-shell/composer/draft-greeting-layout.test.ts`; DGJ02/03 use `packages/ui/test/browser/manual-review/pending/draft-greeting-layout.test.mjs`. Run evidence and platform limits are recorded in the [Side Pane coverage matrix](../testing/side-pane-tabs-e2e-coverage-matrix.md).
