# Todo 31: Model Config Popup Input Control Consolidation

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Provider settings page real experience feedback
>
> Related tasks: [`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md),
> [`Todo 29`](./todo-29-model-config-resolution-and-idle-trigger-closure.md)

## 1. Problem

Model config popup JSON fields initially used both outer field cards and inner `Textarea`, forming double borders; after deleting outer cards,
shared `Textarea`'s weak background and stroke nearly invisible in dark popup, actual controls degraded to bare JSON. Existing tests only verified
outer cards deleted, did not prove retained text boxes consistent and distinguishable from normal input fields.

Technical inputs also inherited browser's natural language spell check, macOS/Electron displayed wrong red spelling dashed lines under Model ID.
Meanwhile, model popup's Model ID, context window, and max output Token treated any Enter directly as save, without distinguishing
Chinese input method candidate confirmation Enter.

```text
IME composing
      |
      | Enter
      v
Candidate text committed + onCommit()
      |
      v
Popup unexpectedly saves
```

## 2. JSON Single-Layer Text Box

Each JSON field keeps only one layer of normal multi-line text box:

```text
Field title
└─ Textarea (sole background and stroke)
```

- No cards, extra background, or second-layer stroke added;
- Background color, stroke color, Focus state same as normal text boxes, does not use Checkbox's Personal Override emphasis style;
- No Personal value: Effective JSON continues as placeholder; with Personal value: displays normal input text;
- Fixed height, content scrolls within text box when exceeding, height cannot be resized by dragging;
- Retains monospace font and JSON line wrapping, no new read-only Effective Preview;
- JSON invalid: reuses normal input error state and field-level error text.

## 3. Technical Input Behavior

Model ID, Provider technical fields, URL, API Key, and JSON do not participate in natural language assisted input:

- Disable spell check;
- Disable auto-correct and auto-capitalization;
- Disable browser auto-complete;
- Do not change password visibility, numeric keyboard, placeholder, or save semantics.

## 4. IME-safe Enter

All "Enter means save/end editing" Provider settings inputs uniformly reuse existing IME composition judgment:

```text
Enter
├─ composition active
│  └─ Only confirmed by input method; do not preventDefault, do not save, do not blur
└─ ordinary keydown
   └─ Execute original save or blur behavior
```

- Read both component-maintained `compositionstart/compositionend` state and native `isComposing` simultaneously;
- Model popup's Model ID, context window, max output Token use same judgment;
- Provider name, Base URL, API Key existing Enter-to-save entries uniformly use same helper;
- Enter in JSON Textarea always inputs newline, does not carry save;
- Explicit save button, normal Enter, blur, and 1200ms idle save existing behavior unchanged.

## 5. Tests and Completion Criteria

1. JSON fields still two fixed-height `Textarea`, no outer cards, text boxes use normal input styles;
2. Effective JSON as placeholder, Personal JSON as value;
3. Model ID and JSON technical inputs disable spell check and auto-correct;
4. `compositionstart -> Enter` does not call save, candidate confirmation not blocked;
5. `compositionend -> normal Enter` saves only once;
6. All Provider page Enter-to-save technical inputs obey same IME boundary;
7. JSON Enter does not trigger save;
8. Chinese/English, light/dark themes, and keyboard operations remain usable;
9. UI directed tests, typecheck, lint, format check, and `git diff --check` pass;
10. Update implementation results and submit Conventional Commit upon completion.

This Todo does not modify Model Config Rule content, Overlay order, Registry, account plan, or model runtime capabilities.

## 6. Implementation Results

- JSON fields consolidated to single-layer, fixed-height normal `Textarea`, background, stroke, and Focus state same as normal
  `Input`;
- Personal JSON still as `value`, Effective JSON still as `placeholder`, no new preview state introduced;
- Provider name, Base URL, API Key, Model ID, numeric fields, and JSON uniformly disable spell check and auto-write;
- Provider Base URL/API Key and model popup Enter save both use local composition state and
  native `isComposing` simultaneously, Chinese candidate confirmation no longer causes blur or save;
- Added regression tests first proving old implementation wrongly saves, then verifying normal Enter after composition ends saves only once.

Verification results:

- Provider/Model UI directed tests: 57 passed;
- affected unit tests upgraded to full unit tests: 12,477 passed, 25 skipped;
- `pnpm typecheck` passed;
- `pnpm lint` passed (0 error, 34 pre-existing warnings);
- This round's modified file format check and `git diff --check` passed.

Workspace-wide `pnpm fmt:check` still blocked by pre-existing invalid HTML in Electron docs and
`apps/zcode-cli/tests/gb2312.js` read issues; this round's files independently passed `oxfmt --check`.
