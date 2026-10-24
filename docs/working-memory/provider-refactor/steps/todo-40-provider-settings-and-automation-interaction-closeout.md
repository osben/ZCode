# Todo 40: Provider Settings and Automation Model Interaction Closeout

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promoted items moved to
> [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules here; historical
> evidence is retained and the transfer does not mean the tests passed.

> Later Desktop graphical E2E untested items are consolidated by Todo 78; this Todo is no longer scheduled
> separately.

> Status: Completed (Desktop real-device E2E blocked by the Linux environment missing `xvfb-run`)
>
> Date: 2026-08-28
>
> Source: Provider Settings real-device experience, Team Plan upgrade entry and Automation new-task regression

## 1. Goals

Closes five already-decided interaction issues without new Provider, Model or Automation intermediate abstractions:

1. Restore the three-dimensional intent (Family, personal/team Audience, concrete Team Plan) of the Coding Plan
   upgrade entry.
2. Provider settings page returns to the standard `max-w-4xl`; only the Model Config popup keeps the standard
   `max-w-2xl` widening.
3. Delete `modelsReadOnly`, which bundled model editing, enable/disable, add/delete and connection testing.
4. Account Provider hides only Endpoint, API Schema and account credentials; models keep the standard Effective Model
   editing capability.
5. Automation has no `inherit/default model` virtual state: a new task fixes a concrete model and reasoning.

## 2. Coding Plan upgrade intent

```text
Selected Account Provider
├─ provider family  -> Z.ai / BigModel
├─ plan audience    -> personal / team
└─ team plan key    -> concrete Team Plan (team entry only)
        v
CodingPlanUpgradeDialog -> Embedded Website URL / Bridge
```

- Team Provider ID must enter the upgrade entry's normalization boundary and not be normalized to `null` at the
  dialog entry (without adding Team Providers to the static plan navigation candidates).
- `providerId` still decides the website Family; `initialAudience` decides the personal or team page;
  `initialTeamPlanKey` is the concrete team plan the user clicked.
- Status Card must not hardcode all upgrade/renew entries to `personal`.
- The WebView receives an explicit purchase launch intent; Telemetry's `purchase_audience` must not double as the
  routing protocol.
- The manage entry keeps the personal/team manage URLs in Family Spec, separate from the purchase WebView.

## 3. Provider settings model behavior

```text
model.builtin: true  -> Model ID fixed, cannot be deleted
model.builtin: false -> Model ID editable, can be deleted
All models: can edit the Personal Model Config Overlay, toggle enabled, take part in ordering,
            and connection-test when a formal test handler exists
```

- `modelsReadOnly` and its propagation from Account Detail to Model Row are deleted.
- The UI no longer guesses test eligibility from the form API key, `readOnly` or `model.executable`; the test button
  shows only when a formal test capability exists and is disabled only while a request is in flight. Execution
  failure returns an explicit error from the formal Model/Registry test chain.
- Account Team / Individual / Start pages show no Endpoint, API Schema or account credentials; their model list shows
  the Effective Provider Config and allows standard Personal Overlay editing.
- Built-in API Key Providers can still show and lock Built-in-owned Endpoint/API Schema (field-level read-only stays).

## 4. Layout

Provider Settings uses the shared `max-w-4xl` content width; the Model Config popup stays `max-w-2xl` and is not
widened further. The whole page is not widened to fix popup or detail internal scrolling. Desktop, Web and narrow
windows keep the existing responsive and independent-scroll structure.

## 5. Automation concrete model

```text
Target Host ModelSelectionView ready -> preferredSelection -> concrete providerId / modelId
 -> model Option Spec default reasoning -> save the complete modelSelection
```

- `INHERIT_MODEL_VALUE` and the "default model / follow Workspace" copy are deleted.
- New tasks, old edit records missing a model, and a target Workspace switch initialize a concrete selection from
  the target Host's `preferredSelection`; UI always shows the concrete model and reasoning.
- After the user selects a model, later View updates do not overwrite it.
- Without `preferredSelection` the form stays explicitly non-submittable (no implicit default).
- Create always writes the complete `modelSelection`; Update still allows `null` as the existing protocol's explicit
  clear value, but this form no longer generates it.
- When the selected model changes, reasoning is corrected by the target model's Option Spec; Automation uses the
  model's default level, not the lowest-level rule used by auxiliary model tasks.

## 6. Acceptance

- Team Provider opens the WebView with the right Family, Audience and Team Plan Key; Z.ai / BigModel and personal /
  team URL launch intents do not cross.
- Account models can be edited, toggled and tested; Builtin models still cannot be deleted or have their ID changed.
- Automation: `preferredSelection` initialization, concrete selection persistence, Workspace switching, and the
  failed state without available models.
- Desktop E2E: Team upgrade entry, Account model edit/test, Automation submit without manually picking a model.
- No new Provider permission DTO, default-model sentinel or second model fact.

## 7. Outcome and Verification

Implemented as described above. Provider / Coding Plan / Automation directed tests 318 passed; full unit 1492 files /
12730 tests passed (plus 1 pre-existing skipped file / 25 tests); `packages/ui`, Desktop E2E and root `pnpm
typecheck` passed; root `pnpm lint` 0 errors (33 pre-existing warnings); 28 changed files passed the format check
(root `pnpm fmt:check` is blocked by the pre-existing binary `gb2312.js` and Electron fiddle invalid HTML); `git diff
--check` passed. The Automation Desktop E2E built for production but WebDriver could not create a Chrome session
because the host lacks `xvfb-run` (environment blockage, not a scenario assertion failure); the real-device
interaction still needs to run on a macOS or Xvfb-equipped Linux environment.
