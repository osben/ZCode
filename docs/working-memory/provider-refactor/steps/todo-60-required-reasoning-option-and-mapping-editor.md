# Todo 60: Required Reasoning Option and Mapping Editor Closeout

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promoted items moved to
> [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules here; historical
> evidence is retained and the transfer does not mean the tests passed.

> Status: Completed (Desktop E2E real run blocked by the graphical environment)
>
> Date: 2026-09-02
>
> Prerequisite: Todo 54 moved public Option mapping into the Option Spec itself; Todo 58 deleted Option `default` and
> fixed Reasoning `values` low to high. This Todo overrides Todo 58's old conclusion "Reasoning Spec optional, Mapping
> not editable".

## 1. Goal

Every complete Effective Model Config must declare both `reasoningLevel` and `maxOutputTokens`. Reasoning is no
longer an optional capability; a model without reasoning is expressed uniformly with the single `disabled` level and
an empty Request Body Patch.

```text
Effective Model Config
├─ reasoningLevel: type = enum; values = non-empty, low to high; map = compilable Request Body Patch expression
└─ maxOutputTokens: type = limit; max = positive integer; map = compilable Request Body Patch expression
```

Canonical no-reasoning representation: `{ "reasoningLevel": { "type": "enum", "values": ["disabled"], "map": "{}" } }`.
`"{}"` produces an empty JSON Merge Patch; an empty string is not a legal Mapping and gets no special parse branch.

## 2. Execution value contract

A complete Model Selection / Active Model must carry a concrete `reasoningLevel`. An Option in a Model Request may
still be omitted as a single-call override, but the merged result must be complete before the Executor.

```text
Ordinary selection genuinely missing the value: reasoningLevel = values.at(-1)
Auxiliary calls (Title / Goal / Git Commit / Memory / Connectivity / WebSearch / WebFetch / Read Session Context):
  reasoningLevel = values[0]; maxOutputTokens = min(5000, optionSpecs.maxOutputTokens.max)
```

Auxiliary calls must not guess capability from names like `off`, `disabled`, `nothink`, nor keep a normal branch
with `reasoningLevel === undefined`. A missing Reasoning Spec means the Effective Model Config is incomplete and the
model must not enter the Registry. Compact and Repo Wiki are not these low-cost auxiliary calls: Compact continues
this turn's frozen Active Model; Repo Wiki uses the Model Selection the user explicitly chose for that generation
task; neither may be silently rewritten by the auxiliary-call rule.

## 3. Fixed Thinking Budget retired

All fixed `thinking.budget_tokens` / `budgetTokens` mappings leave the Built-in Model Config Rules (a fixed Token
Budget is an old protocol usage and no longer a means of implementing Reasoning levels). Keep the fields the protocol
really supports (`thinking.type`, `reasoning_effort`, `output_config.effort`, ...); levels that need no request
parameter use `map: "{}"`; delete fixed-budget numeric Fixtures, request snapshots and current-design text still
interpreting levels as fixed budgets (Telemetry may keep recording the thinking budget the server response actually
returns, but never as local config or an expected request value); delete combined arithmetic or validation that
existed only to coordinate thinking budget with max output; do not restore model-ID-hardcoded budget or reasoning
strength. Historical research material may keep its facts of the time, but current Design, Built-in, tests and
production code use the new contract.

## 4. Config and Registry

- Rule Input / Personal Model Config stay sparse leaf Overlay, allowed to override only the explicitly provided
  `type/values/map/max` fields.
- Effective Model Config's `optionSpecs.reasoningLevel` and `optionSpecs.maxOutputTokens` are both required and
  complete.
- Resolver, Settings View, Registry DTO, cross-process protocol and Active Model no longer declare the Reasoning
  Spec optional.
- Registry integrity tests cover missing Reasoning, empty values, missing map and illegal map.
- Built-in general rules provide a complete no-reasoning baseline and specific model/API Rules override only their
  real differences.
- Personal Overlay `null`, JSON round-trip and leaf override semantics are unchanged.

## 5. Settings page

The Reasoning editing area is always shown, not hidden because the current Effective Spec is missing or has a single
level: "Reasoning levels (low to high)" tags like `[ disabled ] [ low ] [ high ] [+]` and a "Reasoning parameter
Mapping" text box (Personal map is the value; Inherited map is the placeholder).

### 5.1 Level editing

`+` is always shown; chips support add, rename, delete, drag sorting and keyboard operation; at least one non-empty,
non-duplicate value is kept and the last value cannot be deleted to empty; the sort result is the low-to-high
`values`; the UI never infers lowest, highest or off semantics from strings; unmodified Effective values are not
copied into the Personal Rule and after modification only the Personal `values` leaf is written; "restore all
defaults" clears the Personal `values` and `map` Overlay.

### 5.2 Mapping text box

Uses the ordinary technical text box background, border, radius and focus style with no extra outer Card; fixed
height, monospace, inner scrolling; `value = personal reasoning map ?? ""`; `placeholder = inherited reasoning map ??
effective baseline map`; clearing entered content deletes the Personal `map` Overlay and restores inheritance;
spellcheck, autocorrect, autocapitalize and autocomplete disabled; on save the Effective map must be non-empty and
compilable, errors going into the dialog's existing unified feedback banner; desktop, Web and phone share behavior,
narrow screens wrap naturally with no horizontal page scroll.

## 6. Acceptance scenarios (tests first)

1. Config / Schema: the Reasoning Spec is required in Effective Config; the no-reasoning baseline `disabled + {}` is
   legal; Overlay, `null` and round-trip do not regress.
2. Resolver / Registry: missing Reasoning, empty values, missing map or illegal map do not enter the Registry; a
   complete Spec enters the Active Model unchanged.
3. Selection / Runtime: ordinary missing takes the last item; auxiliary calls uniformly take the first item with
   `min(5000, max)`; no normal branch with Reasoning undefined.
4. Built-in: every model resolves a complete Reasoning/Max Output Spec; formal JSON contains no `budget_tokens`; the
   Option Map trial-runs every level.
5. UI unit: `+` shows regardless of level count; the Mapping's Personal value / Inherited placeholder are correct;
   clearing restores inheritance; saving forms a sparse Overlay; an invalid Mapping shows the unified error banner.
6. UI E2E: add a Personal model, edit/sort levels, override Mapping, restore defaults, cancel without committing;
   desktop and narrow screen layouts.
7. Regression: Option selection of Title, Goal, Git Commit, Memory, Connectivity, ordinary Session, Automation, Repo
   Wiki and Subagent is consistent.

Final runs: affected packages' unit tests/typecheck, root `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, format
check and relevant Desktop E2E; when the graphical environment is unavailable, record unrun items explicitly rather
than faking a pass.

## 7. Completion criteria

No optional Reasoning Spec in the production domain; no fixed thinking budget in Built-in and formal request
Mappings; all auxiliary calls use the same `values[0] + min(5000,max)` rule with no duplicated differing fallback;
the settings page edits levels and Mapping from the existing baseline with `+` always visible; Personal Mapping uses
the existing value / inherited placeholder Overlay interaction; no new Reasoning Policy, Budget Resolver, Capability
DTO or runtime hardcode by specific model; targeted and full verification pass and a Conventional Commit is made.

## 8. Outcome

- Effective Model Config, Registry, Active Model creation and the Adapter execution boundary uniformly require a
  complete `reasoningLevel` and `maxOutputTokens`; old Selections are completed to the highest level only at the Host
  initial-selection boundary.
- Built-in general rules provide the `disabled + {}` baseline; all current Built-in Reasoning Mappings dropped the
  fixed `thinking.budget_tokens`.
- A single auxiliary Model Options helper is added: Title, Goal, Git Commit, Memory, Connectivity, WebSearch, WebFetch
  and Read Session Context uniformly use `values[0] + min(5000,max)`.
- The settings page always shows the Reasoning level editor and add button plus a fixed-height Mapping text box;
  Personal Mapping uses value, inherited uses placeholder, clearing deletes the Personal `map` leaf.
- Fixed: an invalid reasoning level in a Subagent's historical selection overrode the current Model Spec directly;
  now it is validated against the current Model Spec and falls back to the highest level.

Verification: `pnpm typecheck` passed; `pnpm lint` 34 pre-existing warnings, 0 errors; `pnpm test:unit` 12,809
passed, 25 skipped, the one failure being the `componentCache` symlink archive case which passed 6/6 on isolated
rerun (parallel-environment fluctuation); `pnpm --filter @zcode/desktop typecheck:e2e` passed;
`settings-ui-polish.test.ts` built for production but the Linux host has no `DISPLAY` and no `xvfb-run`, so Chrome
exits before session creation; the environment failure is not recorded as feature pass.
