# Model Media Capability Projection

> Historical implementation plan (2026-06-24), kept as the capability-projection contract.
> Referenced from `docs/superpowers/specs/2026-08-21-model-provider-modality-settings-design.md`.
> Implementation lives in `apps/zcode-cli/packages/core/src/runtime/helpers/media-capability.ts`.

**Goal:** for models that explicitly do not support image or PDF input, replace media content
with a stable text placeholder before the final provider-visible request is built, so historical
images or tool images cannot repeatedly cause HTTP 400.

## Architecture

- No restrictions at media entry points (sending, drag-drop, Read/Bash/MCP tool output). Real
  session history keeps original media. Provider-visible messages are projected to text at the
  last hop in the core runtime (`projectMessagesForMediaCapabilities` runs before
  `projectMessagesForMediaBudget`).
- The AI SDK adapter keeps a second-line fallback (`toAiSdkMessages` with
  `supportsImages` / `supportsPdf`) so calls bypassing core still never send explicitly
  unsupported media.
- Compact requests stay text-only via `maxMediaBytes: 0` regardless of capabilities.

## Capability Semantics (tri-state)

`true` = explicitly supported, `false` = explicitly unsupported, `undefined` = unknown — never
strip. Absent capability on a custom model must never be treated as `false`.

`resolveRuntimeModelInputCapabilities(modelRef, modelCatalog)`:

- returns `undefined` when `modelRef` is undefined;
- reads `modelCatalog.overrides["provider/model"].supportsImages` / `.supportsPdf` first;
- falls back only to deterministic defaults for known models (e.g. text-only DeepSeek flashes);
- never converts absent custom capability into `false`.

The capability is injected at runtime bootstrap, refreshed in `session-facade.ts` `setModel`, and
refreshed with `contextWindow` / `maxOutputTokens` when workspace catalog metadata changes.
Protocol schema fields (`supportsPdf`) stay optional for backward compatibility.

## Projection Behavior

- `supportsImages === false`: every `image` block becomes a text block.
- `supportsPdf === false`: `file` blocks with `mediaType: application/pdf` and a `dataUrl` payload
  (no extracted text) become text blocks.
- `true` or `undefined`: media is kept unchanged.
- Clone only when a block changes; return the original `messages` array when nothing is omitted.
- Preserve `toolCalls` and `cacheControl` via shallow clone only when content changes.
- Adapter-side tool media projection stays bounded: `supportsImages === false` does not add
  follow-up image parts; the textual tool result remains available via `modelMessageContentToText`.

Placeholder text (verbatim):

```text
[Media omitted from provider request because the selected model does not support image input.]
[Media omitted from provider request because the selected model does not support PDF input.]
```

The adapter fallback uses the same neutral omission text instead of an `ERROR` string, so the
model is not induced to apologize every turn.

## Logging

Projection counts (`omittedImageCount` etc.) go through `debug` logging; never log data URLs or
media payloads.

## Acceptance

- Media entry points remain unchanged; raw session history remains unchanged.
- Provider-visible requests are sanitized only when capability is explicitly `false`; unknown
  custom models keep prior behavior.
- User attachment media and tool-result media both disappear from text-only provider requests,
  replaced by the neutral omission text.
