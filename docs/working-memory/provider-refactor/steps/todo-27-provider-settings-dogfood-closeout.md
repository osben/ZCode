# Todo 27: Provider Settings Experience and Real Execution Gap Consolidation

> Status: Completed (automation consolidation; macOS real-device re-validation pending the latest dev chain launch)
>
> Date: 2026-08-27
>
> Prerequisite: Todo 26 completed the Zhipu `access.type + access.mode` contract cutover; Runtime Headers Schema
> consolidation is handled here. The remaining UI and Team Plan state slices are independent.

## 1. Goals and Boundaries

Consolidates the incomplete, already-decided issues from the first macOS real-device round:

1. Express Model Config boolean leaves' Effective value and Personal Overlay source with unified visuals.
2. Delete all single-field restore entries; keep only an always-visible model-level "restore all defaults".
3. Project save success and model connection success to the window bottom notification area.
4. Fix Team Plan status misjudgment and request-period Account Access protocol inconsistency.
5. Add automated proofs and real-device regression for the above.

Not handled: cross-process Personal Config / Provider Registry update mechanisms (Host, Agent, file watcher,
revision confirmation, pre-execution consistency). They need independent research and a Todo; no temporary polling
or UI fallback via connection tests.

Already completed elsewhere and not redone: historical name conflicts no longer block unrelated Provider saves;
incomplete Providers can be saved but not executed; Provider/Model entire-row dragging, drag rebound and Dialog
penetration fixed; Provider enable/disable merged into one status button; Context, Max Output and JSON inheritance
values use placeholders; JSON uses fixed-height text boxes scrolling inside; Model Dialog and Provider dual-column
containers have stable heights and independent scrolling; domestic Providers first in Built-in Config and menus.

## 2. Boolean Field Unified Expression

Each editable boolean leaf expresses two non-interchangeable facts:

```text
checked / unchecked          -> current Effective Model Config boolean value
normal stroke / high-saturation stroke -> value is inheritance result / has explicit Personal Overlay leaf
```

No additional text such as "default" or "modified". With an explicit Personal leaf, both the outer option frame and
the inner Checkbox stroke use higher saturation. "Modified" is whether the leaf exists in the sparse Personal Model
Config Rule, not `personalValue !== inheritedValue`: an explicit value equal to the current Built-in value is still a
Personal Overlay.

Input type, output type and model capabilities use the same boolean option component, dimensions, Checkbox and state
styles: `properties.input_format.support_*`, `properties.output_format.support_text`, `properties.supportsToolCall`,
`properties.supportsJsonSchemaOutput`, `properties.supportsNativeWebSearch`,
`properties.supportsMidConversationSystem`, `requiresMfjsToolSchema`. Locked Text expresses only non-editable (lock
icon, normal inheritance style, never high-saturation Personal stroke). PDF and Audio stay hidden and preserved
losslessly when editing other fields.

## 3. Model-Level "Restore All Defaults"

Single-field restore buttons (Context, Max Output, input format, capabilities) are deleted. The Model Dialog Footer
keeps one "Restore All Defaults" entry, always shown for Built-in members and Personal Provider models (models of
Personal Providers are also resolved by Built-in general Model Config Rules and then overlaid by the Personal Rule, so
they have a recoverable baseline):

```text
ZCode Built-in Model Config Rules -> Personal Model Config Rule (sparse Overlay) -> Effective Model Config
```

It clears the complete Personal Model Config Overlay for the current `providerId + modelId` and redisplays the
Built-in-resolved Effective values. It never deletes Provider, members, Model ID, model order or Provider order. It
is shown but disabled when no Personal Overlay exists and enabled when any explicit Personal leaf exists. Clearing
only modifies the popup draft and is committed by "save"; cancel must not submit.

## 4. Window-Level Success Feedback

Provider/Model save and model connection feedback use the application window bottom notification layer (not Provider
content area, model list or page top):

- latest message fixed at the bottom, different messages stack upward;
- no `dirty` text; saving, success and failure of the same target replace in place by a stable key;
- saving does not auto-disappear, success stays briefly, failure stays longer and offers retry/close;
- Provider save success identifies the Provider; model save and model connection messages show Model ID (same-name
  models also show Provider name or ID);
- Provider/model count changes and left-right panel scrolling must not move the notification;
- the container is fully inside the viewport; title bar clearance is not applied to the bottom container.

Reuse the existing window-level feedback infrastructure; if it lacks stacking and replacement, extend the same store
instead of creating a Provider Settings private Toast state.

## 5. Team Plan Status: Unknown vs Unavailable

Team Plan page used to merge "project API key explicitly unavailable" and "Team quota no snapshot / requesting /
failed" into `teamPlanUnavailable`, misreporting "no fact obtained" as "server confirmed unavailable" and, because
the status card used it to block Usage entitlement refresh, forming a self-lock (no quota -> unassigned -> never
refresh). States are split:

```text
checking / unknown / request-failed -> never show "team plan unassigned", never block retry or refresh
explicit unavailable                -> show "team plan unassigned" only when project API key or quota authoritative response says unavailable
available                           -> show connected/purchased status; Account Overlay publishes normally
```

UI does not force Provider `enabled=true` because Team quota succeeded and does not splice Account Overlay; Account
Resolver stays the sole projector of Provider executable state. This slice fixes only the display state machine and
refresh gate.

## 6. Runtime Headers Use the Registry Access Formal Schema

The real-device Team Plan failure was not plan non-existence: Agent's Runtime Headers request carried the complete
`providerConfig.access` from Registry while App Protocol used another hand-written strict subset Schema, so Protocol
rejected the parameters before the model request and the UI showed only `Model request failed`.

`accountAccess` in Runtime Headers requests directly reuses the formal Provider Registry Access Schema's
`zhipu-account` branch (`zcodeProviderAccountAccessSchema`), with no hand-written `{ type, family, planKind }`
projection:

```text
Effective Provider Config.access -> same formal Schema / serialization shape -> Runtime Headers request.accountAccess -> Host obtains request-period materials by family + mode
```

This must not: widen Protocol with `.passthrough()`; keep separate Access DTOs in Adapter, Protocol and UI; write
security validation materials, Ticket, JWT or temporary Headers back to Provider Config; infer Access Mode from
Provider ID, Model ID, Endpoint or pathname. The request carries only static Access facts; actual request-period
secrets come from the Host response and bind to that Model Request.

## 7. Acceptance Scenarios

### 7.1 UI and Overlay

- Input, output and model capabilities share the same Boolean option DOM and visual state.
- checked comes only from the Effective value; Personal style only from sparse leaf existence; an explicit value
  equal to the inherited one still shows Personal style.
- Locked Text keeps normal style; PDF/Audio preserved losslessly.
- No single-field restore buttons exist.
- "Restore all defaults" exists for Built-in and Personal models, disabled without Overlay; it clears the complete
  Personal Model Config Rule, cancel does not submit, save re-inherits general/specific Built-in Rules.
- The two complex JSON edit areas use only the fixed-height text box's own stroke (no outer stroke, background or
  padding); MFJS shows an "Other Settings" group title before it.

### 7.2 Save and success feedback

- Feedback shows at the bottom of the right Provider detail panel and does not scroll with content.
- No dirty rendered; saving/success/failure replace by key; failure stays longer with retry/close.
- Model save and connection messages include Model ID; same-name models include Provider identity.
- Different messages stack upward, duplicates replace; scrolling, long model lists and mobile layout do not change
  the anchor; Chinese/English, light/dark and keyboard close behave consistently.
- Provider name, Base URL and API key continuous input share one idle save timer, flush immediately on blur, and do
  not double-submit.
- The Model Metadata Dialog stays controlled by explicit save/cancel, not by idle save.

### 7.3 Team Plan

- Missing quota, loading and request failure never show "team plan unassigned" and allow refresh; authoritative
  unavailable shows unassigned; available restores normal status.
- Status switching never modifies Provider enabled from UI.
- Complete Registry Access for `zhipu-account/team-coding-plan` passes Protocol strict validation; Start,
  Individual, Team and Off-Peak Runtime Headers parameters match the Todo 26 Mode contract.
- Team Plan obtains request-period materials before the model network call; missing materials yield an accurate auth
  error, not a Schema error.

### 7.4 Regression boundaries

- Normal `api-key` Providers do not enter the Runtime Headers chain.
- Account Overlay, Start account model constraints and Registry members are not modified by the UI state machine.
- Desktop local and Web Remote keep obtaining request-period materials from the target Environment Host.
- Created Active Model freeze semantics unchanged.
- Provider/Model dragging, independent scrolling, Dialog overlay and fixed-height JSON editor do not regress.

## 8. Completion Criteria and Outcome

- All model boolean configs have a unified look and accurately express the Personal Overlay source.
- One always-visible model-level restore defaults entry exists.
- Save and connection feedback anchors at the bottom of the right Provider detail panel; model messages carry
  identity.
- Provider text inputs support idle save and blur immediate save without duplicate writes: auto-save after 800ms (raised to 1200ms by Todo 29) of
  input idle, immediate flush on blur/Enter/swap, one timer per Provider, same draft not double-submitted, Chinese IME
  composition does not trigger idle save.
- Failure feedback stays eight seconds with retry or close.
- Team Plan no longer misreports unknown or failed requests as unassigned nor self-blocks refresh.
- Runtime Headers strictly reuse the formal Registry Access Schema: API Key, Start, Individual, Team and Off-Peak
  modes all pass strict Protocol tests; the old `planKind` shape is rejected.
- Settings page, Usage and login recovery no longer parse Registry Access with dynamic `zcodeAccountAccessSchema`.
  UI passes only static `{ type, family, mode }`; Host's Account Request Auth Service resolves dynamic `planKind`
  and Team scope from the current connection. Team usage source combines static `team-coding-plan` mode with
  subscribed project facts and never writes project identity back to Provider Config.
- Model selection grouping and Official MCP credential resolution also use the formal static Registry Access Schema;
  Official MCP resolves the current dynamic connection at the Host call boundary and includes both preceding and
  following Account Access in the consistency check; when the same Family enables both regular plan and Off-Peak,
  settings and Usage both resolve by precise Provider ID (no longer "single Provider under Family").
- Bugfix 03's duplicate JSON output-token entry is deleted; the single numeric entry deterministically produces a
  complete `LimitOptionSpec` from the inherited limit.
- A new Personal Model Config Rule preview is only `inheritedConfig` and input placeholder (not filled back as user
  input); on submit, Built-in general-rule context, input/output format and capabilities are not mistakenly written
  as Personal Overlay.
- No second Model Config, Account Access, Registry, Toast or connection state facts were added.

Verification: UI, Team Plan, Shared Protocol, Model Selection and Official MCP directed tests passed; root
`pnpm typecheck` and `pnpm lint` passed (34 pre-existing warnings); changed-file format check passed; full unit tests
12,463 passed / 25 skipped, only 2 unrelated Server CLI ZIP cases `ENOENT` (host missing `zip`). Linux Desktop E2E
build completed but the host has no `xvfb-run`, so Electron exits before assertions; this environment block and the
macOS latest dev chain real-device re-validation are not claimed as automated pass and stay as pre-release real
verification items.
