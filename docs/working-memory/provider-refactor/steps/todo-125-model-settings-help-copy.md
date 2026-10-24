# Todo125: Model Settings Help Popovers and Finalized Copy

> Status: product implementation, focused verification and review complete (implementation authorized 2026-09-11); final
> acceptance of the entire Goal batch was pending. Smart-configuration placement follows
> [Todo131](todo-131-model-settings-smart-config-placement-and-restore.md), which moves smart configuration and its
> question mark to the right of the Model ID container (superseding the "remains at the bottom" constraint here); help
> copy and question-mark interaction are unchanged and Model ID gets no question mark. Todo131 was pending and does not
> mean the UI had moved.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-125-model-settings-help-copy.md`

## 1. Background and Implementation Constraints

The model-settings page needed explanations for smart configuration and individual settings. The existing "Smart
configuration" text used a native `title` (easy to miss, browser-controlled timing). This Todo adds an explicit
question-mark entry for help.

**Implement the final decisions exactly; section 3 is the finalized Chinese copy and is used verbatim (no polishing, no
added/removed warnings, examples or technical details).** The English translation keeps the same meaning without expanding
promises or restrictions. If copy conflicts with actual behavior, give specific evidence and discuss with the user first;
never silently change copy or behavior.

- Add only the question marks and help popovers; keep the existing layout, field headings, options and grouping.
- No change to config values, defaults, smart/manual modes, overlays/inheritance, save/cancel, model capabilities or model
  selection; no change to schemas, protocols, persistence files, database tables, built-in recommended configuration,
  refresh or distribution; copy describes existing features.
- No confirmation dialogs, extra post-switch warnings, tutorials, examples, links or other unapproved elements; out-of-scope
  needs are discussed first.

## 2. Placement and Interaction

- A question-mark icon follows each field or group heading listed in section 3, except Model ID (`ⓘ` marks the position).
  A heading with several options below it gets one question mark whose content explains each option; no repeated marks per option.
- No question mark or help description for Model ID.
- Desktop: shown immediately on pointer hover (not the delayed native `title`); mobile: shown on tap; keyboard focus also
  shows it. Clicking the mark only opens the help; it must not toggle the adjacent switch/option or submit the form.
- Existing design-system and component styles; desktop, mobile Web, Chinese/English, light/dark; no moving of controls or
  form redesign. The existing smart-configuration `title` is replaced by the help entry so two copies never show at once.

```text
existing field/group heading + question mark -> hover / keyboard focus / mobile tap -> that heading's help
  (affects help visibility only; the config draft is unchanged)
bottom of the form: existing smart-configuration toggle + existing text + question mark
```

## 3. Final Copy (Use Verbatim in Chinese; English Translation Must Match)

### Model ID

No question mark.

### Context Window ⓘ

> The context capacity the model can process at one time, measured in Tokens. ZCode manages context based on this value.
> Do not exceed the model's actual limit.

### Maximum Output Tokens ⓘ

> The maximum number of Tokens the model may generate in a single request.
> Do not exceed the model's actual limit.

### Input Types ⓘ

> Set the types of content the model can receive:
>
> - **Text**: receives text content; required.
> - **Image**: receives image content.
> - **Video**: receives video content.
> - **PDF**: receives PDF documents directly.

### Output Types ⓘ

> The content types that the model generates in replies. Other options besides text are not currently supported.

### Model Capabilities ⓘ

> - **Structured output**: supports constraining the fields, types, and structure of model output with JSON Schema.
> - **Native web search**: supports the web-search capability built into the model API.
> - **System messages in conversations**: supports inserting system instructions midway through a conversation.
>
> Do not select capabilities the model does not support.

### Reasoning Levels (Low to High) ⓘ

> Set the reasoning levels available in chat. **They must be ordered from lowest to highest reasoning strength.**
> Do not configure reasoning levels the model does not support.

### Reasoning Parameter Mapping ⓘ

> Use a CEL expression to map the current reasoning level `reasoningLevel` to request fields for the model API. The returned JSON object is merged into the actual request body before sending.

### Advanced Settings ⓘ

> **MFJS Tool Schema**: Enables Moonshot Flavored JSON Schema compatibility processing, commonly used by Moonshot's Kimi model APIs. Enable it only when the model API requires this format.

### Smart Configuration ⓘ

> Intelligently matches recommended settings based on the model ID, Base URL, and API format. ZCode continuously updates the recommendations and syncs them to you automatically.
> If you manually modify a setting, that setting becomes manually managed and no longer follows recommendation updates; smart configuration continues to manage the other settings.

## 4. Withdrawn or Clarified Suggestions (Do Not Reintroduce)

- The smart-configuration toggle is not moved to the top (an earlier sketch was corrected); Model ID is the explicit
  exception to "a question mark on every heading".
- No file-size, page-count or other attachment limits under Input Types and no "these are ZCode's limits" clarifications.
- Reasoning levels stay ordered low to high (the earlier "high to low" was a slip); display, storage and highest-level
  selection logic are not reversed. No "names and quantity are customizable" for reasoning levels and no examples,
  conversion diagrams or extra interface requirements for reasoning parameter mapping.
- No mechanical "Do not exceed..." on every item (only the sentences approved in section 3); "model" is used consistently,
  not "model service"; smart configuration uses wording consistent with Settings for Base URL and API format.
- No promise of "always the most accurate" and no behavior explanation about disabling/re-enabling smart configuration; no
  audio, tool-call or other options not on the current page.

## 5. Implementation Entry Points and Acceptance

Entries (verify the latest baseline): `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx`
(form headings and footer), `ProviderModelMetadataDialogActions.tsx` (smart-configuration copy and old `title`),
`ProviderModelSettingsGroups.tsx` (reasoning and advanced settings), `packages/ui/src/ControlHintTooltip.tsx` and existing
Tooltip/Popover components (reuse; do not change other tooltips globally), `packages/ui/src/i18n/locales/zh-CN.ts`,
`en-US.ts`. Read `DESIGN.md` first and follow spec-first, test-first and architecture-gate rules.

Acceptance: Chinese copy matches section 3 verbatim and English has no omission or added meaning; Model ID has no help
entry and each of the other nine headings has exactly one (no repeated marks per option, smart-configuration position
unchanged); E2E verifies immediate desktop hover, keyboard access and mobile tap, popovers close and switching between help
entries works without duplicate native tooltips; clicking help triggers no toggle, draft change or save and existing form
edit/save/cancel is unchanged; light/dark, Chinese/English, desktop and mobile sizes show the full text without clipping
in the dialog scroll area or overflowing the viewport; affected checks, `pnpm typecheck`, `pnpm lint` and relevant E2E
recorded honestly (unrun is not passing).

## 6. Delivered Result

Nine question marks (excluding Model ID) were implemented, smart-configuration placement following Todo131. Existing
Popover/Button and locale files were reused, rendering only the finalized copy with bold, inline code and lists; HTML and
user input are not accepted. Chinese copy was unit-tested verbatim and English reviewed for equivalent meaning; the old
native `title` copy was removed. Real Hook/component browser checks verified desktop hover, keyboard focus, mobile tap,
Escape-to-close and switching help entries; each popover fits the viewport and modifies no draft or settings; 390px Chinese
light / 1200px English dark passed. Linux lacked Chinese glyph fonts, so **Chinese glyph rendering was not visually
verified**. No new model capability, config or execution logic; shared-host/message flow unchanged. Root typecheck, lint
(0 errors / 41 warnings), architecture check (0 violations) and 60 related unit tests passed. Browser interaction was not
real mobile Host integration; final batch/device limits are in the execution ledger.

Final associated regression: the help button must not be nested inside an input's label. The heading is associated with the
input by `htmlFor`/ID and the help button is a separate control on the same row, so it does not replace the input label or
focus target; a group heading for multiple reasoning levels is not a label for one input. Help copy, state and save
behavior are unchanged.
