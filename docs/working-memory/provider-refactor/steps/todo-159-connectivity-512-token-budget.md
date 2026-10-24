# Todo159: Raise the connectivity-test output budget to 512 tokens

Status: pending; on 2026-09-17 the user confirmed the target value 512. This round only recorded the Todo
and investigation evidence; no product code or Air config was changed.

## Problem and evidence

On a MacBook Air with ZCode 3.12.2, the settings-page test of OpenCode Go (Responses) `gpt-5.6-luna` failed.
Two requests (2026-09-17 18:00:03 and 18:00:06, Asia/Shanghai) returned HTTP 400 with
`reasoning.effort: "none"` and `max_output_tokens: 1`.

- Reproduced with Air's original Key, address, prompt and parameters, the raw server error was: `[integer_below_min_value] Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.`
- A control request changing only `max_output_tokens` to `16` returned HTTP 200, normal text and `response.completed`. This proves the failure is triggered by the output-budget lower bound; 512 is not yet measured and the 16 control result is not a 512 acceptance.
- The original failure records are on Air in `~/.zcode/cli/log/zcode-2026-09-17.jsonl` and `~/.zcode/cli/rollout/model-io-sess_8c93aadb-89ce-4f3e-bee9-8aaa0de12488.jsonl` (the doc stores no Key).
- The [Core connectivity-test entry](../../../../apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts) fixes `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS` at `1`; [error normalization](../../../../apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts) shows this 400 as the generic `Provider rejected the model request.` (error-message improvement is out of scope).

## Confirmed target and boundaries

1. Core `testModelConnectivity()`'s own output budget changes from `1` to `512` for all Providers, with no Luna/OpenCode special case and no dynamic raise on failure.
2. Still the first entry of the model's public ordered reasoning levels; system `You are ZCode connectivity probe.`, user `hi` text, roles and order unchanged, no history or tools.
3. Formal stream and error handling kept: a normal finish (including length) is success with empty body allowed; error, missing finish, timeout, auth and parameter rejection still fail. The existing empty-response retry stays, and the retry budget is also 512.
4. Only the connectivity-test budget changes. Ordinary session and Git/title auxiliary budgets, model max-output capability limits, user saved config and selection are unchanged; no new config, protocol, persistence or migration.
5. The budget policy stays solely at the Core connectivity-test entry; desktop, remote Worker and phone shared-host reuse the existing chain with workspaceIdentity, owner and continuous/replayable boundaries kept.

This supersedes [Todo144](todo-144-connectivity-one-token-budget.md)'s "fixed 1 token" decision; its other
contracts and verification history stay. 512 is the target value and is not verified for all upstreams.

## Implementation and acceptance (all open)

- [ ] First update the connectivity budget descriptions that still apply to 512 in the [Settings connectivity-test spec](../design/registry/settings.md), the [desktop connectivity-test cases](../../../testing/desktop-local-model-provider-p0-e2e-cases.md) and the [OpenRouter request contract](../../../openrouter-reasoning-request-contract.md); keep low-budget Adapter tests unrelated to this item.
- [ ] Update the [Core test](../../../../apps/zcode-cli/packages/core/tests/workspace-generate-text-streaming.test.ts) first to prove the old implementation fails 512, then change the production constant; keep verifying lowest reasoning level, fixed prompt, empty-body stop/length success, stream error / missing finish failure, and the Git auxiliary budget still 5,000.
- [ ] Update the [Adapter wire test](../../../../apps/zcode-cli/packages/adapters/tests/connectivity-probe-wire.test.ts): serialized Anthropic `max_tokens`, Chat `max_completion_tokens`, Responses `max_output_tokens` are all 512; keep protocol mapping, prompt and identity assertions.
- [ ] Update the [connectivity E2E](../../../../packages/desktop/test/e2e/settings/manual-review/pending/provider-connectivity-prompt.test.ts) and the [reasoning fallback E2E](../../../../packages/desktop/test/e2e/settings/manual-review/pending/provider-reasoning-fallback.test.ts): via a real model-row click verify wire budget 512, normal-finish success, 400 still fails, Personal/session selection unchanged; add a Responses regression scenario that rejects budgets below 16, reproducing this Luna failure condition.
- [ ] Measure Air's OpenCode Go / `gpt-5.6-luna` completing the connectivity test normally at 512, recording the running version, request budget and terminal state (the direct API 16-token control does not replace post-change App acceptance).
- [ ] Per root and CLI child rules run related tests, typecheck, lint, architecture check and affected E2E, covering affected desktop/phone paths and recording blocked remote/phone environments; self-review the diff and commit after the necessary verification passes.

Current delivery is only the above to-do list: code, the real 512 request and post-change App acceptance are all pending.
