# Todo 27: Provider Settings Experience and Real Execution Gap Consolidation

> Status: Completed (automation consolidation; macOS real-device re-validation pending latest dev chain launch)
>
> Date: 2026-08-27
>
> Prerequisite: After Todo 26 completed Zhipu `access.type + access.mode` contract cutover, handle Runtime Headers
> Schema consolidation here. Remaining UI and Team Plan state slices can be implemented independently.

## 1. Goals and Boundaries

This document consolidates Provider Refactor first-round macOS real-device experience issues that remain incomplete and already decided:

1. Express Model Config boolean leaves' Effective values and Personal Overlay sources with unified visuals;
2. Delete all single-field restore entries, keep only always-visible model-level "restore all defaults";
3. Unify save success and model connection success projections to the window bottom notification area;
4. Fix Team Plan status misjudgment and request-period Account Access protocol inconsistencies;
5. Supplement automated proofs and real-device regression for the above behaviors.

This document does not handle cross-process Personal Config / Provider Registry update mechanisms. This issue involves Host, Agent, file watcher, revision
confirmation, and pre-execution consistency, should be completed in independent research and Todo, and must not add temporary polling or UI fallback via connection tests.

The following experience issues are already completed, no longer implemented redundantly:

- Historical name conflicts no longer block unrelated Provider saves;
- Incomplete Providers can be saved but not executed;
- Provider/Model entire-row dragging, drag rebound, and Dialog penetration dragging already fixed;
- Provider enable/disable merged into one status button;
- Context, Max Output, and JSON inheritance values use placeholders;
- JSON uses fixed-height text boxes, content scrolls within text box;
- Model Dialog and Provider dual-column containers have stable heights and independent scrolling;
- Domestic Providers displayed first in Built-in Config and new menus.

## 2. Boolean Field Unified Expression

### 2.1 Two Orthogonal Facts

Each editable boolean leaf simultaneously expresses two non-interchangeable facts:

```text
checked / unchecked
└─ Current Effective Model Config boolean value

normal stroke / high-saturation stroke
└─ Current value is inheritance result / has explicit Personal Overlay leaf
```

No additional text like "default," "modified." Personal Overlay expressed only by style: when explicit Personal leaf exists, outer option frame and
inner Checkbox stroke both use higher saturation; inherited values use normal stroke.

"Modified" determined by whether that leaf exists in sparse Personal Model Config Rule, not inferred from `personalValue !== inheritedValue`. User explicitly writes a value identical to Built-in current value is still Personal Overlay.

### 2.2 Component Scope

Input type, output type, and model capabilities uniformly use same boolean option component, dimensions, Checkbox, and state styles:

```text
properties.input_format.support_*
properties.output_format.support_text
properties.supportsToolCall
properties.supportsJsonSchemaOutput
properties.supportsNativeWebSearch
properties.supportsMidConversationSystem
requiresMfjsToolSchema
```

Locked Text only expresses non-editable: retain lock icon and normal inheritance style, do not disguise as Personal Overlay with high-saturation stroke.
PDF, Audio continue hidden and preserved losslessly when editing other fields.

## 3. Model-Level "Restore All Defaults"

Delete Context, Max Output, input format, model capabilities, and other single-field small restore buttons beside them. Model Dialog Footer keeps only one
"Restore All Defaults" entry, and always displays for Built-in members and Personal Provider models:

```text
ZCode Built-in Model Config Rules
                  |
                  v
       Personal Model Config Rule (sparse Overlay)
                  |
                  v
         Effective Model Config
```

Models of Personal Providers are also first resolved by Built-in general Model Config Rules, then overlaid with Personal Rule, therefore also have recoverable
inheritance baseline.

Button semantics fixed to: clear complete Personal Model Config Overlay for current `providerId + modelId`, redisplay Effective values resolved by Built-in Rules;
it does not delete Provider, model members, Model ID, model order, or Provider order. Button stays displayed but disabled when no Personal
Overlay exists; enabled when any explicit Personal leaf exists. Clear only modifies popup draft, still executed by "save"; cancel must not submit.

## 4. Window-Level Success Feedback

Provider/Model save and model connection feedback unified into application window bottom notification layer, not entering Provider content area, model list, or page top:

```text
Application viewport
┌─────────────────────────────────────────────┐
│                                             │
│         Provider Settings scroll area       │
│                                             │
│                         ┌─────────────────┐ │
│                         │  Earlier success  │ │
│                         ├─────────────────┤ │
│                         │  Latest success   │ │
│                         └─────────────────┘ │
└─────────────────────────────────────────────┘
```

- Latest message fixed at bottom, multiple different messages stack upward;
- No `dirty` text displayed; same save target's saving, success, failure use same stable key for in-situ replacement;
- saving does not auto-disappear, success stays briefly, failure extends stay and provides retry/close;
- Provider save success needs to identify corresponding Provider; model save and model connection messages must display Model ID, same-name models optionally display Provider name or Provider ID simultaneously;
- Provider or model count changes, left-right panel scrolling must not push notification position;
- Toast container must be fully within viewport; title bar clearance must not mechanically apply to bottom container.

Notification component must reuse existing window-level feedback infrastructure; if current infrastructure does not support stacking and replacement, extend same store, do not establish
Provider Settings private second Toast state.

## 5. Team Plan Status Must Distinguish Unknown from Unavailable

Current Team Plan page merges the following two facts into `teamPlanUnavailable`:

```text
project API Key explicitly determined by server as unavailable
                         +
Team quota no snapshot / requesting / request failed
                         |
                         v
               "Team plan unassigned"
```

This misreports "no fact yet obtained" as "server has confirmed unavailable." More severely, the status card uses this result to block subsequent Usage entitlement
refresh, forming a self-lock: initial no quota -> display unassigned -> never refresh -> forever unassigned.

Status must be split:

```text
checking / unknown / request-failed
└─ Must not display "team plan unassigned," must not block retry or refresh

explicit unavailable
└─ Only display "team plan unassigned" when project API Key or quota authoritative response explicitly states unavailable

available
└─ Display connected/purchased status, and allow Account Overlay normal publishing
```

UI must not directly force Provider `enabled=true` because Team quota succeeded, nor splice Account Overlay itself. Account Resolver remains
Provider executable state's sole projector; this slice only fixes display state machine and refresh gate.

## 6. Runtime Headers Use Registry Access Formal Schema

Real-device Team Plan request failure direct cause not plan non-existence, but Agent's Runtime Headers request carries complete
`providerConfig.access` from Registry, while App Protocol uses another hand-written strict subset Schema. After two Schema drifted, Protocol rejects parameters before model request sent, ultimately showing only `Model request failed`.

After Todo 26 completes, `accountAccess` in Runtime Headers requests must directly reuse formal Provider Registry Access Schema corresponding
`zhipu-account` branch, no longer maintaining `{ type, family, planKind }` or other hand-written projections:

```text
Effective Provider Config.access
          |
          |  Same formal Schema / same serialization shape
          v
Runtime Headers request.accountAccess
          |
          v
Host obtains request-period materials by family + mode
```

This slice must not:

- Widen Protocol via `.passthrough()` to swallow unknown fields;
- Maintain separate Access DTO in Adapter, Protocol, and UI each;
- Write security validation materials, Ticket, JWT, or temporary Header back to Provider Config;
- Infer Access Mode from Provider ID, Model ID, Endpoint, or pathname.

Runtime Headers request still carries only static Access facts locating and explaining this auth request material; actual request-period Secrets returned by Host response and bound
to that Model Request.

## 7. Implementation Order

```text
Todo 26: Access Type/Mode Contract Cutover
                 |
                 v
Runtime Headers Schema reuse formal Access
                 |
                 v
Team Plan real-request regression

Boolean Overlay style unified
                 |
                 v
Model-level restore defaults
                 |
                 v
Window-level success feedback

Team state machine split can be implemented in parallel independently
```

Each slice writes failing test first, then modifies production code minimally. When tests discover need to change Config, Overlay, Registry, or model selection semantics outside this document,
pause implementation and request decision.

## 8. Test Plan

### 8.1 UI and Overlay

- Input, output, and model capabilities use same Boolean option DOM and visual state;
- checked determined only by Effective value, Personal style determined only by sparse leaf existence;
- Explicit value equal to inheritance value still displays Personal style;
- Text locked fields maintain normal style; PDF/Audio preserved losslessly;
- No single-field restore buttons exist;
- "Restore all defaults" always exists for Built-in and Personal models, disabled when no Overlay;
- "Restore all" clears complete Personal Model Config Rule, cancel does not submit, save re-inherits general/specific Built-in Rules.
- Two complex JSON edit areas use only fixed-height text box own stroke, no outer stroke, background, or padding; MFJS shows "Other Settings" group title before.

### 8.2 Save and Success Feedback

- Provider/Model save and model connection feedback displayed at right Provider detail panel bottom, does not scroll with content;
- No dirty rendered; saving, success, failure use same key replacement, failure stays longer and can retry/close;
- Model save and model connection messages include Model ID, same-name models include Provider identity;
- Multiple different messages stack upward, duplicate messages replace;
- Provider left-right panel scrolling, long model lists, and mobile layout do not change notification anchor;
- Chinese/English, light/dark themes, and keyboard close behavior consistent.
- Provider name, Base URL, and API Key continuous input share idle save timer, flush immediately on blur, no double-submit;
- Model Metadata Dialog still controlled by explicit save/cancel, not disrupted by idle save.

### 8.3 Team Plan

- Missing quota, loading, request failure all do not display "team plan unassigned," and allow refresh;
- Authoritative unavailable displays unassigned; available restores normal status;
- Status switching does not directly modify Provider enabled by UI;
- `zhipu-account/team-coding-plan` complete Registry Access passes Protocol strict validation;
- Start, Individual, Team, Off-Peak Runtime Headers parameters all consistent with Todo 26 Mode contract;
- Team Plan request successfully obtains request-period materials before model network call; missing materials return accurate auth error, not Schema error.

### 8.4 Regression Boundaries

- Normal `api-key` Provider does not enter Runtime Headers request chain;
- Account Overlay, Start account model constraints, and Provider Registry members not modified by UI state machine;
- Desktop local and Web Remote continue obtaining request-period materials from target Environment Host;
- Created Active Model freeze semantics unchanged;
- Provider/Model dragging, independent scrolling, Dialog overlay, and fixed-height JSON editor do not regress.

## 9. Completion Criteria

- All model boolean configs in Settings have unified appearance and accurately express Personal Overlay source;
- Only one always-visible model-level restore defaults entry exists;
- Save and connection success feedback stably anchored at right Provider detail panel bottom, model success messages carry identity;
- Provider text inputs support both idle save and blur immediate save, not creating duplicate writes;
- Team Plan no longer misreports unknown or request failure as unassigned, nor self-blocks refresh;
- Team Plan Runtime Headers requests strictly reuse formal Registry Access Schema, and can complete real model requests;
- Directed unit tests, `pnpm typecheck`, `pnpm lint`, affected UI E2E, and macOS real-device regression pass;
- No second Model Config, Account Access, Registry, Toast, or connection state facts added.

## 10. Implementation Results

- Input/output formats, capability fields, and MFJS uniformly use same Boolean Model Option; Effective value determines checked, sparse
  Personal leaves expressed only by high-saturation outer frame and Checkbox stroke, locked Text does not disguise as Personal;
- Deleted all single-field restore entries; model-level "restore all defaults" always displayed, disabled when no Overlay, atomically clears complete
  Personal Model Config on submit, without deleting members or identity;
- Provider/Model save and model connection consolidated to bottom banner of right Provider detail panel; saving, success,
  failure for same object replaced in-situ by key, different objects stacked upward, model messages include Provider/Model identity; no more dirty, failure extends to eight seconds
  with retry or close;
- Provider name, Base URL, and API Key text drafts auto-save after 800ms idle input stop, flush immediately on blur/Enter/swapping; single timer per Provider, same draft not double-submitted, Chinese IME composition period does not trigger idle save;
- Two complex JSON edit areas removed duplicate outer stroke, background, and padding, kept only fixed-height text boxes; MFJS switch placed under "Other Settings" section;
- Team Plan state machine distinguishes loading, request error, and server-confirmed unavailable; detail page no longer blocks
  entitlement refresh by "unassigned" status, eliminating permanent self-lock after initial no-quota;
- Runtime Headers requests directly use `zcodeProviderAccountAccessSchema`. API Key, Start, Individual, Team,
  Off-Peak five Registry modes all pass strict Protocol tests, old `planKind` shape rejected;
- Settings page, Usage, and login recovery no longer parse Registry Access using dynamic `zcodeAccountAccessSchema`. UI only passes
  `{ type, family, mode }` static facts, Host's Account Request Auth Service then resolves dynamic
  `planKind` and Team scope based on current connection; Team usage source combines static `team-coding-plan` mode and subscribed project facts,
  does not write project identity back to Provider Config;
- Model selection grouping and Official MCP credential resolution also cutover to formal static Registry Access Schema. Official MCP at
  Host call boundary resolves current dynamic connection, and includes both preceding and following Account Access in consistency check; when same Family simultaneously
  enables regular plan and Off-Peak, settings and Usage both parse by precise Provider ID, no longer requiring "single Provider under Family";
- Bugfix 03 duplicate JSON output Token entry simultaneously deleted, unique numeric entry deterministically produces complete
  `LimitOptionSpec` from inherited limit;
- New Personal Model Config Rule preview only as `inheritedConfig` and input placeholder, no longer filled back as user input;
  on submit Built-in general rule-provided context, input/output format, and capabilities not mistakenly written as Personal Overlay;
- UI, Team Plan, Shared Protocol, Model Selection, and Official MCP directed tests passed; root `pnpm typecheck`
  and `pnpm lint` passed (lint retains only 34 repository pre-existing warnings), this round's modified file format check passed;
- Full unit tests `12,463 passed / 25 skipped`; only 2 unrelated Server CLI ZIP cases `ENOENT` on starting external command due to current host missing
  `zip` executable, Provider/Model/Account/Settings regressions had no failures;
- Linux Desktop E2E build completed, but host missing `xvfb-run`, Electron exits before entering test assertions. This environment block and
  macOS latest dev chain real-device re-validation not faked as automated pass, continues retained as pre-release real verification item.
