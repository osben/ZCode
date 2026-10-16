# Todo125: Model Settings Help Popovers and Finalized Copy

> In progress on 2026-09-11: write the Chinese and English locale strings verbatim according to section 3; reuse the existing Popover for the nine help entries. Smart-configuration placement follows Todo131; do not add a help icon to the ID.

> Later layout decision (2026-09-11): [Todo131](todo-131-model-settings-smart-config-placement-and-restore.md) moves smart configuration and its question mark to the right of the Model ID container, superseding this document's “remains at the bottom” placement constraint. Help copy and question-mark interaction do not change; no question mark was added to Model ID. Todo131 is pending and does not mean the UI has moved.

> Status: product implementation, focused verification, and review complete; final acceptance of the entire Goal batch remained pending. Implementation was authorized on 2026-09-11.
>
> Date: 2026-09-11

## 1. Background and Implementation Constraints

The user wanted explanations for smart configuration and individual settings in the model-settings page. The existing “Smart configuration” text used a native `title`, which was easy to miss and whose appearance timing was browser-controlled. This Todo adds an explicit question-mark entry for help.

**Implement the final decisions from this round of item-by-item discussion exactly. Do not improvise, make incidental changes, or redesign. Section 3 is the finalized Chinese copy and must be used verbatim; do not polish it, add/remove warnings, examples, or technical details.** Translate the English version with the same meaning; do not expand promises or restrictions. If the copy conflicts with actual behavior, provide specific evidence and discuss it with the user first; do not silently change copy or business behavior to remove the conflict.

- Add only the question marks and help popovers. Keep the existing layout, field headings, options, and grouping; smart configuration remains at the existing bottom position.
- Do not change config values, defaults, smart/manual modes, overlays/inheritance, save/cancel behavior, model capabilities, or model-selection behavior.
- Do not change schemas, protocols, persistence files, database tables, built-in recommended configuration, refresh, or distribution mechanisms. Copy describes existing features and does not authorize rebuilding them.
- Do not add confirmation dialogs, extra post-switch warnings, tutorials, examples, links, or other unapproved product elements.
- The explicit decisions in this Todo supersede earlier sketches and suggestions in the conversation. Discuss out-of-scope needs first; do not use this task to fix unrelated issues.

## 2. Confirmed Placement and Interaction

- Add a question-mark icon after each field or group heading listed in section 3, except Model ID. The `ⓘ` in this document marks where the help entry goes; use a question-mark icon in the UI.
- When a heading has multiple options beneath it, use one question mark after the heading and explain each option in the same help content; do not add repeated question marks beside individual options.
- Do not add a question mark or help description to Model ID.
- On desktop, show the help immediately on pointer hover; do not use the delayed native `title` tooltip. On mobile, show it when the question mark is tapped.
- Support keyboard focus to view help. Clicking the question mark only opens the help; it must not toggle the adjacent switch/option or submit the form.
- Use existing design-system and component styles. Support desktop, mobile Web, Chinese/English, and light/dark themes. Do not move existing controls or redesign the form layout.
- Replace the existing smart-configuration `title` with the new help entry so two different copies are not shown at once.

```text
Existing field/group heading + question mark
                       |
              hover / keyboard focus / mobile tap
                       |
                show that heading's help
                       |
       affects help visibility only; does not change the config draft

At the bottom of the form: existing smart-configuration toggle + existing text + question mark
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

- Do not move the smart-configuration toggle; the earlier sketch showing it at the top was corrected.
- Model ID is the explicit exception to “add a question mark to every heading.”
- Do not mention file-size, page-count, or other attachment limits under Input Types; do not add clarifications such as “these are ZCode's limits.”
- Reasoning levels remain ordered low to high. The user explicitly confirmed that the earlier “high to low” wording was a slip; do not reverse display, storage, or highest-level selection logic.
- Do not say that reasoning-level “names and quantity are customizable.” Do not add examples, conversion diagrams, or extra interface requirements to reasoning parameter mapping.
- Do not mechanically add “Do not exceed...” or similar warnings to every help item. Keep only the specific sentences approved in section 3.
- Use “model” consistently, not “model service.” Use Base URL and API format wording consistent with Settings for smart configuration.
- Do not promise “always the most accurate” or add behavior explanations about disabling/re-enabling smart configuration; this task does not change that behavior.
- Do not add audio, tool-call, or other options that are not on the current page.

## 5. Implementation Entry Points and Acceptance

Use these files as references, verifying the latest baseline when implementing:

- `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx`: form headings and footer layout.
- `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialogActions.tsx`: smart-configuration copy and existing `title`.
- `packages/ui/src/settings/model-provider-section/ProviderModelSettingsGroups.tsx`: reasoning settings and advanced settings.
- `packages/ui/src/ControlHintTooltip.tsx` and existing Tooltip/Popover components: reuse current style and components; do not globally change other tooltip behavior.
- `packages/ui/src/i18n/locales/zh-CN.ts`, `en-US.ts`: finalized copy and equivalent English translation.

After implementation is authorized, read `DESIGN.md` first and follow repository spec-first, test-first, and architecture-gate rules. This Todo is the implementation specification for this item in Working Memory.

- [ ] Check Chinese copy in section 3 verbatim; English has no omissions or added meaning.
- [ ] Model ID has no help entry; each of the other nine headings has exactly one. Do not repeat question marks for options within a group; smart-configuration position is unchanged.
- [ ] E2E verifies immediate desktop hover, keyboard access, and mobile tap; popovers close and switching between help entries works without duplicate native tooltips.
- [ ] Clicking help does not trigger a toggle, modify the draft, or save; existing form edit/save/cancel behavior is unchanged.
- [ ] Light/dark themes, Chinese/English, desktop, and mobile sizes all show the full text without clipping in the dialog scroll area or overflowing the viewport.
- [ ] Complete affected checks, `pnpm typecheck`, `pnpm lint`, and the relevant E2E. Record results honestly; unrun checks are not passing.

## 6. Delivered Result for This Item

Implemented nine question marks, excluding Model ID; smart-configuration placement follows Todo131. Reused existing Popover/Button and locale files, rendering only finalized copy with bolding, inline code, and lists. HTML and user input are not accepted. The Chinese copy was unit-tested verbatim and English was reviewed for equivalent meaning; the old native `title` copy was removed.

Real Hook/component browser checks verified desktop hover, keyboard focus, mobile tap, Escape-to-close, and switching help entries. Each popover was checked to fit in the viewport and not modify a draft or write settings. 390px Chinese light / 1200px English dark passed. Linux lacked Chinese glyph fonts, so **Chinese glyph rendering was not visually verified**. No new model capabilities, config, or execution logic were added; shared-host/message flow is unchanged. Root typecheck, lint (0 errors/41 warnings), architecture check (0 violations), and 60 related unit tests passed. Browser interaction was not real mobile Host integration; final batch/device limits remain in the execution ledger.

# Final Associated Regression Addition

The help button must not be nested inside an input field's label. Associate the heading with the input using `htmlFor`/ID and make the help button a separate control on the same row, so it does not replace the input label or focus target. A group heading for multiple reasoning levels is not a label for one input. This correction does not change help copy, state, or save behavior.
