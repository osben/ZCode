# OpenAI-compatible Leading System Message Merge Design

## Feature/change summary

| Field                 | Value                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Change                | Before an OpenAI-compatible request is sent, consecutive leading system messages are merged into one                      |
| User-visible surfaces | No direct UI change; legacy chat templates no longer error on, or keep only the last of, multiple leading system messages |
| Existing code owners  | `apps/zcode-cli/packages/adapters/src/model/transform.ts`, `system-message-compat.ts`                                     |
| Evidence              | Adapter unit tests and the real `@ai-sdk/openai-compatible` fake-fetch wire body                                          |
| Out of scope          | Anthropic, OpenAI Responses, gateway/custom provider, core ContextBuilder, mid-conversation system semantics              |

## Background and root cause

Core ContextBuilder intentionally emits three system messages (CLI prefix, stable body, dynamic body) for
different stability levels and cache boundaries. The AI SDK OpenAI-compatible Chat Completions converter sends
them one by one and does not merge on the caller's behalf.

OpenAI-compatible constrains only the HTTP shape, not the backend model's chat template. Some legacy templates
accept a single leading system; others overwrite the earlier value while iterating multiple system messages.
The multi-part system therefore stays in the provider-neutral core and is normalized at the OpenAI-compatible
adapter serialization boundary.

## Clarified decisions

1. Merging multiple system messages before an OpenAI-compatible request is a compatibility fix; core prompt
   assembly is unchanged.
2. Only the consecutive leading system prefix is merged. Mid-conversation system messages are not hoisted to
   the front; the causal position of a system message never changes.
3. The adapter does not reject a system message that appears after the leading prefix (such a check was
   judged over-defensive and removed); it passes through unchanged.

## Request contract

Applies only when `providerKind === "openai-compatible"`:

1. Identify the consecutive system prefix starting at message index 0.
2. With two or more system messages in the prefix, join their text in the original order with the exact
   separator `\n\n`: no trim, no reordering, no loss of whitespace.
3. The merged result takes the position of the original first system message; user, assistant and tool
   message content and order are unchanged.
4. Zero or one leading system message creates no extra transform.
5. A system message appearing after the prefix keeps its original position and content; the adapter does not
   promote, demote, rewrite or reject mid-conversation system messages.
6. Anthropic, OpenAI, gateway and custom providers keep the original multi-part system.
7. Core ContextBuilder keeps the multi-part system, so the Anthropic cache boundary is not broken.

```text
provider-neutral core          adapter                         HTTP wire
system(prefix)  ┐
system(stable)  ├─ openai-compatible ─> system(prefix\n\nstable\n\ndynamic)
system(dynamic) ┘                                  │
user / assistant / tool ───────────────────────────┴─> original order unchanged

non-OpenAI-compatible ─────────────────────────────────> all kept as is
user ... system(mid-conversation) ─────────────────────> passed through in place, no hoist
```

## Domain scope and high-risk cross-products

| Domain                        | Include? | Decision                                                                            |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------- |
| Model/provider/runtime config | yes      | `providerKind` is the only switch; the adapter owns the transform                   |
| Conversation/session behavior | limited  | Only message order is protected; session/history/persistence are untouched          |
| Mobile remote/replayable      | no       | Desktop and mobile ultimately share the agent adapter; delivery semantics unchanged |
| Workspace identity            | no       | No workspace-related fields are read                                                |
| Protocol/schema               | no       | `ModelInputMessage` and `@zcode/protocol` are unchanged                             |

The only high-risk cross-product is provider kind x system position x system count. Client, workspace and
stream/generate are all collapsed by the same adapter normalization function and are not separate product
states.

## Candidate combinations and pruning

| Candidate ID | Provider                        | Input shape                 | Expected effect                                  | Status   |
| ------------ | ------------------------------- | --------------------------- | ------------------------------------------------ | -------- |
| OCS-01       | OpenAI-compatible               | 0 system                    | Converted as is                                  | accepted |
| OCS-02       | OpenAI-compatible               | 1 leading system            | Converted as is                                  | accepted |
| OCS-03       | OpenAI-compatible               | 2+ leading system           | Merged into one, order and text unchanged        | accepted |
| OCS-04       | OpenAI-compatible               | system after a user message | Position and content kept, no hoist              | accepted |
| OCS-05       | Anthropic/OpenAI/gateway/custom | 2+ leading system           | Not merged                                       | accepted |
| OCS-06       | generate/stream                 | Same message input          | Same result because both share `toAiSdkMessages` | accepted |

Pruned: desktop/mobile, local/remote, continuous/replayable, workspace identity. They decide transport or
runtime ownership before the request enters the adapter and do not change this design's pure
message/`providerKind` input.

## Accepted cases

| Case ID   | Setup                                 | Action                               | Assertions                                             | Evidence layers     | E2E status   |
| --------- | ------------------------------------- | ------------------------------------ | ------------------------------------------------------ | ------------------- | ------------ |
| OCS-01/02 | OpenAI-compatible, 0/1 system         | Call message transform               | Count and content unchanged                            | unit                | adapter unit |
| OCS-03    | Three leading system + normal history | Call transform and real SDK generate | Wire has one system; later roles/order unchanged       | unit + network body | adapter wire |
| OCS-04    | System inserted after a user message  | Call transform                       | Position and content kept; leading prefix still merges | unit                | adapter unit |
| OCS-05    | Anthropic, two leading system         | Call transform                       | Still two system messages                              | unit                | adapter unit |

No conversation-session E2E catalog/matrix entry is added: the fix adds no user-interaction state, the real
SDK wire test already covers the final acceptance surface, and desktop E2E would only repeat the adapter
request contract.

## Implementation boundary

- A dedicated pure function lives in `system-message-compat.ts` and is called in `toAiSdkMessages()` before
  per-role conversion.
- `buildProviderRequestMessages()` is unchanged, keeping the core/provider projection neutral.
- The final JSON fetch wrapper does not parse and rewrite unknown bodies; the typed message boundary preserves
  the role and order constraints.
- The merged system inherits the cache-control marker of the last leading system. The marker projects only to
  Anthropic provider options and does not affect the OpenAI-compatible wire; it is kept to avoid needless
  intermediate-state drift in the adapter.

## Verification

- `model-transform.test.ts`: OCS-01 to OCS-05.
- `openai-compatible-system-messages-wire.test.ts`: real SDK fake fetch, asserting the final `messages`.
- `pnpm --filter @zcode/adapters typecheck`.
- Root `pnpm typecheck` and `pnpm lint`.
