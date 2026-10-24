# Todo 126: GLM Vision Badge, Flash PDF and Coding Plan API Turbo Defaults

> Status (2026-09-11): implemented under the whole-batch Goal authorization; local verification/review passed; whole-batch
> final acceptance was pending; online config not published.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md`

## 2026-09-12 Supplement: Turbo Disabled by Default on Ordinary APIs

The user asked for Z.AI API / BigModel API Turbo to be disabled by default. `GLM-5-Turbo` was already false; the exact
template rules `GLM-5V-Turbo` of `zai-standard-api` and `bigmodel-standard-api` are added as false and the Built-in
revision incremented. Only the default enable state changes: no model deleted, no capability or personal override change,
nothing for Coding Plan, Account or third parties. Existing rule resolution is reused with no UI, protocol or migration
change; online config is not published.

Verification: real Built-in Source shows both Turbo models off on both templates, 5.3/Flash still on, a personal explicit
enable still wins, and third parties without templates keep their defaults. Result: revision 22 -> 23, only two
`GLM-5V-Turbo.enabled` entries changed; the new cases first reproduced both defaults as true, and after the fix config /
integrity / Release 34 items pass; typecheck passes, lint 0 errors / 42 existing warnings, architecture 0 violations. No UI
or execution code change, no extra interaction E2E, nothing pushed or published.

## 1. Background and Final Rulings

While checking model settings the user raised Flash PDF, the GLM vision badge and the plan Turbo defaults. They were
reproduced through the real Built-in Node Source / rule resolution, not just JSON reading:

- GLM-5.3-Flash image and video are on in the general model rule, but PDF was on only in the Anthropic Messages
  model+API rule and false under Chat Completions and Responses.
- The `zai-api` and `bigmodel-api` Coding Plan API templates had no default-off rule for GLM-5-Turbo; existing instances or
  a manually added model inherited the general `enabled: true`.
- GLM-4.7's general rule turns vision off and the official plan site's all-model vision rule turns it on; **the user
  confirmed this behavior is fine and it is unchanged.**
- GLM-5.3's general rule turns vision off and the official plan endpoint turns it on. Latest user confirmation: Coding Plan
  GLM-5.3 image input comes from a server-side bridge, not native model vision; the difference from Flash is that only
  Flash has native vision. So **a hardcoded frontend display exception is allowed: hide the vision badge for Coding Plan
  GLM-5.3 in the model settings page and model selection menu, with the underlying capability config unchanged.** This
  replaces the earlier "no hardcoded vision badge" constraint.

Nothing else (other model capabilities, defaults or UI) is changed.

## 2. GLM-5.3-Flash: PDF On by Default for All Access

In `config/provider/zcode-builtin.json`: add `supportsPdf: true` to `config.properties.inputFormat` of the existing
GLM-5.3-Flash general `modelRules` member (alongside image and video); delete the `modelApiRules` rule that only enabled
PDF for GLM-5.3-Flash under `anthropic-messages` (no duplicate declaration); keep the existing Flash match expression and
case/prefix/suffix rules.

```text
GLM-5.3-Flash general model rule: supportsImage / supportsVideo / supportsPdf true -> shared by official and third-party access, all three API formats
```

Third parties are explicitly included (no endpoint allowlist, no template restriction); covers Anthropic Messages, OpenAI
Chat Completions and OpenAI Responses; no extension to ordinary GLM-5.3, GLM-4.7 or other models; no change to image,
video or other capabilities. A personal explicit config still wins by existing override rules (a user's manual PDF off or
manual config mode is not cleared). This adjusts the recommended capability declaration and does not authorize reworking
PDF attachment encoding, read limits or the Adapter.

## 3. Coding Plan API: GLM-5-Turbo Default Off

Add one exact rule per template in `templateModelRules` of the same file:

```typescript
{ templateId: "zai-api", modelId: "GLM-5-Turbo", config: { enabled: false } }
{ templateId: "bigmodel-api", modelId: "GLM-5-Turbo", config: { enabled: false } }
```

For the Z.AI Coding Plan API and BigModel Coding Plan API manual-Key templates. Only the default changes (no model removed
from or added to the list, no model ID change, user can still enable it manually); personal explicit enable/disable keeps
its priority and nothing is migrated or deleted; account-login personal/team/Start/off-peak Providers, ordinary API
templates and third-party defaults are unchanged; not widened into a generic Turbo-off rule and no Account exact-rule change.

## 4. Coding Plan GLM-5.3: Hide the Vision Badge

> 2026-09-12 supplement: [Todo137](todo-137-start-plan-glm53-vision-badge.md) adds the Start Plan to the same display
> scope; the original scope is kept below.

- Background: the server bridge lets GLM-5.3 process images but the model is not natively vision; this only corrects what
  the badge conveys and does not revoke existing image use.
- Display scope: the model list of the model settings page and the vision badge of the corresponding model in the model
  selection menu; the shared selector entries are checked (not only settings or only the main chat box); desktop and phone
  Web stay consistent.
- Provider scope: Z.ai / BigModel personal and team Coding Plan account connections, and manual Coding Plan API Key
  Providers. Only GLM-5.3 in that scope matches; GLM-5.3-Flash keeps the badge; other Providers/models are unaffected.
- A frontend display exception as required: both pages reuse one display judgment; the general capability fact is not
  changed (do not set `supportsImage` false and do not filter out the whole model to hide the badge). Image upload, input
  format config, attachment support, the server bridge and actual model requests stay as-is; no capability schema,
  protocol field or data migration, and no restructuring of the native vs bridge capability system.

## 5. Release and Implementation Boundary

```text
built-in model / API / site / template rules -> existing personal override -> same Resolver -> existing UI and execution chain read it
```

After the section 2/3 built-in config changes, increment the builtin `revision` (check the latest revision at
implementation; do not hardcode the survey-time value) through the existing release and refresh mechanism; the section 4
frontend display change needs no revision bump. No change to `schemaVersion`, schema, protocol, file layout, tables or
migration. GLM-4.7 vision and the official plan all-model vision site rule are unchanged; GLM-5.3 gets only the section 4
badge display exception, not an actual capability change. The [Todo125](./todo-125-model-settings-help-copy.md) question
marks and copy and the settings layout are not implemented here. No automatic publish of online config or push.

## 6. Verification (all done)

Following test-first and the architecture gates, reusing the builtin integrity, alias, template and personal-override tests
under `packages/provider-node/test/`: failing cases first (Flash PDF default true for non-Anthropic formats; Turbo default
false for both plan API templates); real builtin loading and resolution (official/third-party, three API formats, existing
case and prefix/suffix Flash aliases all give PDF=true while ordinary GLM-5.3 and GLM-4.7 are not widened); personal
explicit PDF=false still wins and manual config mode is not reset by recommendation updates; Turbo default false on both
plan templates and still enableable by a personal explicit enable with other models, ordinary API, third parties and
Account personal/team/Start/off-peak defaults unchanged; GLM-4.7's site vision result and GLM-5.3's actual capability
config unchanged; display cases (personal/team accounts and manual Coding Plan API Key GLM-5.3 show no vision badge in the
settings page and selection menu, Flash still shows it, other Providers/models not hit); image input and capability
editing still work from the original config with browser verification of both display entries (desktop/phone layout,
themes, i18n; a single component passing is not written as all-end acceptance); stale test expectations and revision
assertions updated with related regressions, `pnpm typecheck`, `pnpm lint`, architecture check and E2E upkeep batched by
risk; honest results and unverified scope (rule resolution passing is not a real model endpoint accepting PDF nor all UI
and platforms verified).

## 7. Result

All three implemented: builtin revision 20 -> 21, the Flash general PDF declaration replaces the Messages duplicate; two
exact Turbo default-false rules for the manual plan templates; the UI shares `shouldShowModelVisionBadge`, wired into the
settings card and every `buildRegistryModelSelectGroups` consumer entry.

- Tests first failed (5: non-Messages Flash PDF, plan-template Turbo, three kinds of plan vision badge); after the fix 6
  files / 96 unit tests pass. The real Node Built-in Source / ordered rules cover three formats, official/third-party,
  prefix/suffix/case; normal personal override and manual-provider-model keep PDF=false. Ordinary API Turbo was already
  default false (the first test draft's wrong assumption was corrected, not changed to true).
- Two browser cases pass (390 Chinese light / 1200 English dark), each checking personal/team account / manual plan Key:
  settings page and the real ModelConfigSelect menu both hide the GLM-5.3 vision badge and keep Flash's; underlying
  `supportsImage` is still true; upload/encoding/request code unchanged. Screenshots `/tmp/zcode-provider-settings-batch/vision-*.png`.
- Root typecheck, lint (0 errors / 41 warnings) and architecture (0 violations) pass. Review against the old rules: GLM-4.7
  / GLM-5.3 capability, Account exact rules and lists unchanged; the selection item's `supportsVisionInput` serves only the
  badge and takes no part in attachment execution validation.
- The browser verification is isolated shared components, not real phone Host/Electron whole-chain; no real PDF service
  request; no online config published. Chinese font limits follow the batch record; overall final review still needed.
