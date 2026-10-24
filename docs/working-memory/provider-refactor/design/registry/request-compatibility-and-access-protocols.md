# Model Request Compatibility and Provider Access Product Protocols

> Current effective design; Compatibility Config has been deleted.
>
> Last updated: 2026-10-07 (official-version security verification details moved out; this document is now a neutral summary).

This document owns model historical replay, API request encoding differences, and Provider Access/product protocols. Model Config provides no universal Compatibility container; a protocol difference must belong to an existing real domain contract or it does not enter config.

## 1. General Principles

After model responses enter ZCode, the default compliance principle is lossless replay:

```text
Real content / reasoning / metadata returned by Provider
  -> Canonical Message saving
  -> Historical messages and persistence
  -> Adapter request serialization
  -> Complete, verbatim rewriting on same-model re-runs
```

"Verbatim" means semantic and value equality, not identical wire JSON at every layer. Where AI SDK standard types would discard a Provider's non-standard fields, Adapters may do lossless projections at the input/output boundaries — projections only move truly returned data and never guess, fabricate, or repair values.

A new Adapter protocol projection requires all of:

1. The current AI SDK or target Adapter's standard encoding cannot express the service's real protocol.
2. Behavior is provable by current official contracts, ZCode product/service contracts, or reproducible real requests.
3. It belongs to an existing Model/Provider contract; Adapters hardcode no specific IDs.
4. Failure is explicit; compatibility projections never silently drop data.
5. It is not another domain's Access, security verification, queuing, or auth state machine.

No universal Compatibility fields or Personal Model Rules are re-established for protocol exceptions.

## 2. Field Ownership Decisions

| Existing field/behavior                          | Final ownership                                   | Decision                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible reasoning replay               | No additional config                              | Retain real reasoning, encoded by current OpenAI-compatible SDK `reasoning_content`                                                             |
| Anthropic-compatible tool-call without thinking  | Canonical replay                                  | Never fabricate synthetic thinking for empty tool-calls; replay only what the server truly returns                                              |
| Anthropic thinking signature                     | Canonical reasoning metadata + Adapter projection | Save real signature/redacted data and replay verbatim; never fabricate signatures                                                               |
| Z.ai text/tool block signature candidate patch   | Not adopted                                       | Not in current HEAD/staging; do not import candidate branches from external branches into this refactor; independent real-wire tests allowed but never auto-merge |
| `omitMaxOutputTokens`                            | Deleted                                           | The old GitHub Copilot special case is not kept for currently unsupported integrations                                                          |
| `maxOutputTokensRequestField`                    | Deleted                                           | Snowflake Cortex currently unsupported; keep no fields, Rules, or request body rewriting for it                                                 |
| Official-version access security verification    | `zhipu-account/start-plan`                        | Removed from Model Config; dynamic materials come from the official-version product pipeline                                                    |
| `failureProtocol`                                | `zhipu-account/off-peak`                          | String marker, cross-process errors, and UI state machine behavior unchanged                                                                    |
| Official-version request security verification   | Provider request protocol                         | Decided by explicit Access and official domain; specific rules are maintained only in the official version                                      |
| `requiresMfjsToolSchema`                         | Model Config                                      | Kept as model/API request-encoding fact; enabled only on explicit Model Config match; errors on failure; placed last on the settings page        |

## 3. Reasoning Historical Replay

### 3.1 OpenAI-compatible

ZCode saves the reasoning block the server truly returns and hands the same canonical history back to the Adapter. The current `@ai-sdk/openai-compatible` already encodes assistant reasoning as `reasoning_content`, so `withOpenAiCompatibleReasoningContent()` no longer needs to re-extract, strip reasoning, or manufacture `reasoning_content: ""` for empty tool-calls. Chain: real `reasoning_content` → AI SDK reasoning part + provider metadata → ZCode canonical reasoning block → AI SDK assistant reasoning part → OpenAI-compatible SDK `reasoning_content`.

If a future SDK regresses, discover it through request-body contract tests and fix it at the SDK boundary; never restore a second fact source keyed by model name.

### 3.2 Standard Anthropic Behavior

Anthropic's real thinking blocks, empty thinking, signatures, and redacted thinking are saved completely and replayed verbatim in tool-use re-runs. Distinguish two "empties":

```text
Server returns empty thinking + real signature
└─ Real response fact; save and replay verbatim

Server returns no thinking at all
└─ Never fabricate empty thinking / empty signatures
```

Some Anthropic-compatible streams put the real thinking signature in `content_block_start` while AI SDK reads only `signature_delta`. `anthropic-stream-compat` may project that already-received real value into SDK-recognizable standard events — lossless transport, not signature generation.

### 3.3 No Synthetic Empty Thinking

All Anthropic-compatible Providers run canonical replay uniformly: real thinking/signatures are saved and replayed verbatim; absent blocks or signatures are never fabricated. This behavior has no per-Model-ID, per-Provider-ID, or config-switch branching.

2026-09-10 supplement: historical-signature compatibility judgment is separate from the block encoding rules. Old Coding Plan IDs and same-service Individual/Team IDs are judged replay-compatible by centralized, precise pure functions inside Adapters; model IDs must still match. Z.ai and BigModel groups stay isolated; other Providers keep precise ID judgment. No new configs or persisted fields; historical identities are not rewritten; the function is never used for selection or auth. Complete boundaries and verification: [Reasoning History Replay](../../../../../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md#coding-plan-provider-identity-compatibility).

### 3.4 Z.ai text/tool block signatures: Candidate implementations not adopted

Current HEAD and `origin/staging` have no text/tool block signature replay; implementations exist only in unmerged candidate branches, and this refactor adopts or transplants none of them. Real Z.ai service wire tests may run separately to confirm whether non-standard signatures exist, but results are new evidence only and never let candidate branches auto-enter the design.

If this is re-projected later on real evidence, the principle stays "send what you receive": real non-standard `block.signature` → Adapter captures and stores it in block metadata → persistence keeps it → SDK serializer boundary writes the original block back. The standard Anthropic SDK currently allows signatures only on thinking blocks, so real future wire behavior would force an SDK-boundary redesign — missing signatures are never generated and empty thinking never fabricated.

## 4. Output Token Upper Limit Compatibility

### 4.1 Delete GitHub Copilot Omit Special Judgment

`omitMaxOutputTokens=true` served the old GitHub Copilot + GPT matching. GitHub Copilot is not a Built-in Provider in this round; with no current product contract, the field, Built-in Rules, Runner branches, and related construction tests are deleted. When Copilot is officially integrated, redesign per the then-current interface; never restore old rules as defaults.

### 4.2 Snowflake Cortex Currently Unsupported

`maxOutputTokensRequestField="max_completion_tokens"` renamed the SDK-generated `max_tokens` only for Snowflake Cortex. Snowflake is unsupported this round: the field, Built-in Rules, request body rewriting, and dedicated tests are deleted with no compatibility reads. Future official support redesigns per the then-current interface; old rules are not restored as default facts.

## 5. Provider Access Product Protocols

### 5.1 Official Version Access Security Verification

Start Plans require extra access security verification in official versions. This is a product protocol, not a static model capability or API encoding preference. `access.type=zhipu-account + mode=start-plan` is the only static dispatch fact; dynamic materials are generated and injected by the request-time pipeline and never persisted into Model Config. Implementation lives only in the official version.

### 5.2 Official Version Request Security Verification

Individual/Team Coding Plans, explicit manual plan Access, and official-domain requests pass additional request security verification in official versions. Admission rules and implementation are maintained only in the official version; the open design reserves only these boundaries:

- Manual Access types are preserved as-is through override, serialization, key editing, and model binding, and are never downgraded to ordinary `api-key` at save time.
- Admission judgment uses the configuration snapshot bound to the current Model: it reads no live Registry, modifies no saved Access, Templates, or Model Selection, and adds no migrations.
- It does not belong to Model Config and never infers admission from model ID, Template ID, or key content.
- Connection tests, normal requests, sub-tasks, and local/remote executions share the same Adapters; desktop-continuous, mobile-replayable, and Host/Worker state ownership are unchanged.
- Key acquisition uses `apiKeyManagementUrl` for display metadata only, one entry for personal/team shared templates; no identity-specific link fields, and authentication is never inferred from links (Todo116).

### 5.3 Off-Peak Execution Protocol Belongs to Access

Off-Peak queuing, Tickets, and failure retries are execution protocols for accessing the product service, not model facts. `access.type=zhipu-account + mode=off-peak` is the only static dispatch fact.

The Adapter currently throws string errors containing `off-peak-ticket-expired`, which Desktop/Renderers identify by string or regex. This runtime state machine stays equivalent this round — the config ownership migration must not casually convert it to structured errors. Maintained: delete Model Config `failureProtocol` (same behavior via complete Provider Access `mode="off-peak"`); existing ticket marker strings; existing cross-process propagation and UI identification; Off-Peak queue, Ticket, recovery, and scheduling semantics. This stays a clear technical debt for future independent design; do not disguise a "field reorganization" as a state machine migration.

### 5.4 Coding Plan Request Source Attribution Headers

Every model request sends `x-zcode-session-type` at the Adapter per-request layer, with values `main`, `subagent`, `side_chat`, `other`. It names the host session type; titles, Memory, and tool-internal requests inherit the host; call purpose is expressed independently by `x-zcode-query-source`. Workspace-independent requests such as connection tests are `other`.

The header is request-level source attribution — not a Provider/Model static capability and not auth material: it never enters Provider Config, Model Config, Registry, or Active Models; it is never inferred from Provider ID, Model ID, Endpoint, or Access Mode; it is produced from the current call context and overrides same-named forged values in Provider static Headers; streaming, non-streaming, and Adapter retries share the same construction logic and retries never change source classification.

Full classification table and compatibility rules: [`Agent Model Request Attribution Header`](../../../../superpowers/specs/2026-06-09-agent-model-request-session-header-design.md).

## 6. Settings Boundaries

The first model editing page does not display: Zhipu Provider Access `family`/`mode`; the deleted `openai-reasoning-content`, `omitMaxOutputTokens`, `maxOutputTokensRequestField`, and Model Config `failureProtocol`.

`requiresMfjsToolSchema` stays editable but sits at the end of the advanced area. Conversion runs only when explicitly true; conversion failure must error, never silently send a different Tool Schema.

## 7. Implementation and Verification Thresholds

1. Prove with final HTTP request-body tests that the current OpenAI-compatible SDK replays non-empty reasoning natively, then delete ZCode helpers.
2. Delete GitHub Copilot omit fields and rules; keep no compatibility reads.
3. Official-version security verification is dispatched by `zhipu-account.mode` and explicit Access; dynamic materials and runtime states never enter Config.
4. Off-Peak enablement fact is `mode=off-peak`; string markers and the existing runtime state machine stay equivalent.
5. DeepSeek runs canonical replay uniformly; no synthetic empty thinking or Compatibility Config kept.
6. Z.ai text/tool signature candidate implementations are not adopted; real-wire tests are independent evidence tasks.
7. Delete Snowflake fields and dedicated request rewriting; Snowflake is currently unsupported.
8. Adapters restore no universal Compatibility Config, Registry queries, or ID hardcoding.

## 8. Current Evidence Records

Only verifiable entries this round's decisions rely on; no per-commit or per-leaf historical audits.

- Anthropic Official Extended Thinking: <https://platform.claude.com/docs/en/build-with-claude/thinking>. Tool-use re-runs must return real thinking blocks and signatures verbatim; real empty thinking with a valid signature is allowed.
- DeepSeek Official Thinking Mode: <https://api-docs.deepseek.com/guides/thinking_mode>. OpenAI-format tool re-runs must return the server's real `reasoning_content`.
- DeepSeek Official Anthropic API: <https://api-docs.deepseek.com/guides/anthropic_api>. Declares support only for `thinking`, `tool_use`, `tool_result` formats; no synthetic empty thinking or signature requirement.
- Current `@ai-sdk/openai-compatible@2.0.60` `convert-to-openai-compatible-chat-messages.ts` encodes assistant reasoning parts as `reasoning_content`; the SDK changelog includes multi-round tool-call reasoning content since 2.0.20.
- `apps/zcode-cli/packages/adapters/src/model/anthropic-reasoning-metadata.ts` is the current synthetic empty-thinking implementation; `apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md` holds historical internal design claims, not external service evidence.
- Current DeepSeek replay fixtures' `syntheticReason` marks the wire shape as constructed data and cannot alone prove server-side constraints.
- text/tool block signature candidate commit `70546bde31` exists only on `origin/anthropic-block-signature-replay-staging-latest`, not in current HEAD or `origin/staging` ancestors.
- The Off-Peak marker constant is `off-peak-ticket-expired`; Adapters and UIs still pass and identify it through error strings; this round preserves existing behavior.
