# Todo 47: Provider Connection Test Save Timing and Result Contract Cleanup

> Status: Completed
>
> Date: 2026-08-31
>
> Source: review of the Provider settings page connection test chain

## 1. Problem

The Provider settings page saves the current Provider draft before a connection test to avoid concurrency with
idle/blur auto-save. That intent is right, but the implementation also used `savePersonalModelConfig` /
`deletePersonalModelConfig` to rewrite model Personal Rules from a Renderer model snapshot. Formal model editing
already uses the atomic `savePersonalModelDraft` with Settings revision checks, so the two old Model Config write
interfaces bypassed revision checks, could overwrite newer Personal Rules with a stale Renderer snapshot, and formed
a second model save protocol. The test result kept two useless abstractions: Services maintained a second error
classification from HTTP status, error text and nested `cause/data` although the UI only consumed the message, and
the UI re-projected a single formal Model test into `ModelConnectivitySummary` with a deleted multi-Endpoint
`noEndpointResult` branch.

## 2. Decisions

### 2.1 Save before test, through one commit primitive

The fix is not "test directly": a Provider input may still sit in the UI debounce, not yet in the Service's Provider
operation queue, and merely waiting for an existing operation misses that window.

```text
current Provider input draft -> cancel/consume the same idle debounce -> reuse blur/idle's single Provider Draft Commit
 -> wait for that Provider's save queue -> Worker refreshes the formal Registry
 -> create and test the formal Model by providerId/modelId
```

- Add a save only when an uncommitted Provider draft really exists.
- Connection tests never rewrite Model Config. If a test is ever started from the model-editing popup, the popup
  must first complete its own atomic `savePersonalModelDraft`; the old interfaces do not return.
- Personal Config, Registry and the formal Model stay the sole config and execution authority; no test-specific
  Provider/Model.

### 2.2 Old Model Config write interfaces fully retired

`savePersonalModelConfig` and `deletePersonalModelConfig` are removed from every upper-layer public entry and
forwarding: `IProviderSettingsService`, `ProviderSettingsFacade`, `ProviderSettingsMutationTarget`, Provider
Runtime / Config Runtime public forwarding, the UI hook, connection-test helper, mocks and old tests. Model editing
uses `savePersonalModelDraft` only; the exact Personal Rule create/update/delete is an internal implementation of
that atomic operation, not exposed to UI/Services.

### 2.3 Connection result keeps only the real message

The UI has no error-category interaction, so Services' guessed `auth`, `model_not_found`, `rate_limit`, `network`,
`server`, `unknown` categories and deep HTTP status search are deleted:

```ts
type ModelConnectivityResult = { success: true } | { success: false; error: { message: string } };
```

If the product ever needs per-error-type actions it must reuse the formal Model/Adapter structured errors, not
string classification in Provider Settings.

### 2.4 Old multi-Endpoint UI projection deleted

`ModelConnectivitySummary`, `resolveModelConnectivitySummary`, `noEndpointResult` and their old tests are deleted.
The component consumes `ModelConnectivityResult` directly: success shows the model identity, failure shows the
error message returned by the formal execution chain.

### 2.5 Request attribution header unchanged

`x-zcode-session-type` is the request-source attribution header consumed by the Coding Plan server. All formal model
requests keep sending it (`main`, `subagent` or `other`); Provider connection tests are ownerless auxiliary calls and
keep sending `other`. It is not Provider Config and gets no Provider special-case here.

## 3. Acceptance

- UI: clicking test before idle fires; blur and test concurrent; repeated clicks; save failure; test failure. Idle,
  blur, switch cleanup and the connection test share `commitPendingDraft`, and the test waits for that Provider draft
  commit before calling the formal `providerId/modelId` test entry.
- Services: Provider operations serialize; the real error message passes through unclassified.
- Provider: all model edits go only through the revision-guarded `savePersonalModelDraft`; old interfaces are
  mechanically zero.
- Bootstrap/Core: after Worker refresh the formal Model is created exactly, the lowest reasoning still takes
  `values[0]`.
- Desktop E2E: after typing Provider fields without blur, testing immediately uses the latest config and produces
  exactly one effective draft commit.
- `rg`/`dep:refs` show no residue of the old interfaces, Summary and `noEndpointResult`.

Completion: pre-test save and ordinary Provider auto-save share one commit primitive; connection tests never write
Personal Model Rules from a Renderer snapshot; `savePersonalModelConfig`, `deletePersonalModelConfig`,
`ModelConnectivitySummary`, `noEndpointResult` and duplicate error classification are gone from production code and
public types; the formal Registry/Model, Account dynamic credentials, `x-zcode-session-type` and lowest-reasoning
behavior are unchanged.

## 4. Outcome

Implemented as decided. UI, Services, Provider, CLI Adapter/Bootstrap/Core directed unit tests passed; Desktop E2E
typecheck passed. The desktop case `coding-plan-team-usage` built, but the Linux environment lacks `xvfb-run` so Chrome
cannot start without a display; the runtime E2E remains an environment block, not a business assertion failure.
