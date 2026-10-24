# AnalyzeImage Client Wrapper Implementation Plan

> Status: not implemented. This plan is the only current record of the design.

**Goal:** Add a ZCode client-side `AnalyzeImage` tool that analyzes a local image through a
dedicated internal model request carrying only the provider-native `analyze_image` tool, so that
provider-initiated `analyze_image` transcripts in the main turn are never mistaken for ordinary
ZCode tool calls.

**Architecture:** The public tool surface exposes only `AnalyzeImage`; provider-native
`analyze_image` is never exposed to the main turn. The `AnalyzeImage` handler reuses the existing
image read/compression pipeline and sends the image plus the user question to an internal streaming
model request tagged `querySource: "analyze_image_tool"`. The adapter projects the internal
request's tool as provider-native `analyze_image` only for that request. Unsolicited
`server_tool_use analyze_image` blocks in the main turn are isolated as a provider anomaly and
never reach Bash or arbitrary local tool dispatch.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK v6, `@zcode/contracts`, `@zcode/core` tool runtime,
Vitest, existing model-io/fake-fetch verification paths.

## Design boundaries

- `AnalyzeImage` is a ZCode client-side built-in tool; the model-visible name is PascalCase
  `AnalyzeImage`.
- `analyze_image` is the provider-native server tool name and may only appear in the internal
  `AnalyzeImage` side request.
- v1 input takes an explicit local image path: `image_path` plus optional `prompt` (1-4000 chars).
  v1 does not guess "the current image" from conversation history; implicit selection from prompt
  attachments, `Read` image results, or MCP image artifacts is out of scope. If attachment-id input
  is added later, it needs its own spec first.
- Image reading reuses `inferImageMimeFromPath()` and `readImageFile()` from
  `apps/zcode-cli/packages/core/src/tool/handlers/read-image.ts`, inheriting the current
  cross-platform read, size-limit, compression, and error semantics.
- Enable gating mirrors `WebSearch`: the main tool pool exposes `AnalyzeImage` only when the
  provider connection satisfies `providerKind === "anthropic"` and the baseURL hits the allowlist.
- The provider-visible acceptance surface is the final HTTP request body, not the intermediate
  `ModelToolContract`:
  - Main turn `request.body.tools` contains the `AnalyzeImage` function tool and does not contain
    provider-native `analyze_image`.
  - The `querySource: "analyze_image_tool"` internal request's `request.body.tools` contains only
    `{"type":"analyze_image","name":"analyze_image"}`.
  - Unsolicited main-turn `server_tool_use analyze_image` produces no executable ZCode tool call.

## File structure

- Create: `apps/zcode-cli/packages/contracts/src/tools/analyze-image.ts` — input/output schemas,
  provider-native spec, baseURL allowlist, arg conversion; exported from
  `apps/zcode-cli/packages/contracts/src/tools/index.ts`.
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image.ts` — client-side handler,
  internal side request, result formatting.
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/analyze-image-support.ts` — provider
  enable check, statusSink, trace helper; structured like `websearch-support.ts`.
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` — register
  `analyzeImageToolEntry`.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts` — filter tool exposure with
  `supportsProviderNativeAnalyzeImage()`.
- Modify: `apps/zcode-cli/packages/adapters/src/model/tool-transform.ts` — emit the
  `analyze_image` sentinel function tool for the internal provider-native `AnalyzeImage` contract.
- Modify: `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts` — rewrite the
  sentinel to provider-native `analyze_image` on outbound Anthropic-compatible bodies; suppress
  unsolicited `server_tool_use analyze_image` in main-turn streams.
- Modify: `apps/zcode-cli/packages/adapters/src/model/streaming-tool-call-assembler.ts` — second
  defense line dropping provider-executed `analyze_image` tool input.
- Tests: `apps/zcode-cli/packages/contracts/tests/analyze-image.test.ts`,
  `apps/zcode-cli/packages/core/tests/analyze-image.test.ts`,
  `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`,
  `apps/zcode-cli/packages/adapters/tests/websearch.test.ts` (or a new analyze-image test file),
  `apps/zcode-cli/packages/adapters/tests/registry.test.ts`,
  `apps/zcode-cli/packages/adapters/tests/runner.test.ts`.

## Contract definitions (`@zcode/contracts`)

```ts
const ANALYZE_IMAGE_CAPABLE_BASE_HOSTS = ["bigmodel.cn", "z.ai", "z.ai"];

export const AnalyzeImageInputSchema = z
  .object({
    image_path: z.string().trim().min(1).describe("Local image file path to analyze"),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe("Question or instruction for analyzing the image"),
  })
  .strict();
```

`AnalyzeImageOutputSchema` is strict: `imagePath: string`, `prompt?: string`,
`analysis: string`, `durationMs: number (nonnegative)`, optional `modelUsage` (token counts).
`toAnalyzeImageProviderNativeArgs(input)` returns `{ prompt }` only when a prompt exists.

`isAnalyzeImageCapableBaseURL(baseURL)` matches when the parsed hostname equals an allowed host or
ends with `.<allowedHost>`; invalid or missing baseURLs return `false`. Capable examples:
`https://open.bigmodel.cn/api/anthropic/v1`, `https://zcode.z.ai/api/v1/zcode-plan/anthropic`,
`https://api.z.ai/anthropic`. Incapable: `""`, `https://api.openai.com/v1`,
`https://example.test/anthropic`.

```ts
export const ANALYZE_IMAGE_PROVIDER_NATIVE_SPEC: ProviderNativeToolSpec = {
  kind: "provider_native",
  logicalName: "AnalyzeImage",
  providerToolName: "analyze_image",
  fallback: "disabled",
};

export const ANALYZE_IMAGE_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "analyze_image",
  executionMode: "client",
  inputSchema: AnalyzeImageInputJsonSchema,
  outputSchema: AnalyzeImageOutputJsonSchema,
  permission: {
    permission: "read",
    reason:
      "AnalyzeImage reads a local image file and sends it to an internal provider-native image analysis request",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 10_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: { maxLines: 30, direction: "head" },
  },
  timeout: { defaultMs: 60_000, maxMs: 120_000, allowCallOverride: true },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "AnalyzeImage was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "full",
    recordOutput: "summary",
  },
};
```

## Core handler semantics

- Tool metadata: `readOnly: true`, `destructive: false`, `concurrentSafe: true`,
  `timeoutMs: 60_000`, `maxOutputBytes: 20_000`, `sideEffectScope: "network"`,
  `riskLevel: "low"`, `needsApproval: false`. Model-facing description: "Analyze a local image file
  using the provider's native image analysis capability."
- Requires `context.modelPort` and `context.modelRef`; resolves the connection via
  `modelConnectionPort.resolveConnection(...)` and throws
  `CoreErrorType.ConfigurationError` ("ModelConnectionPort is required to check AnalyzeImage
  provider support" / "Failed to resolve AnalyzeImage model" / "Current provider/model does not
  support native AnalyzeImage") when absent, failed, or unsupported.
- Resolves `image_path` against `context.workingDirectory` (`path.isAbsolute` check +
  `path.resolve`); rejects unsupported types with `ToolExecutionFailed` "Unsupported image file
  type".
- When `input.prompt` is empty, uses
  `"Analyze the attached image and return the relevant visual details."`.
- The internal request: `system` "You are an assistant for performing an image analysis tool use."
  plus a `user` message containing the prompt text and one `image` content part (base64 data URL,
  `source.kind: "local_file"` with path/mime/size and `placeholder: input.image_path`); tools are
  exactly one provider-native contract named `analyze_image` (`executionMode: "providerNative"`,
  `args` from `toAnalyzeImageProviderNativeArgs`); `maxOutputTokens: 4096`; `metadata.querySource:
"analyze_image_tool"`; wired `statusSink` and `traceContext`. It uses `streamText`, not
  `generateText`.
- Result: `analysis` is the trimmed stream text; empty text throws `CoreErrorType.ModelError`
  "AnalyzeImage returned no analysis text". Output includes `durationMs` and `modelUsage` when
  present. Model content format: `Image analysis for: <path>`, optional `Prompt: <prompt>`, blank
  line, analysis.
- Runtime exposure filter in `runtime/methods/config.ts`: `tool.name === "AnalyzeImage"` is exposed
  only when `supportsProviderNativeAnalyzeImage(resolveConnection(defaultModelRef))` succeeds;
  resolution failure hides the tool. `supportsProviderNativeAnalyzeImage` is
  `providerKind === "anthropic" && isAnalyzeImageCapableBaseURL(baseURL)`.

## Adapter projection and stream compat

- `toAiSdkProviderNativeTool` dispatches `providerNative.logicalName === "AnalyzeImage"` to a
  dedicated branch that returns `undefined` unless the transform options have
  `providerKind === "anthropic"` and an allowlisted baseURL. The emitted AI SDK tool is a normal
  function-shaped sentinel: the AI SDK Anthropic provider only allowlists known provider-defined
  tool ids, so ZCode rewrites the sentinel to provider-native form at the
  `createAnthropicCompatFetch` boundary.
- Request rewrite (`anthropic-stream-compat.ts`): in outbound JSON bodies, any tool entry named
  `analyze_image` that still carries `input_schema` is replaced by
  `{ type: "analyze_image", name: "analyze_image" }`. Public `AnalyzeImage` function tools are
  never rewritten.
- Stream suppression: `shouldEmitFrame(...)` tracks `suppressedProviderToolUseIds` and drops
  `content_block_start` frames whose block is `server_tool_use` with
  `name === "analyze_image"`, plus the matching bare `tool_result` block by `tool_use_id` (removed
  from the set after suppression). The existing generic bare-`tool_result` suppression and typed
  `web_search_tool_result` behavior stay intact.
- Cause note at the suppression point: some Anthropic-compatible providers return
  `server_tool_use` transcripts for `analyze_image` even when it was not requested; this is not a
  registered ZCode tool call and must be isolated before AI SDK tool-input normalization, so
  malformed input cannot flow into Bash or ordinary tool dispatch.
- Second defense line (`streaming-tool-call-assembler.ts`): drop provider-executed tool input for
  `UNAUTHORIZED_PROVIDER_TOOL_NAMES = new Set(["analyze_image"])` in `handleToolInputStart`, warn
  once with `model.provider_tool.unauthorized_suppressed`. Safe for the side request too, because
  it consumes final text and does not depend on provider `tool_call` events.

## Acceptance scenarios

Contracts:

- `AnalyzeImageInputSchema` accepts `{ image_path, prompt? }` and rejects missing `image_path`.
- Allowlist accepts the capable hosts above and rejects `undefined`, `""`,
  `https://api.openai.com/v1`, `https://example.test/anthropic`.
- `toAnalyzeImageProviderNativeArgs({ image_path, prompt })` → `{ prompt }`.

Core:

- A turn whose model calls `AnalyzeImage` produces exactly one streaming side request with
  `metadata.querySource === "analyze_image_tool"`; its tools are only `analyze_image`
  (providerNative, `logicalName: "AnalyzeImage"`, `providerToolName: "analyze_image"`); its user
  message contains text and an `image` part with the prepared media type; a
  `SessionEventType.ToolCallStarted` event for toolName `AnalyzeImage` is stored.
- `getTools()` includes `AnalyzeImage` for an allowlisted Anthropic connection and excludes it for
  `https://example.test/v1`.
- Main tool pool tests assert `AnalyzeImage` presence in the supported case and absence in the
  unsupported-provider case.

Adapters:

- `toAiSdkTools` keeps the public `AnalyzeImage` model-facing tool named `AnalyzeImage`; maps the
  internal provider-native contract to the `analyze_image` sentinel for capable hosts; returns
  `undefined` (omits) for incapable hosts.
- `createAnthropicCompatFetch` rewrites sentinel `analyze_image` function tools in request bodies
  to `[{ type: "analyze_image", name: "analyze_image" }]` and leaves public `AnalyzeImage` tools
  untouched (still `name: "AnalyzeImage"`, no `type: "analyze_image"`).
- Anomaly stream: an unsolicited `server_tool_use analyze_image` (even with malformed partial
  `input_json_delta`) is fully dropped — output contains no `"type":"server_tool_use"`,
  `"name":"analyze_image"`, `partial_json`, or matching `tool_result`; no
  `model.tool_input.normalize_failed` log.
- Final fake-fetch `streamText` validation (runner): side-request body tools are exactly
  `[{ type: "analyze_image", name: "analyze_image" }]`; main-turn body tools JSON contains
  `AnalyzeImage` and not `"type":"analyze_image"`. A green object-level `ModelToolContract` test
  is not sufficient without this request-body check.
- Real-world check (fake or real model-io): a prompt like `请用 AnalyzeImage 分析 ./screen.png 中的文字`
  ("use AnalyzeImage to read the text in ./screen.png")
  yields `main_turn.tools_contains: ["AnalyzeImage"]`,
  `tools_not_contains: ["\"type\":\"analyze_image\""]`, and side-request
  `tools: [{ "type": "analyze_image", "name": "analyze_image" }]`.

## Verification

Focused suites (`@zcode/contracts`, `@zcode/core`: analyze-image + main-tool-pool; `@zcode/adapters`:
runner + registry + websearch), then `pnpm typecheck` and `pnpm lint`. If root-level checks fail on
pre-existing unrelated files, capture the failing file list and run the narrower package-level
command before reporting the residual failure.

## Risks and mitigations

| Risk                                                                   | Impact                                                                                  | Mitigation                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AI SDK rejects arbitrary Anthropic provider-defined tools              | `tool({ type: "provider", id: "anthropic.analyze_image" })` is dropped by prepare-tools | Use the `analyze_image` sentinel function tool; rewrite the outbound body in `createAnthropicCompatFetch`               |
| Provider injects unsolicited main-turn `server_tool_use analyze_image` | Corrupted tool input can pollute Bash or normal tool dispatch                           | Suppress the block and matching `tool_result` in the Anthropic SSE compat layer; assembler guard as second line         |
| Handler implicitly picks an image from history                         | Wrong source (prompt attachment / Read result / MCP artifact)                           | v1 requires explicit `image_path`; attachment-id support needs its own spec                                             |
| Exposed on an unsupported provider                                     | Main model calls a tool that cannot execute                                             | Gate on `providerKind === "anthropic"` plus baseURL allowlist, aligned with WebSearch                                   |
| Windows paths / working directory                                      | Relative-path resolution errors                                                         | `path.isAbsolute` + `path.resolve(context.workingDirectory, input.image_path)`; reads still go through `FileSystemPort` |
| Noisy production logs                                                  | High-frequency streaming deltas at info level                                           | Per-chunk diagnostics only via existing debug logging; one warn at the anomaly suppression start                        |
