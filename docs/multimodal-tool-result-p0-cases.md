# Multimodal Tool Result P0 Regression Cases

Verify that when ZCode converts MCP/builtin tool results into Anthropic
`tool_result.content[]`, multi-block text, images and status text are not silently dropped by the
BigModel Anthropic-compatible API. The cases cover both boundaries:

```text
tool/MCP CallToolResult
        ↓
ZCode model-content projection
        ↓
Anthropic tool_result.content[]
        ↓
BigModel compatibility projection
        ↓
model-visible content
```

The P0 runner reads only environment variables; no API keys in code or fixtures:

```bash
ANTHROPIC_API_KEY=... \
ZCODE_MODEL=glm-x-preview-f \
ZCODE_BASE_URL=https://open.bigmodel.cn/api/anthropic \
node scripts/multimodal-tool-result-p0.mjs
```

## Cases

| ID                         | Input block order                       | Goal                                            | Failure meaning                    |
| -------------------------- | --------------------------------------- | ----------------------------------------------- | ---------------------------------- |
| `text-three-blocks`        | `text0, text1, text2`                   | all three nonces visible, order preserved       | compat layer drops later text      |
| `mcp-text-image-text`      | `text, image, text`                     | both texts and the in-image marker visible      | plain MCP mixed result loses parts |
| `android-screenshot-shape` | `text, image`                           | metadata and in-screenshot marker both visible  | Android screenshot image dropped   |
| `ios-screenshot-shape`     | `text, image`                           | metadata and in-screenshot marker both visible  | iOS screenshot image dropped       |
| `browser-multiple-images`  | `imageA, imageB, text`                  | both images and the text visible                | Browser Use drops later images/text|
| `cua-observation`          | `image, frame_ref, ax_tree, outcome`    | raster, frame, AX tree, outcome all visible     | CUA state barrier/action lost      |
| `multiple-tool-results`    | two `tool_result`, each with two texts  | every `tool_use_id` result fully visible        | projection truncation across results |

Every marker is uniquified by a per-run nonce; prompts never contain marker values, so the model
cannot guess answers from instructions.

## Verdict

- `PASS`: HTTP 200, model output contains all markers of the case in order.
- `FAIL`: HTTP 200 but any marker missing or out of order.
- `BLOCKED`: model service returns 403, 429, 529 or similar — judged neither pass nor fail.

`scripts/multimodal-tool-result-p0.mjs` validates compatible-API semantics only; the real ZCode
chain additionally needs confirming that the raw `content[]` ZCode sends matches tool output.
Captured results are chain evidence only; never write API keys or image base64 into fixtures.
