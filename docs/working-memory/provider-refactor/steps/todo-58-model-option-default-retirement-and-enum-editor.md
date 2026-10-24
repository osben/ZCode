# Todo 58: Model Option Default Retirement and Enum Editor Closeout

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promoted items moved to
> [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules here; historical
> evidence is retained and the transfer does not mean the tests passed.

> Status: implementation complete; graphical E2E awaits a usable display environment
>
> Date: 2026-09-01
>
> Prerequisite: Todo 42 / Bugfix 08 fixed Reasoning levels ordered low to high and auxiliary calls using
> `values[0]`; Todo 54 moved each Option's mapping to the raw Request Body into the Option Spec itself. This Todo does
> not change the Option Map, Provider Template, Access, Account, model membership or request auth design.
>
> Later decision: the optionality of the Reasoning Spec and the hidden-Mapping conclusion are overridden by Todo 60:
> every Effective Model has a complete Reasoning Spec, and Settings exposes the Reasoning Mapping.

## 1. Goal

Delete every `default` in the Model Option Spec so the Option Spec describes only the legal domain, order, cap and
request mapping; the concrete execution value must be supplied explicitly by model selection or the execution
caller.

```text
Model Option Spec: enum -> legal values + order + map; limit -> hard cap + map
Model Selection / Model Request: the Option value actually used this time
```

The order of the Reasoning Enum is the sole source of the defaulting policy: `values[0]` is the lowest public level
(explicit low-cost auxiliary calls); `values.at(-1)` is the highest public level (when an ordinary selection really
has no value). No `reasoningLevelPolicy`, `defaultPolicy`, `preferredValue`, `initialValue` or other Option DTO.

## 2. Problem and root cause

The structure mixed "what the model supports" with "what to choose when the caller did not decide":

```ts
interface EnumOptionSpec {
  type: "enum";
  values: readonly string[];
  default: string;
  map: string;
}
interface LimitOptionSpec {
  type: "limit";
  max: number;
  default: number;
  map: string;
}
```

`default` was re-materialized at several layers (Config / Built-in Rule; Model constructor; Adapter `bindModel`;
Runner / Bootstrap fallback; UI / Bot fallback for a missing reasoning). These consumers prove incomplete Options
were allowed to flow, not that `default` is a static model fact. `maxOutputTokens.default` is not a hard model
capability (the Agent needs `max`; the output budget is an execution choice). `reasoningLevel.default` should not
take part for existing Sessions, recent selections or explicit model switches, which save a concrete level. When an
ordinary entry truly lacks reasoning, use the last item of the ordered Enum; low-cost auxiliary calls keep taking
the first. The Provider model settings page edited the Reasoning Enum as JSON and bound the "max output Token" input
to `default`, not accurately expressing the config semantics.

### 2.1 Max Output false error confirmed on the Air official build

On 2026-09-01 the official `3.10.1` build on a MacBook Air reproduced stably: add a model to a Personal Provider;
enter a model ID matching no specific numeric cap Rule (e.g. `claude`); set context window `10000`; enter the valid
positive integer `1000` for "max output Token"; saving still said "max output Token must be a positive integer".
Not an input format, Air local config or model API error. The real chain: the UI "max output Token" = 1000 was
interpreted as a Personal default; the submission logic required an inherited `maxOutputTokens.max` to exist; when
absent `resolvedMaxOutputSpec = null` and the error was classified as `maxOutputTokens` with the misleading text. A
general API Rule can provide only a `map`, so with no specific model Rule the Inherited Option Spec may have no
`max`; `1000` had passed positive-integer parsing, the real failure was the old implementation being unable to build
its own Limit Spec without an inherited `max`. Root causes: wrong data semantics (the input named "max output" saved
`default` and treated `max` as a required inherited precondition) and wrong error classification (missing structure
and invalid input format collapsed into the same `maxOutputTokens` field error). No compatibility branch for the old
`default` model: after deleting `default`, the input edits `max` directly, a valid positive integer forms a Personal
`max` Overlay on its own, and only when empty with no `max` in any inherited layer is the Effective Model Config
incomplete.

## 3. Confirmed contract

### 3.1 Option Spec

```ts
interface EnumOptionSpecConfigInput {
  type?: "enum" | null;
  values?: readonly string[] | null;
  map?: string | null;
}
interface EnumOptionSpec {
  type: "enum";
  /** ordered by semantic strength low to high */ values: readonly string[];
  map: string;
}
interface LimitOptionSpecConfigInput {
  type?: "limit" | null;
  max?: number | null;
  map?: string | null;
}
interface LimitOptionSpec {
  type: "limit";
  max: number;
  map: string;
}
```

- Enum `values` non-empty, deduplicated, ordered low to high; the client never guesses strength from concrete
  strings. Limit `max` is a valid positive integer and the model's hard cap.
- `map` still reads this Effective Option value and produces the raw Request Body JSON Merge Patch.
- Personal Rule keeps leaf Overlay over `type / values / max / map`; `values` replaces as one whole array leaf, no
  per-item merge. Effective Model Config no longer requires or exposes any Option `default`.

### 3.2 Reasoning selection

Caller provides a valid `reasoningLevel`: used as is. Caller provides none and the model has a Reasoning Spec: an
ordinary selection fills `values.at(-1)`. Explicit low-cost auxiliary call: explicitly `values[0]`. Caller provides
an invalid `reasoningLevel`: error, no silent replacement. A model without reasoning capability uses a complete Spec
with `values=["disabled"]`, `map="{}"`.

The ordinary default fill happens exactly once at the standard Model Selection resolution boundary; afterwards
`preferredSelection`, recent selection, Session Selection and Active Model all carry a concrete reasoning, and UI,
Service, Model or Adapter must not fall back again. `resolveInitialModelSelection`: a complete valid configured
preferred selection is used as is; a configured preferred selection missing reasoning while the target model
supports it gets `values.at(-1)`; Registry fallback choosing the first visible model also fills `values.at(-1)` when
the model supports reasoning; an explicit but unsupported reasoning makes the configured selection invalid (not
masked by the highest level); a model with no reasoning uses the sole `disabled` level and an empty Patch — no
Effective Model lacks a Reasoning Spec. Recent selections and UI model switches become complete selections: an old
sparse recent selection entering the current View is completed by the same rule before use and re-persisted; when
the user picks a model the Reasoning selector gets a concrete legal value synchronously (the highest level without
history); an existing Session inherits and freezes its own concrete reasoning and does not drift with Registry or
Built-in updates.

### 3.3 Max Output

`Model Option Spec.max` is the model hard cap; the Selection-bound value or this Model Request's
`maxOutputTokens` is the execution budget. Delete `maxOutputTokens.default` and all code that materializes request
values from it. Before entering the Model Executor a legal `maxOutputTokens` with `0 < value <= max` must exist: it
may come from the already bound Selection Options or be explicitly provided by this request; with neither, fail
before network I/O. An explicit Request value still overrides the bound Selection value. The Adapter only consumes
complete, validated Effective Options and does not decide the budget, clamp or fall back to `max`. `max` is not an
implicit request value; `maxOutputTokens = max` holds only when the caller explicitly chose it.

### 3.4 Active Model and execution boundary

Complete Model Selection -> ModelFactory -> Active Model (optionSpecs: domain / max / map; bound options: values the
Selection made explicit) -> Model Request makes the remaining execution values explicit -> `prepareRequest`
completeness and range validation -> Adapter / Option Map / Request Signing. Active Model keeps freezing Provider,
Model Config, Option Specs and already bound Selection Options; Registry updates do not modify an already-created
Model. `Model.prepareRequest()` is the final completeness chokepoint before the Executor (no pushing missing Options
to the SDK, network layer or Provider server). `ModelExecutor` receives only complete Effective Options. Option Map
order, the raw Request Body observation point and the pre-signing application order stay as in Todo 54.

## 4. Enum Option Spec GUI

### 4.1 Target shape

A compact sortable tag editor replaces the Reasoning Option Spec JSON: label "Reasoning levels (low to high)" and
tags like `[ low ] [ medium ] [ high ] [ max ] [+]`. No repeated "lowest/highest/default" captions; "low to high"
fully expresses the order contract.

### 4.2 Interaction

- Each tag shows one raw Enum string; the whole tag is draggable and the drag result is the saved `values`; click or
  keyboard activation enters plain text editing; each editable tag has a delete action; `+` adds a new value at the
  end and focuses it.
- Blank and duplicate values are forbidden, with in-place errors; an invalid array cannot be saved; at least one
  value must remain (the last value cannot be deleted into an empty array).
- While dragging, text selection is disabled; after drop the optimistic order stays directly (no snap back then jump).
- Keyboard supports focus, edit, commit, cancel and reordering (not mouse-only).
- Desktop stays a compact single row; wraps naturally when space is short with no horizontal page scroll; Web and
  phone reuse the same behavior with touch targets meeting the existing Design size constraints; light/dark themes,
  Chinese and English use existing Tokens and i18n.

### 4.3 Overlay and draft

The GUI shows the Effective `values`; the local draft records only the user-modified Personal `values` Overlay (an
unmodified inherited array is not copied into the Personal Rule). After modification the existing Personal Override
saturated border style is used (no "default/modified" text). "Restore all defaults" clears the Personal `values`
Overlay and shows inherited values again. The hidden `map` must be kept unchanged — editing `values` must not
overwrite or clear it. Cancelling the dialog submits no draft; saving still goes through the existing revision
validation and atomic Personal Model Rule save.

### 4.4 Max Output GUI

The "max output Token" input now edits `optionSpecs.maxOutputTokens.max`: value/placeholder use inherited and
Personal `max`, never reading or saving `default`; a valid positive integer builds a Personal `max` by itself (no
requirement that Inherited Config already has `max`); clearing deletes the Personal `max` Overlay and restores the
inherited value, and if there is still no `max` the Effective Model Config is incomplete (not disguised as a number
format error). Only non-numeric, non-integer or `<= 0` shows "max output Token must be a positive integer". No "this
call's output Token" or execution budget setting is added to the Model Config page.

### 4.5 Dialog feedback banner

The dialog had two inconsistent feedbacks: a full green banner under the content for "default config matched" and one
red line at the end of the scroll content for draft validation failure. Closed into one in-dialog feedback component
with a fixed slot: scrollable config content -> Dialog Feedback Slot (success: green semantic color + checkmark +
message; error: red semantic color + error icon + message) -> Restore defaults / Cancel / Save. Requirements:
success and failure reuse the same container structure, radius, border, spacing, font size and icon size and switch
only semantic color, icon and text; Design Tokens, no hardcoded colors, consistent in light/dark; the slot sits
outside the scroll area and above the Footer so a long form never pushes it out of sight; one feedback at a time
(validation failure immediately covers "model default config loaded"); "model default config loaded" shows only
when a new resolution actually changes untouched fields (no repeat for identical results); success stays briefly,
errors persist until the user edits the field, restores defaults, submits successfully or closes the dialog; error
text must match the real cause (format error, JSON Schema error and incomplete Effective Config do not share a
misleading text); accessible `role="status"` or `role="alert"`, not color alone; no global Toast and no mixing of
dialog draft validation into the Provider page's bottom save/connection-test feedback queue.

## 5. UI surface matrix

| Scenario                                      | Current value/draft owner             | New default or inheritance                                 | Commit / execution sink       | Behavior of this Todo                                 |
| --------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| Provider model config dialog                  | Renderer local Model Rule draft       | Built-in/Template/Provider/Personal Effective Model Config | Personal Model Config Rule    | Enum tag editor; Max edits `max`                      |
| New conversation draft                        | Renderer draft + Model Selection View | Latest complete selection, else `preferredSelection`       | Session Model Selection       | Missing reasoning filled with highest, made concrete  |
| Existing Session                              | Agent Session Selection               | Session's own frozen value                                 | Active Model / later requests | Does not read Spec default                            |
| Model switch                                  | Composer local selection              | Current legal value, else target model's highest           | `session/setModel`            | Submits a complete reasoning choice                   |
| Automation                                    | Automation edit draft                 | Target Host `preferredSelection` concrete value            | Automation record             | Saves concrete reasoning at creation                  |
| Repo Wiki                                     | Workspace generation draft            | Its own selection / Target Host View                       | One Wiki execution            | No mutual override with Session drafts                |
| Subagent                                      | Form or Markdown config               | Parent model inheritance or explicit target selection      | Subagent config / child Model | Inherits concrete value; explicit selection completed |
| Bot                                           | Bot draft / active task               | Concrete Selection                                         | Bot task execution            | Delete `spec.default` fallback                        |
| Title / Goal / Commit / Memory / Connectivity | Each auxiliary call                   | `values[0]`                                                | Single binding or Request     | Lowest level kept, Session untouched                  |
| Model execution                               | Active Model + Model Request          | No implicit default                                        | Model Executor                | Missing values fail before the network                |

A shared candidate source is not shared state: Automation, Repo Wiki, Subagent, Bot and ordinary Session keep their
own drafts, persistence and commit boundaries.

## 6. Implementation outline

- **Spec and contracts:** update Model Contract, Configuration, Model Creation, Runtime, Settings, Option Map and
  Built-in authoring docs and the Feature Graph (Reasoning `values` low to high; ordinary default = last item;
  low-cost auxiliary = first; Option Spec has no `default`); failing tests first; delete every Option Spec `default`
  in Built-in and Fixtures; the strict Schema no longer accepts `default` (unlaunched: no dual-read, compat field or
  Runtime fallback).
- **Model Selection:** Registry validation requires a valid reasoning when the model supports it; ordinary default
  fill (highest) in the existing Initial Selection Resolver (no Policy object or second Resolver); configured
  default, Registry fallback, recent selection and model switch build concrete values; delete `?? spec.default` in
  UI, Bot, Automation, Repo Wiki, Subagent; explicit invalid values still fail.
- **Model and Adapter:** delete all Option default materialization in the Model constructor, Adapter `bindModel`,
  Runner and Bootstrap; Active Model binds only Options the Selection made explicit; Model Request/Execution
  Contract makes Effective Options complete before the Executor; every real execution entry supplies an explicit
  `maxOutputTokens` source (no unified numeric fallback); Request values override bound values, cap validation, Option
  Map and Request Signing order kept; dependency-reference audit shows old default helpers, types, fixtures and
  exports at zero.
- **Provider settings GUI:** component and interaction failing tests first; compact Enum tag editor replaces the
  Reasoning Option Spec JSON draft, parser and textarea; Max Output edits `max` (delete the old branch needing an
  Inherited `max`); extract the dialog feedback banner; split field format errors from Effective Config incomplete
  errors so the Air case can save `max: 1000`; verify Overlay, restore all defaults, cancel, save, revision conflict
  and hidden `map` retention; desktop and phone E2E for drag, keyboard, feedback banner, theme, i18n and narrow
  layout.
- **Docs and mechanical cleanup:** update Bugfix 08 (ordinary requests no longer use `default`; only the auxiliary
  `values[0]` ruling remains) and Todo 54 / Feature Graph old invariants (delete "default remains ordinary request
  default"); search the repo for Option Spec default reads, Fixtures, Schema, docs and JSON; do not mechanically
  delete other domains' legitimate concepts named `default`.

## 7. Acceptance scenarios

- **Config / Schema:** Enum/Limit Spec rejects `default` with strict JSON round-trip; Enum `values` non-empty and
  deduplicated, Limit `max` a positive integer; Personal `values`, `max` and `map` leaf Overlay, `null` clearing and
  later override; every Built-in Effective Model Config has complete `values/max/map` and the formal JSON has no
  Option Spec `default`.
- **Model Selection:** reasoning-capable model — explicit valid passes, explicit invalid fails, missing is filled
  with the last item at ordinary initialization; reasoning-less model — explicit value fails; configured default,
  Registry fallback and sparse recent selection are all completed to the highest level and persisted whole; model
  switch submits a concrete reasoning and existing Sessions inherit their own; Built-in Rule updates affect only
  later-created selections/Models.
- **Runtime / Adapter:** Model/Adapter synthesize no Option from the Spec; a missing final `maxOutputTokens` or
  required reasoning fails explicitly before network I/O; explicit request overrides bound, over-`max` fails without
  clamping; Generate and Stream share completeness, mapping and error semantics; Option Map still sees the final
  Effective value and builds the right raw Request Body; Title, Goal, Git Commit, Memory Recall and Provider
  Connectivity still use `values[0]`; ordinary Session, Compact, Subagent, Repo Wiki, Automation and Bot use their own
  explicit selection and never read Spec default.
- **UI:** Enum tags show inherited values; add / edit / delete / drag / keyboard sorting save correctly; empty,
  duplicate and empty-array cannot be saved; no snap-back after drop and no text selection; Personal style, restore
  all defaults, cancel not committing and hidden `map` retention correct; Max Output edits `max` and produces no
  `default` Overlay; with no inherited `max` a valid positive integer saves as Personal `max` and reopens to the same
  value; non-numeric / non-integer / non-positive show the format error and a chain with no `max` shows the exact
  incomplete-config error; default-config-loaded success and draft failure use the same banner component with correct
  semantic colors, icons, mutual exclusion and lifecycle; the banner is fixed outside the scroll area, visible on a
  long form and narrow window; identical default config resolved repeatedly does not re-announce, and nothing is
  shown if the draft was not actually changed; Desktop/Web/phone, light/dark, Chinese/English, narrow width without
  horizontal page scroll.
- **E2E / regression:** editing the Reasoning order in Provider settings saves and reopens identically, with the
  Runtime mapping using the explicit values under the new order; adding `claude` to a Personal Provider (no specific
  Max Rule hit) with Context `10000` and Max Output `1000` saves, the Personal Rule writing only `max: 1000` and no
  `default`; a new model matching default config shows the success banner and a validation error then replaces it in
  the same slot and clears once corrected; a new session with no recent selection uses the target model's highest
  level and an existing Session does not drift; switching to a model with another Reasoning domain submits a legal
  concrete value; Automation, Repo Wiki and Subagent selections do not pollute ordinary Sessions; Desktop continuous
  and Mobile replayable Session Selection/recovery semantics unchanged with no new snapshot or recovery field.

## 8. Invariants and non-goals

`values` always ordered low to high; ordinary default only `values.at(-1)`, low-cost auxiliary only `values[0]`; no
guessing semantics from strings like `off / none / nothink / low / max`; no new Option Policy, Capability DTO,
execution Registry or hardcode by specific model ID; no change to Provider/Model Identity, Provider Template, Account
Overlay, Access, Endpoint, API Schema, auth or Request Auth; no change to model membership, model enabled, Provider
order, queue, Compact, recovery or remote Workspace lifecycle; no Option Map GUI and no general arbitrary JSON
request editor; the Model Config page does not become a per-request budget settings page.

## 9. Completion criteria

Config, Effective Model Config, Registry DTO, Active Model and Runtime Option Spec have no `default`; Built-in
Config and Personal Rule Schema neither read nor write Option Spec `default`; every ordinary Model Selection with
Reasoning has a concrete legal level before submission/use; the ordinary-highest and auxiliary-lowest defaults are
direct implementations over the ordered `values` with no Policy abstraction or string special case; every model
execution has complete legal Options before the Executor and a missing value never reaches the network; the Reasoning
JSON editor is fully replaced by the compact ordered tag editor and the Max Output page edits only `max`; the Air
false-positive is permanently covered by unit and desktop interaction tests; dialog success and failure feedback have
a single visual implementation always visible on long content with accurate error causes; targeted unit tests,
affected E2E, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, Desktop E2E typecheck and relevant container
verification pass; `git diff --check` and changed-file format check pass; implementation review confirms no leftover
default fallback, second selection fact or hardcode by model; Conventional Commit (suggested subject
`refactor(provider): require explicit model option values`).

## 10. Relation to the working tree

The worktree was then implementing Todo 55 (Provider Template). This Todo file stands alone and must not modify or
reorganize Todo 55's working changes; implement it after Todo 55's Config/Resolver Schema is stable to avoid
conflicts across Built-in Release, Model Rule Schema and Settings baseline; rerun the impact scan on the latest
worktree when implementing; if Todo 55 changes the physical grouping of Model Rules only the config landing point
adjusts, not the Option semantics here.

## 11. Outcome (2026-09-01)

- Option Spec `default` is retired from Config, Schema, Built-in Release, Registry DTO, Active Model and Runtime; the
  strict Schema rejects the old field.
- An ordinary Selection missing reasoning is filled with `values.at(-1)` at the unified resolution boundary; explicit
  low-cost auxiliary calls keep `values[0]`.
- Active Model no longer materializes execution values from the Spec; the final request validates complete reasoning
  and max output before network I/O.
- The Provider model settings page uses a compact sortable tag editor for the Reasoning Enum, and the max output
  input edits `max` directly.
- Built-in and test Fixtures no longer keep the old Option Spec `default`; the exact repo-wide scan leaves only
  negative tests where the strict Schema rejects the old field.

Verification: `pnpm test:unit` 1501 Test Files passed (1 pre-existing skipped), 12803 Tests passed (25 pre-existing
skipped); `pnpm typecheck`, `pnpm lint` (pre-existing warnings only), `pnpm --filter @zcode/desktop typecheck:e2e`,
changed-file format check and `git diff --check` passed; repo-wide `pnpm fmt:check` is still blocked by the existing
`apps/zcode-cli/tests/gb2312.js` read problem and Electron doc example HTML; `MP-UI-06` was completed and
type-checked but the Linux environment lacks `xvfb-run` so Chrome exits before the test body: the actual WDIO is
`blocked-environment`, not written as passed.

## 12. Later decision supplement (2026-09-05)

- Every ModelSelection that really enters ModelFactory/Runtime must carry a legal reasoning; a missing one is not a
  default at the execution layer.
- If a persisted or recent selection is left with only Provider/Model and no reasoning, or its reasoning no longer
  belongs to the current Spec, the Composer keeps the model identity and clears the level, asking the user to pick
  again — no silent fill with the highest level and no generic "selection invalid" notice.
- A new draft with no reliable history may still take `values.at(-1)` by the ordinary-entry rule; that is a different
  scenario from repairing an existing invalid persisted selection.
- Explicit low-cost auxiliary calls (Title, Goal, Memory, Connectivity) still use `values[0]`; that policy is not an
  ordinary ModelSelection default, and connection tests follow the same low-cost policy.
