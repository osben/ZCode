# Todo144: Connectivity test uses its own 1-token output budget

Status: implemented and verified (Pro desktop E2E, targeted unit tests and review completed 2026-09-15;
the user confirmed and authorized implementation on 2026-09-12).

Later decision (2026-09-17): on Air, OpenCode Go Luna rejected 1 token and requires at least 16; the user
confirmed unifying the connectivity-test budget to 512. See [Todo159](todo-159-connectivity-512-token-budget.md).
The 1-token behavior below is the history; 512 supersedes it once implemented.

## Decisions and boundaries

- The connectivity test is not content generation and no longer reuses the 5,000-token `auxiliaryModelOptions()` budget. Core `testModelConnectivity()` binds `maxOutputTokens: 1` on its own and still takes the first entry of the model's public ordered reasoning levels.
- The fixed system prompt `You are ZCode connectivity probe.` and user message `hi` are kept as is; no change to prompts, roles, model config or the user's saved selection.
- The full formal Model stream is consumed. A normal finish (including hitting the output limit, `length`) is success, and an empty body or reasoning-only output is allowed. A response that starts without a finish, an error event, auth/parameter rejection or a timeout still fails. Errors are not swallowed and the budget is not auto-raised on retry.
- Budgets of other auxiliary calls (Git, title) are unchanged. No new config, protocol, persistence, migration or Provider special case.
- Some upstreams may reject 1 token or have thinking-budget constraints; these are reported through the formal error boundary. No claim of supporting every vendor, nor of shortening queueing/first-response time.
- The formal Adapter's empty-response retry stays: a non-stop end with no body, no reasoning and no usage may retry once, budget always 1; the generic retry policy is not changed here. The E2E single empty-body success scenario returns `completion_tokens=1`, unlike a zero-usage empty response.

```text
settings click -> existing Service / target Worker -> Core creates this Model
  -> lowest level + 1 token -> original auth/signing/Adapter -> consume the full stream
     normal finish -> success (empty body allowed); error / no finish -> failure
```

The only policy owner is the Core connectivity-test entry; desktop local, remote Worker and phone
shared-host reuse the existing call chain and do not change continuous/replayable, owner, workspace
identity or running Models.

## Verification

- Core: red-then-green for fixed 1 token, lowest reasoning level, empty-body stop/length success, stream error / missing finish failure, unchanged prompts; Git auxiliary budget (5,000) assertion kept.
- Adapter: the final output-budget field of the three protocols is 1 (Anthropic `max_tokens=1`, Chat `max_completion_tokens=1`, Responses `max_output_tokens=1`); the SDK parameter name is not treated as a common field. The reasoning-fallback E2E's old 5,000 assertion was updated.
- E2E: pending `provider-connectivity-prompt.test.ts` extended; a real model-row click with loopback returning an empty-body `length` shows success, 400 still shows failure, final wire budget is 1, Personal/session selection unchanged. Isolated tests only; no Air data changed and no real-account request.
- Production change is only the Core connectivity-test entry (named constant 1, lowest level kept); `auxiliaryModelOptions()`, prompts, stream end/error logic, config and protocol untouched.
- Results: red first (3 budget assertions failed on the old implementation), then Core + Adapter 26/26. Pro desktop E2E (2026-09-15, run `desktop-e2e-20260915073727784-p67110-e4267aabc5aa16a0`, artifacts under the Pro isolated repo's `packages/desktop/.e2e-artifacts/`): both pending specs 2/2. C91-04 verifies the real row click, empty-body length success with usage 1, 400 failure, fixed prompt and wire budget, config/selection unchanged; Todo95 verifies that after adding only a `high` level in the UI, the formal request uses `high` with budget 1. Service + UI routing 8/8. Root typecheck, Core typecheck, Desktop `typecheck:e2e` pass; lint 0 errors / 42 existing warnings; architecture 0 violations.
- The first E2E failures were fixture/test issues (a no-usage fixture triggered the existing empty-response retry; old Todo95 case still assumed the smart switch/levels in the basic area and the old disabled-only unknown-model default); only fixtures and real UI steps were fixed, not the generic retry, layout or model defaults. An earlier local Electron SIGTRAP (exit 133) environment blocker was resolved by the Pro run.

## Open

Phone/remote devices were not tested; real-upstream behavior for 1 token is untested and no claim of
compatibility with all vendors is made.
