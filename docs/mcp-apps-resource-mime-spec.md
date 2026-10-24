# MCP Apps common resource MIME allowlist

## Goals and boundaries

When plugin pages read common files like PDFs through `resources/read`, the previous allowlist rejected legitimate content before returning the page. This change extends the shared allowlist's explicit entries while keeping the existing matching rules and resource boundaries; no new broad prefixes like `application/` or `image/`.

The single rule source is `packages/shared/src/mcp-apps/resourceMime.ts`, still exported by `contract.ts` as `MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST` and the other existing interfaces. The list lives separately to keep the main contract's line budget. The agent's mcp-ui performs the check; the service bridge and plugin pages build no second allowlist.

```text
plugin page → instance credential and server ownership check → MCP resources/read
            → MIME allowlist and 8 MiB total check → strip _meta → return the page
```

## Accepted entries

| Category       | Accepted common formats                              |
| -------------- | ---------------------------------------------------- |
| existing       | `text/*`, JSON, PNG, JPEG, WebP, GLB, generic binary |
| documents      | PDF, RTF, DOC/XLS/PPT, DOCX/XLSX/PPTX, ODT/ODS/ODP   |
| structured     | XML, YAML (including `application/x-yaml`)           |
| images         | SVG, GIF, AVIF, BMP, TIFF, ICO, HEIC, HEIF           |
| audio          | MP3, MP4 audio, Ogg, WAV, WebM audio, AAC, FLAC      |
| video          | MP4, WebM, Ogg, QuickTime, MPEG                      |
| archives       | ZIP, GZIP, TAR, 7z, RAR                              |
| fonts & models | WOFF, WOFF2, TTF, OTF, JSON glTF                     |

MIME matching ignores case, surrounding whitespace, and the parameter after the semicolon; otherwise it is exact. The existing `text/` prefix behavior is kept. Common MIME aliases for WAV, GZIP, and ICO are listed explicitly; arbitrary extensions and vendor types are not inferred.

## Unchanged

- Unlisted MIME, empty MIME, and blobs without MIME are still rejected; explicitly declared executable types such as `application/x-msdownload` gain no allowance.
- Each result accumulates UTF-8 text and base64-decoded bytes over all content items, capped at 8 MiB; exceeding it rejects the whole result without truncation.
- Existing checks for instance credentials, server ownership, stale instances, sandbox, CSP, and download-save confirmation are kept.
- Resources are transported only; no decoder for the format is guaranteed on host or plugin. Resource `_meta` is never passed to the page.
- No UI, reload-button, handshake, or lifecycle changes. Desktop-continuous and mobile-replayable semantics are unchanged; Web/remote keep the existing capability boundaries when unavailable.

## Regression verification

- Shared contract: common-category acceptance; case and parameter compatibility; unknown types, forged extensions, and executable types rejected.
- Agent handler: PDF blobs and SVG text returned verbatim with `_meta` stripped; total size, missing MIME, and server ownership still enforced.
- Electron integration: a real plugin iframe reads PDF/SVG through App SDK, host, agent, and MCP process, checking MIME and bytes; after an unknown-type failure the page can still read legal resources.
- Use the existing `mcp-apps-host-e2e.mjs --managed-only` for the managed Electron chain; do not present that result as a full regression across all desktop platforms or mobile Web.
