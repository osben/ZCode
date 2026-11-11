# Todo159: Raise the connectivity-test output budget to 512 tokens

Status: implemented with local repository verification done. On 2026-11-02 the user reconfirmed the unified 512 and opened the MR. This round changes repository code only, not Air's installed version or personal config.

## Problem and evidence

On a MacBook Air with ZCode 3.12.2, the settings-page test of OpenCode Go (Responses) `gpt-5.6-luna` failed.
Two requests (2026-09-17 18:00:03 and 18:00:06, Asia/Shanghai) returned HTTP 400 with
`reasoning.effort: "none"` and `max_output_tokens: 1`.

- Reproduced with Air's original Key, address, prompt and parameters, the raw server error was: `[integer_below_min_value] Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.`
- A control request changing only `max_output_tokens` to `16` returned HTTP 200, normal text and `response.completed`. This proves the failure is triggered by the output-budget lower bound; 512 is not yet measured and the 16 control result is not a 512 acceptance.
- The original failure records are on Air in `~/.zcode/cli/log/zcode-2026-09-17.jsonl` and `~/.zcode/cli/rollout/model-io-sess_8c93aadb-89ce-4f3e-bee9-8aaa0de12488.jsonl` (the doc stores no Key).
- Before the change, the [Core connectivity-test entry](../../../../apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts) fixes `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS` at `1`; [error normalization](../../../../apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts) shows this 400 as the generic `Provider rejected the model request.` (error-message improvement is out of scope).

## Confirmed target and boundaries

1. Core `testModelConnectivity()`'s own output budget changes from `1` to `min(512, maxOutputTokens.max)` (512 is the target, capped by the model's output limit) for all Providers, with no Luna/OpenCode special case and no dynamic raise on failure.
2. Still the first entry of the model's public ordered reasoning levels; system `You are ZCode connectivity probe.`, user `hi` text, roles and order unchanged, no history or tools.
3. Formal stream and error handling kept: a normal finish (including length) is success with empty body allowed; error, missing finish, timeout, auth and parameter rejection still fail. The existing empty-response retry stays, and the retry reuses the same model-capped budget.
4. Only the connectivity-test budget changes. Ordinary session and Git/title auxiliary budgets, model max-output capability limits, user saved config and selection are unchanged; no new config, protocol, persistence or migration.
5. The budget policy stays solely at the Core connectivity-test entry; desktop, remote Worker and phone shared-host reuse the existing chain with workspaceIdentity, owner and continuous/replayable boundaries kept.

This supersedes [Todo144](todo-144-connectivity-one-token-budget.md)'s "fixed 1 token" decision; its other
contracts and verification history stay. 512 is the target value and is not verified for all upstreams.

## Implementation and acceptance

- [x] First update the connectivity budget descriptions to 512 in the [Settings connectivity-test spec](../design/registry/settings.md) and the [desktop connectivity-test cases](../../../testing/desktop-local-model-provider-p0-e2e-cases.md). The 1 token in the [OpenRouter request contract](../../../openrouter-reasoning-request-contract.md) is an independent Adapter compatibility assertion and keeps its value.
- [x] Update the [Core test](../../../../apps/zcode-cli/packages/core/tests/workspace-generate-text-streaming.test.ts) first to prove the old implementation fails 512, then change the production constant; keep verifying lowest reasoning level, fixed prompt, empty-body stop/length success, stream error / missing finish failure, and the Git auxiliary budget still 5,000.
- [x] Update the [Adapter wire test](../../../../apps/zcode-cli/packages/adapters/tests/connectivity-probe-wire.test.ts): serialized Anthropic `max_tokens`, Chat `max_completion_tokens`, Responses `max_output_tokens` are all 512; keep protocol mapping, prompt and identity assertions.
- [x] Update the [connectivity E2E](../../../../packages/desktop/test/e2e/settings/providers/provider-connectivity-prompt.test.ts) and the [reasoning fallback E2E](../../../../packages/desktop/test/e2e/settings/providers/provider-reasoning-fallback.test.ts): via a real model-row click verify the small-capacity model's budget is 256 and the ordinary model's 512, normal-finish success, 400 still fails, Personal/session selection unchanged. The three protocols are covered by the Adapter wire test and desktop interaction uses Chat as representative; this round does not extend the UI paths.
- Real Air / OpenCode Go acceptance stays a post-release follow-up and is not part of this round's repository tests; the historical 16-token control does not replace the 512 App acceptance.
- [x] Per root and CLI child rules run related tests, typecheck, lint, architecture check and affected E2E, covering affected desktop/phone paths and recording blocked remote/phone environments; self-review the diff and commit after the necessary verification passes.

## First verification (2026-11-02, before review fixes)

- Core test changed to 512 first: the old implementation failed 2 budget assertions and passed 14; after the constant change Core 16 and Adapter wire 6 all pass. Covers lowest reasoning level, fixed Prompt, empty-body finish, error stream, and the auxiliary budget still 5,000.
- This round only adjusts the connectivity-test policy and is not read as proof that all connection timeouts are fixed. Real Air, phone and remote environments were not replayed; serialization of the three protocols is verified by local Adapter tests.
- Linux desktop E2E 2/2 passed, artifact `packages/desktop/.e2e-artifacts/desktop-e2e-20261102-073003-102`: real model-row click budget 512, empty-body length succeeds, 400 fails, config and selection unchanged; the connectivity test after saving an unknown model is also 512. The first run never entered the cases because the specified ChromeDriver cache was missing; it passed with an existing same-major driver.
- Root and CLI typecheck, desktop typecheck:e2e, root and CLI lint, architecture check and format check on changed files passed; root lint 218 and CLI lint 71 existing warnings, no errors. Affected-engineering-test selection was 0; targeted CLI tests and desktop E2E as above.

## Review fix: respect the model output limit

A fixed 512 would make a legitimate model whose limit is below 512 fail the real Model.bind range check before any network request is sent. The budget now takes the smaller of the target and the model limit before Core binding; model capability and saved config are not modified. Core regression covers limits 1, 256, 512 and 1024; C91-04 uses a real Model with limit 256 to verify the request reaches the local service, and Todo95 keeps verifying that an ordinary model uses 512.

Verification: before the fix the limit-1 and limit-256 Core assertions failed and 17 passed; after the fix Core 19 and Adapter wire 6 pass. Two formal Linux desktop E2E cases passed 2/2 (`packages/desktop/.e2e-artifacts/desktop-e2e-20261102-080152-340`): the small-capacity model's real request budget is 256, the ordinary model still 512; success, 400 failure and config isolation assertions pass. Root and CLI types/lint, desktop E2E types, architecture, format and doc checks pass; affected-engineering-test selection 0. Real Air, phone and remote devices were not replayed.
