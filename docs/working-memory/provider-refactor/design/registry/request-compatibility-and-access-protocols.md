# Model Request Compatibility and Provider Access Product Protocols

> Status: Current effective design; Compatibility Config has been deleted
>
> Last updated: 2026-10-07 (official version security verification details moved out; this document changed to neutral summary)

This document defines the ownership of model historical playback, API request encoding differences, and Provider Access/product protocols. Model Config no longer provides a universal Compatibility container; protocol differences must belong to existing real domain contracts, otherwise they do not enter config.

## 1. General Principles

After model responses enter ZCode, the default compliance principle is lossless replay:

```text
Real content / reasoning / metadata returned by Provider
                        |
                        v
              Canonical Message saving
                        |
                        v
              Historical messages and persistence
                        |
                        v
              Adapter request serialization
                        |
                        v
          Complete, verbatim rewriting on same model re-runs
```

"Verbatim" means semantic and value unchanged; it does not require each intermediate layer to use the same wire JSON. If a Provider's non-standard fields would be discarded by AI SDK's standard types, Adapters can perform lossless projections at the input/output boundaries; projections can only move truly returned data and cannot guess, fabricate, or repair non-existent values through the process.

New Adapter protocol projections must simultaneously satisfy the following conditions:

1. The current AI SDK or target Adapter's standard encoding cannot express the service's real protocol;
2. The behavior can be proven by current official contracts, ZCode product/service contracts, or reproducible real requests;
3. It belongs to an existing Model/Provider contract; Adapters do not need to hardcode specific IDs;
4. Failure behavior is explicit; compatibility projections do not silently drop data;
5. It is not another domain's Access, security verification, queuing, or auth state machine.

No universal Compatibility fields or Personal Model Rules are re-established for protocol exceptions.

## 2. Field Ownership Decisions

| Existing field/behavior                                  | Final ownership                                   | Decision                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible reasoning replay                       | No additional config                              | Retain real reasoning, encoded by current OpenAI-compatible SDK `reasoning_content`                                                                                                      |
| Anthropic-compatible tool-call without thinking          | Canonical replay                                  | Do not fabricate synthetic thinking for empty tool-calls; only replay what the server truly returns                                                                                      |
| Anthropic thinking signature                             | Canonical reasoning metadata + Adapter projection | Save real signature/redacted data and replay verbatim; do not fabricate real signatures                                                                                                  |
| Z.ai text/tool block signature candidate patch           | Not adopted                                       | Not in current HEAD/staging; do not bring candidate branches from external branches into this refactor; can independently test real service wire, but testing does not mean auto-merging |
| `omitMaxOutputTokens`                                    | Deleted                                           | Old GitHub Copilot special judgment is not retained for currently unsupported integrations                                                                                               |
| `maxOutputTokensRequestField`                            | Deleted                                           | Currently does not support Snowflake Cortex; do not retain fields, Rules, or request body rewriting for it                                                                               |
| Official version access security verification fields     | `zhipu-account/start-plan`                        | Removed from Model Config; dynamic materials are still provided by the official version product pipeline                                                                                 |
| `failureProtocol`                                        | `zhipu-account/off-peak`                          | String marker, cross-process errors, and UI state machine behaviors remain unchanged                                                                                                     |
| Official version request security verification admission | Provider request protocol                         | Determined by explicit Access and official domain name; specific rules are only maintained in the official version                                                                       |
| `requiresMfjsToolSchema`                                 | Model Config                                      | Retained as model/API request encoding facts; only enabled when explicitly matched Model Config; errors on failure; placed last in settings page                                         |

## 3. Reasoning Historical Replay

### 3.1 OpenAI-compatible

ZCode must save the reasoning block the server truly returns, and return the same canonical history to the Adapter. The current
`@ai-sdk/openai-compatible` can already encode assistant reasoning content as `reasoning_content`, so there is no longer a need to re-extract, delete reasoning parts, or manufacture
`reasoning_content: ""` for empty tool-calls through `withOpenAiCompatibleReasoningContent()`.

The target chain is:

```text
Real reasoning_content
        |
        v
AI SDK reasoning part + provider metadata
        |
        v
ZCode canonical reasoning block
        |
        v
AI SDK assistant reasoning part
        |
        v
OpenAI-compatible SDK encoding reasoning_content
```

If future SDK versions regress, this should be discovered through request body contract testing and fixed at the SDK boundary; a second fact source judged by model name must not be restored.

### 3.2 Standard Anthropic Behavior

Anthropic's real thinking blocks, empty thinking, signatures, and redacted thinking must be saved completely and replayed verbatim in tool-use re-runs. The following two types of "empty" must be distinguished:

```text
Server returns empty thinking + real signature
└─ Real response facts, must be saved and replayed verbatim

Server completely does not return thinking
└─ By default, cannot fabricate empty thinking / empty signatures
```

Some Anthropic-compatible streams place real thinking signatures in `content_block_start`, while AI SDK only reads
`signature_delta`. `anthropic-stream-compat` can project this already-received real value to standard events identifiable by the SDK; this is lossless
transport, not signature generation.

### 3.3 No Synthetic Empty Thinking

All Anthropic-compatible Providers uniformly execute canonical replay: when the server returns real thinking/signatures, they are saved and replayed verbatim; when the server does not return, blocks or signatures are not fabricated. This behavior does not accept Model IDs, Provider IDs, or config switch分流.

2026-09-10 supplement: Historical signature compatibility judgment is separated from the above block encoding rules. Old Coding Plan IDs and same-service Individual/Team IDs
can be judged as replay-compatible by集中的, precise pure functions within Adapters; model IDs must still be consistent. Z.ai and BigModel groups are isolated; other
Providers retain precise ID judgment; no additional configs or persisted fields are added; historical identities are not rewritten; this function is not used for selection or auth.
Complete boundaries and verification are documented in [Reasoning History Replay](../../../../../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md#coding-plan-provider-identity-compatibility).

### 3.4 Z.ai text/tool block signatures: Candidate implementations not adopted

Current HEAD and `origin/staging` do not have text/tool block signature replay; relevant implementations only exist in unmerged candidate branches. This refactor does not adopt or transplant this candidate implementation. Real Z.ai service wire tests can be performed separately to confirm whether non-standard signatures exist; but test results only form new evidence,
and do not let candidate branches automatically enter the design.

If this is re-projected in the future based on real evidence, the principle must still be "send what you receive":

```text
Real non-standard block.signature
        |
        v
Adapter captures and stores in corresponding block metadata
        |
        v
Persistence does not lose
        |
        v
SDK serializer boundary rewrites back the original block
```

The standard Anthropic SDK currently only allows thinking blocks to carry signatures, so if this wire behavior truly exists in the future, the SDK boundary must be re-designed; missing signatures cannot be generated, nor empty thinking fabricated.

## 4. Output Token Upper Limit Compatibility

### 4.1 Delete GitHub Copilot Omit Special Judgment

`omitMaxOutputTokens=true` is currently used for old GitHub Copilot + GPT matching. GitHub Copilot is not a Built-in Provider officially supported in this round; this historical rule has no current product contract support, so delete fields, Built-in Rules, Runner branches, and related construction tests. When Copilot is officially integrated in the future, redesign according to then-interface; do not restore old rules as defaults.

### 4.2 Snowflake Cortex Currently Unsupported

`maxOutputTokensRequestField="max_completion_tokens"` currently renames the SDK-generated `max_tokens` only for Snowflake Cortex. This round's decision is to currently not support Snowflake, so delete that field, Built-in Rules, request body rewriting, and dedicated tests; do not retain compatibility reads. If Snowflake is officially supported in the future, redesign according to then-interface; do not restore old rules as default facts.

## 5. Provider Access Product Protocols

### 5.1 Official Version Access Security Verification

Start Plans require additional access security verification in official versions. This is a product protocol, not a static capability or API encoding preference of a model.
`access.type=zhipu-account + mode=start-plan` is the only static dispatch fact; dynamic materials are generated and injected by the request-time pipeline,
and are not persisted into Model Config. Specific implementations are maintained only in official versions.

### 5.2 Official Version Request Security Verification

Individual/Team Coding Plans, explicit manual plan Access, and official domain name requests pass additional request security verification in official versions.
Specific admission rules and implementations are maintained only in official versions. The open design only reserves the following boundaries:

- The type of both manual Accesses is preserved as-is during override, serialization, key editing, and model binding; it cannot be downgraded to ordinary `api-key` at save time;
- The admission judgment uses the configuration snapshot bound by the current Model; it does not read the real-time Registry, does not modify saved Access, Templates, or Model Selection,
  and does not add migrations;
- It does not belong to Model Config; it does not infer admission by model ID, Template ID, or Key content;
- Connection tests, normal requests, sub-tasks, local and remote executions continue to use shared Adapters; does not change desktop continuous, mobile replayable, or Host/Worker state ownership;
- Key acquisition only uses `apiKeyManagementUrl` to display metadata, with a single entry for personal/team shared templates; no identity-specific link fields are added,
  and authentication is not inferred from links (Todo116).

### 5.3 Off-Peak Execution Protocol Belongs to Access

Off-Peak queuing, Tickets, and failure retries are execution protocols for accessing this product service; they are not model facts.
`access.type=zhipu-account + mode=off-peak` is the only static dispatch fact.

The current Adapter throws string errors containing `off-peak-ticket-expired`, which Desktop/Renderers then identify by strings or regex. This runtime state machine
remains equivalent in this round; do not handily change it to structured errors just because of config ownership migration.

This round maintains:

- Delete Model Config `failureProtocol`; enable the same behavior through complete Provider Access's `mode="off-peak"`;
- Existing ticket marker strings;
- Existing cross-process propagation and UI identification;
- Off-Peak queue, Ticket, recovery, and scheduling semantics.

Do not handily change to structured errors in this round, nor disguise a "field reorganization" as a product state machine migration. It is retained as a clear technical debt and will be independently designed in the future.

### 5.4 Coding Plan Request Source Attribution Headers

All model requests send `x-zcode-session-type` at the Adapter's per-request layer, with value domains of `main`, `subagent`,
`side_chat`, `other`. It represents the host session type; titles, Memory, and tool internal requests inherit from the host; call purposes are expressed independently through
`x-zcode-query-source`. Workspace-independent requests such as connection tests are classified as `other`.

This Header is a request-level source attribution; it is not a Provider/Model static capability, nor auth materials:

- Does not enter Provider Config, Model Config, Registry, or Active Models;
- Does not infer by Provider ID, Model ID, Endpoint, or Access Mode;
- Produced by the current call context and overrides the same-name forged value in Provider static Headers;
- Streaming, non-streaming, and Adapter retries use the same construction logic; retries do not change source classification.

The complete classification table and compatibility rules are documented in
[`Agent Model Request Attribution Header`](../../../../superpowers/specs/2026-06-09-agent-model-request-session-header-design.md).

## 6. Settings Boundaries

The first version of the Model editing page does not display:

- Zhipu Provider Access's `family` and `mode`;
- The deleted `openai-reasoning-content`, `omitMaxOutputTokens`, `maxOutputTokensRequestField`, and
  Model Config `failureProtocol`.

`requiresMfjsToolSchema` still belongs to editable Model Config but is placed at the end of the advanced area. Conversion is only executed when this field is explicitly true; conversion failures must report errors, not silently send another Tool Schema.

## 7. Implementation and Verification Thresholds

1. First prove that the current OpenAI-compatible SDK can natively replay non-empty reasoning with final HTTP request body tests, then delete ZCode helpers;
2. Delete GitHub Copilot omit fields and rules; no compatibility reads retained;
3. Official version security verification dispatched by `zhipu-account.mode` and explicit Access; dynamic materials and runtime states do not enter Config;
4. Off-Peak enablement fact is `mode=off-peak`; string markers and existing runtime state machines remain equivalent;
5. DeepSeek uniformly executes canonical replay; synthetic empty-thinking or Compatibility Configs are not retained;
6. Z.ai text/tool signature candidate implementations are not adopted; real wire tests are independent evidence tasks;
7. Delete Snowflake fields and dedicated request rewriting; currently unsupported Snowflake;
8. Adapters do not restore universal Compatibility Config, Registry queries, or ID hardcoding.

## 8. Current Evidence Records

This section only saves verifiable entries relied upon by this round's decisions; no heavy historical audits per commit or per-leaf are established.

- Anthropic Official Extended Thinking: <https://platform.claude.com/docs/en/build-with-claude/thinking>. Requires tool-use re-runs to completely, verbatim return real thinking blocks and signatures, and allows real empty thinking carrying valid signatures;
- DeepSeek Official Thinking Mode: <https://api-docs.deepseek.com/guides/thinking_mode>. OpenAI format tool re-runs require returning server-side real `reasoning_content`;
- DeepSeek Official Anthropic API: <https://api-docs.deepseek.com/guides/anthropic_api>. Currently only declares support for `thinking`,
  `tool_use`, `tool_result` formats; no synthetic empty thinking or signature requirements;
- Current `@ai-sdk/openai-compatible@2.0.60`'s
  `convert-to-openai-compatible-chat-messages.ts` encodes assistant reasoning parts as `reasoning_content`; SDK
  changelog explicitly includes multi-round tool call reasoning content since 2.0.20;
- Current `apps/zcode-cli/packages/adapters/src/model/anthropic-reasoning-metadata.ts` is the current synthetic empty thinking implementation;
  `apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md` saves historical internal design claims, but is not external service evidence;
- Current DeepSeek Replay fixtures' `syntheticReason` explicitly indicates that the related wire shape is constructed data and cannot independently prove server-side constraints;
- text/tool block signature candidate commit `70546bde31` is only located at
  `origin/anthropic-block-signature-replay-staging-latest`, not the current HEAD or `origin/staging` ancestors;
- Off-Peak current marker constant is `off-peak-ticket-expired`; Adapters and UIs still pass and identify through error strings; this round preserves existing behavior.
