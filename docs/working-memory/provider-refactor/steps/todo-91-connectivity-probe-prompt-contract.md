# Todo 91: Fixed Connectivity-Test Prompt Contract

> 2026-09-12: the output budget was later changed to an independent 1 token by Todo144; the 5,000 budget in this document's history is no longer a current requirement. The exact Prompt contract is unchanged.

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implemented with targeted review, offline request verification and Pro isolated Electron verification (2026-09-08). The server whitelist was not modified and no real account was used to probe it. Baseline `c017752329`, `provider-refactor-e2e-recovery`.

## 1. Ruling

The connectivity test uses this fixed message, keeping exact text, case, punctuation, roles and order:

```yaml
system: You are ZCode connectivity probe.
user: hi
```

- Keep the current formal Model's streaming execution chain, consume the full stream and keep the existing error handling.
- Do not restore staging's Start Plan entitlement-probe branch; a successful entitlement query is not a model-connectivity success.
- Add no explanation, i18n copy, history, tools or second system message; no other request (normal chat, title, Wiki, Subagent) reuses this Prompt.
- Ordinary API Providers and Account Providers share the same template. Off-Peak stays hidden: no settings-page test entry, no Ticket fetched or consumed.
- No restoration of the old Host HTTP Probe; no change to model selection, account connection, Personal Config, persistence format or migration.

## 2. Background

`core/src/runtime/methods/workspace-generate-text.ts` `testModelConnectivity()` sent only the user message `Reply briefly to confirm connectivity.` (introduced in `8ea78019f7`, pinned by tests after `49e1f83710d`). The old Start Plan helper added the system + hi in `2ae01c7584`, but `3162baa586` then changed the upper normal entry to query only billing/balance; fixed staging `16d999f6a48b` and local `origin/staging` `a311537aa6` both keep the early return. "The old helper still exists" therefore does not mean staging currently sends this Prompt, nor that the server whitelist is obsolete. The user says the server may limit account requests by a Prompt whitelist; the client repo cannot prove its current content, so this ruling adopts an explicit fixed template and does not claim the server is configured or a real account verified; real accounts must not be used to probe repeatedly before confirmation.

## 3. Impact and state ownership

Layer: commit-effect / request-content contract; scope is the connectivity test only, with no change to session or restore semantics.

| UI scenario | Shared implementation | Source and validation | Authoritative execution | Mode and isolation |
| --- | --- | --- | --- | --- |
| Account detail model-row test | Detail -> ModelRowInput / useModelProviders; row-level pending and result feedback | saved Provider/Model; formal Registry and Request Auth validation | Settings Service -> Agent protocol -> `testModelConnectivity` -> `Model.streamText` | Desktop/Web shared; existing target-Environment routing, current connection unchanged |
| ordinary/template-instance model-row test | InlineEditableProviderCard -> same row control and hook | flush the Provider draft first; the service waits for related writes, Worker refreshes the Registry | same; API format and option mapping by the formal Adapter | no temporary Registry, no change to other models or running requests |

```text
click test -> wait for the existing save boundary -> formal Registry creates the Model
 -> fixed system + hi -> formal Adapter / Request Auth -> streaming request in the current API format
```

must-inspect: `testModelConnectivity` message construction and the Adapter's final bodies (Anthropic system/messages, Chat messages, Responses instructions/input); should-inspect: `workspace-generate-text-streaming.test.ts` pinning the old user text (replaced by the new contract, plus no-history/no-tools assertions); conditional: Account requests still depend on current credentials and the normal request-safety validation chain (restoring the Prompt never bypasses auth); invariant-only: save/refresh, lowest public reasoning level, output budget (auxiliary calls up to 5,000 at the time), timeout/retry, error feedback and workspace isolation; evidence-only: the old staging helper, upper Service and old entitlement tests explain history and are not restored wholesale. Call path: ModelProviderSection -> useModelProviders -> Provider Settings Service -> zcodeAgentService -> workspace-model-runtime -> Core `testModelConnectivity` (codegraph unavailable; traced directly).

## 4. Implementation and cleanup boundary

1. Update the effective `design/registry/settings.md` first, then write failing tests.
2. Keep exactly one fixed template / named constant at the message construction point; no scattered synonymous Prompts; no config item, UI input or protocol parameter.
3. Delete the superseded old string and its assertions; do not copy staging's unreachable Start Plan helper; no Provider-ID special cases.
4. The exact text is the hard contract; serialization reuses the existing Adapter. The final body keeps system and user roles (never merging system into user). If the server needs a specific serialization the current Adapter cannot give, clarify the server requirement first, then discuss a minimal adaptation; never guess.
5. Output budget, streaming, lowest reasoning, source headers, request-safety validation, timeout and retry are untouched. Other differences from the earlier audit were not approved for restoration; the source-header risk needs separate discussion, so this Todo does not claim all gateway-rejection risk is removed.

## 5. Acceptance and outcome

| Case | Scenario | Assertion / evidence | Result |
| --- | --- | --- | --- |
| C91-01 | Core connectivity test, mock Model collects the request | exactly system + user, fixed exact text and order, no tools/history; stream error still fails | four identity assertions failed (4) then passed at the single construction point; added throw, error-event and no-finish failure assertions; old low reasoning / budget / full-stream and Wiki behavior kept |
| C91-02/03 | Anthropic / Chat / Responses formal Adapters with an offline transport; Account (Start/personal/Team) and ordinary Providers with fake credentials | intercepted final body: system/user text and roles, stream=true, request model ID unchanged, no tools, credential isolation, Start still goes through the model request (not back to entitlement probe); no fall-back to the network | `connectivity-probe-wire.test.ts` uses formal config resolution, runner options and the three SDK Adapters; six ordinary/Account identity groups verified |
| C91-04 | isolated Electron: click test on a model row | final request meets the contract, success/failure feedback normal, normal chat selection and config unchanged | pending E2E with a case-local loopback server returning success SSE / 400 failure; both final requests are the fixed template; Personal file, connection selection and Composer draft unchanged |
| non-connectivity consumers | title, Wiki, chat, Subagent | invariant-only; no change to the generic `generateWorkspaceText` or shared auxiliary options to carry this Prompt | not widened |
| real-account whitelist probing | repeated different Prompts | pruned: ban risk, never an automated verification method | forbidden |
| all brands x protocols x themes | full permutation | pruned: the fixed text has no locale/theme branch; three protocols plus account/ordinary representatives suffice | representative |

Production code changes only the connectivity-test message and a named constant; generic `generateWorkspaceText`, Adapter, Request Auth, protocol, budget, retry and connection state are untouched; the old Prompt assertions are deleted and staging's old branch is not restored. Verification (2026-09-08): CLI 3 targeted files 32 tests pass; Core typecheck and root typecheck pass; root lint 0 errors / 40 existing warnings. Pro `desktop-e2e-20260908-102455-529`, 1/1, isolated directory `/Users/dev/zcode-todo93-e2e.88xgST`, Agent rebuilt and the rerun reuses only that build. The first E2E `desktop-e2e-20260908-102321-138` showed the success/failure UI but its failure assertion wrongly expected the raw gateway text; the formal chain normalizes to `Provider rejected the model request.` and the assertion was corrected without changing product error handling. E2E file: `packages/desktop/test/e2e/settings/manual-review/pending/provider-connectivity-prompt.test.ts`; the fixed whitelist forbids appending a Prompt marker, so it identifies requests by an independent `E2E_C91_MODEL`, the complete message array and a localhost endpoint; synthetic / fast-text responses are for the probe only; it stays pending and was not promoted. Mobile/remote and a real Account network were not verified. A CLI Core package-level lint fails on many unrelated files (for example over 400 lines); the one production file passes targeted oxlint and root lint passes, but package-level lint is not recorded as green.

## 6. Handoff and unconfirmed items

Todo 90 independently owns the shared add/edit model draft; MFJS styling and override highlighting are not mixed in. The one external unconfirmed item: which fields, roles and serialization form the server's current whitelist matches. This records the client target and does not claim the server accepts it; offline verification does not equal real-account whitelist acceptance.
