# User Message Provider Request Ordering Plan

> **Status:** Complete for the 2026-06-06 ordering-only scope, except the postponed first-turn attachment-vs-userContext ordering TODO. The file path is kept for existing references; the active scope is no longer adjacent user-message merge.

## Goal

Without changing the session store / UI transcript / replay storage schema, make the user messages sent to the model provider satisfy the confirmed provider-visible ordering rules:

- Attachment-like / system-reminder user context bubbles in the request-local projection to just before its real user prompt.
- Within one real user turn, the file / image / url prompt attachments ZCode supports sit before the real prompt. Whether the first-turn attachment should pass the request-level userContext to sit before the prompt is a postponed TODO.
- A direct pasted image that is already a block in the same real user `content[]` keeps its original block order; it is not treated as attachment bubble-up.
- No generic merge of adjacent `role: "user"` messages; that stays postponed/future.
- Runtime metadata is stripped before provider request output; the cache-control marker is finalized only on the last non-system message.

## Scope

In scope:

- User-message ordering/projection before the provider request.
- Request-local bubble-up of attachment-like runtime user entries.
- Provider-visible block order of same-turn file/image/url prompt attachments.
- Source-only runtime metadata identity, so a user's literal `<system-reminder>` is not misclassified.
- Cache-control marker finalization on the latest non-system message after projection.
- Regular turns, compact summary requests and goal completion verifier requests use the same provider projection.
- Focused tests, prompt-trajectory E2E and repeat-stability evidence.

Out of scope:

- Merging adjacent user messages into one `content[]`.
- New `ContentPart` or session persistence schema rewrites.
- UI/session transcript display order.
- New system-reminder source wording.
- ToolSearch/deferred tools, MCP instructions/resources, skill discovery.
- Exact wording, or attachment types ZCode has no producer for.

## Ordering rules

- An attachment-like message bubbles bottom-up in the request-local projection until it meets an assistant or tool-result user boundary.
- A direct pasted image is a content block of the user message, not an attachment message; its order is decided by the original user content.
- ZCode has no standalone attachment message taxonomy. The provider-visible producers taking part in ordering are file / image / url prompt attachments and provider-visible synthetic user context marked by runtime metadata.
- A real user prompt that starts with `<system-reminder>` must be recognized as real user by runtime metadata/source, never by a text-tag heuristic.

## Stability requirement (P000)

- The projection is pure, deterministic and idempotent.
- It reads no time, random number, UUID, environment variable or other non-input state.
- It does not mutate `MessageHistory`, input entries, message content blocks, toolCalls or the cacheControl object.
- It does not trim, normalize, escape or rewrite existing text.
- It does not sort alphabetically or by descriptor; only runtime/history order and explicit bubble boundaries reorder.
- Direct pasted image blocks are not moved by attachment bubble-up.
- Cache-control is cleaned and reset on the final provider messages: keep the system prompt's own cacheControl, clear old cacheControl on non-system messages, and mark only the last non-system message.
- Prompt-trajectory evidence must check the exact provider-visible order/shape.

## Phases (all complete unless noted)

- **A0 Runtime metadata prerequisite** (done by system-reminder work): `RuntimeMessageMetadata` keeps only `{ source }`; `RuntimeMessageEntry = { message, metadata? }` is used for request-local projection; `toRuntimeEntries()` deep-clones metadata-bearing entries; `toModelMessages()` stays provider-clean; synthetic notice persistence/hydration roundtrips `metadata.runtimeMessage: { source }`; real user vs literal `<system-reminder>` depends on source metadata.
- **A1 Provider request ordering helper**: `buildProviderRequestMessages(...)` takes `RuntimeMessageEntry[]` and outputs provider-clean `ModelInputMessage[]`; attachment-like entries bubble to just after the assistant/tool-result boundary, before the user run; adjacent user messages are not merged; metadata/source/descriptor fields never reach the provider body; with `applyCacheControl: true` the last non-system entry gets `{ type: "ephemeral" }` (cache-control no longer carries real_user identity); direct pasted image blocks keep their order.
- **A2 Request wiring**: regular turns, compact summary auxiliary requests and goal completion verifier auxiliary requests use the projected messages; the `ModelRequest` event and the adapter call use the same projected messages.
- **A3 Same-turn prompt attachment order**: live turn `buildUserContentFromTurn(...)` outputs attachment blocks before the prompt; text file/source attachments keep the SR12 synthetic Read reminder text; image attachments keep the image block before the prompt; URL/resource attachments keep the resource block before the prompt; direct pasted images are outside attachment sorting (a future standalone paste entry needs its own producer branch). Open TODO: for the first turn / no assistant boundary, prompt attachments in the same real user `content[]` still cannot pass the request-level userContext. Reversing the `content[]` push order cannot fix it; it needs a separate provider-only split or request-local content projection design.
- **A4 Validation**: focused tests `provider-request-messages`, `prompt-attachments`, `runtime-reminders`, `runtime-tool-loop`, `runtime-trace`, `runtime-compact`, `session-history-hydrator`; `@zcode/core` typecheck; touched-file oxlint; prompt-trajectory E2E `user-message-provider-request-order` (OpenAI-compatible and Anthropic Messages snapshots) and `user-message-pasted-image-order` (pasted inline image placeholder stays after the real prompt text). Package-level `pnpm --filter @zcode/core lint` still fails on pre-existing `max-lines` errors in `src/workflow/lifecycle.ts` and `src/subagent/runner.ts`.

## Postponed

| Item | Why postponed |
| --- | --- |
| Adjacent user-message merge | Removed for now to avoid provider-visible shape churn and cache instability; re-enabling needs its own phase, its own cache-stability E2E and an Anthropic Messages request shape review. |
| First-turn attachment vs request-level userContext ordering | Not changed. File/url/local-image attachments in the same real user `content[]` can sit before the real prompt but cannot pass the leading request-level userContext. Only reversing push order gives `userContext -> prompt -> attachment`, which is worse; needs a provider-only split or request-local content projection. |
| Full attachment taxonomy | Only ZCode-supported file/image/url/system-reminder context is handled; add other types when a producer exists. |
| Native session store `content[]` refactor | The goal is request-local provider projection, not persistence/UI transcript changes. |

## Prompt-trajectory evidence

```bash
pnpm --filter @zcode/prompt-trajectory record -- --fixture testcases/user-message-provider-request-order/fixture.json --out out/user-message-provider-request-order/integration-e2e-final
pnpm --filter @zcode/prompt-trajectory record -- --fixture testcases/user-message-pasted-image-order/fixture.json --out out/user-message-pasted-image-order-latest
```

Expected derived snapshots per trajectory: `*.openai_request_body.json`, `*.anthropic_request_body.json`. Expected provider-visible shape: attachment/context before the real prompt, adjacent user messages still separate, cache-control on the latest non-system provider message.

Observed:

- `out/user-message-provider-request-order/integration-e2e-final/trajectories/0001.{openai,anthropic}_request_body.json`
- `out/user-message-pasted-image-order-latest/trajectories/0001.{openai,anthropic}_request_body.json`
- The OpenAI-compatible snapshot keeps adjacent user messages separate; the Anthropic Messages snapshot shows the provider-normalized adjacent-user content block shape; the pasted-image snapshot keeps the real prompt text before the pasted image placeholder.
