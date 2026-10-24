# MCP Image Payload Test Server

## Purpose

`scripts/mcp-image-payload-test-server.mjs` is a local-debug stdio MCP server for verifying the inline/artifact split of MCP image results. It generates a valid PNG and pads bytes through a PNG `tEXt` ancillary chunk so the image content's base64 payload approaches a chosen size.

## Tool

Configure the MCP server name as `zcode_image_payload_test`; the tool is `emit_image`.

Inputs:

- `preset`: `tiny`, `below_limit`, `just_over_limit`, `large`, `huge`
- `base64Bytes`: manually set the target base64 payload size, overriding `preset`
- `label`: optional text label
- `dataUrl`: optional; when `true`, return a data URL in the image `data` field

The default preset is `below_limit` (≈180 KiB base64); `just_over_limit` (≈210 KiB base64) verifies that payloads over `200 KiB` are saved as a binary artifact returning only the path/URI.

## Local ZCode config

ZCode Agent MCP user config lives in `mcp.servers` of `~/.zcode/cli/config.json`. For local testing:

```json
{
  "mcp": {
    "servers": {
      "zcode_image_payload_test": {
        "type": "stdio",
        "command": "node",
        "args": ["/Users/dev/workspace/z-code/scripts/mcp-image-payload-test-server.mjs"]
      }
    }
  }
}
```

After changing the config, create or restart a ZCode Agent session so the MCP list reloads.
