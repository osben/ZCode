# Windows Path Markdown Link Escape Recovery Design

Date: 2026-08-18
Status: design -> implementation
Impact: `packages/ui/src/lib/windowsFileLinkEscapeRemarkPlugin.ts` (new),
`packages/ui/src/components/ai-elements/message.tsx` (mounts the remark plugin). The file-open path, the rehype
rewrite and the citation plugin are unchanged.

## Background

The same "screenshot failed" field log showed, besides the Helper DPI gateway interception (fixed on the
producer side), a second user-visible fault: the model's PowerShell fallback screenshot was saved

```text
C:\Users\dev\.zcode\workspace\default\screenshot.png   518252 bytes
```

but the preview in the conversation would not open; `file.stat` / `file.readMediaPreview` returned ENOENT for

```text
C:/Users/dev.zcode/workspace/default/screenshot.png
```

`\.zcode` became `.zcode`: one backslash was lost.

## Root cause

CommonMark says backslash escapes in a link destination apply **only to ASCII punctuation**: in `\X`, if X is
punctuation the result is X itself, otherwise the backslash is kept. Windows paths span both classes:

```text
source [screenshot.png](C:\Users\dev\.zcode\workspace\default\screenshot.png)
                          ↑U    ↑z   ↑.      ↑w        ↑d       ↑s
                          kept  kept eaten    kept      kept     kept
mdast  url = C:\Users\dev.zcode\workspace\default\screenshot.png
```

A `remark-parse` experiment confirmed that only `\.` collapses; all other backslashes survive.

The loss happens in the **mdast parse phase**. The existing `rewriteLocalFileMarkdownTargetsRehypePlugin` runs
in the rehype phase and sees an `href` already corrupted; turning `\` into `/` only rewrites the wrong path.

This is a **phase mismatch in the design**, not an implementation bug in that rehype plugin: no rehype plugin
can see the original destination text. The fix must move to the remark phase, where `node.position` still
points into the VFile source.

## Goals

1. For Windows absolute paths (drive letter and UNC) in model-produced links/images, restore `node.url` to the
   source spelling.
2. Restoration must be **verifiable**: replace only if unescaping the source per CommonMark rules yields
   exactly `node.url`; otherwise leave it. Better not to fix than to fix wrongly.
3. Do not affect non-Windows paths, `http(s)`, relative paths or citations.

## Non-goals

- Do not change model output (making the model escape backslashes is uncontrollable, and history is already
  persisted).
- Do not change the rehype chain; it keeps working for already-correct URLs.
- Do not handle the `<...>` angle-bracket form or links with a title: neither occurs in this scenario, and both
  are "not restored", failing closed.

## Design

### Phases

```text
markdown source
    │
    ├─ remark-parse ──────────► mdast (destination already unescaped, position info still present)
    │
    ├─ * windowsFileLinkEscapeRemarkPlugin  <- new, restores node.url here
    │
    ├─ other remark plugins (GFM / citation)
    │
    ├─ mdast → hast
    │
    ├─ rewriteLocalFileMarkdownTargetsRehypePlugin (existing, normalizes to /C:/… for the safety layer)
    │
    └─ rehype-harden → render
```

### Restoration algorithm

For each `link` / `image` / `definition` node:

1. Gate: `node.url` must look like `X:\…` / `X:/…` (drive letter) or start with a single `\` (UNC). Everything
   else is skipped, so ordinary URLs never enter this plugin's rewrite surface.

   UNC requires only **one** leading backslash: in the source `\\host`, `\\` is itself one punctuation escape
   and parses to a single backslash (verified: `[log](\\build01\share\.logs\run.txt)` →
   `\build01\share.logs\run.txt`). Requiring two would miss every UNC that needs restoring.

2. Skip if `node.title` is non-empty (title syntax is not parsed).
3. Slice the whole segment from the VFile source using the `node.position` start/end offsets and take the
   destination by node shape:
   - `link` / `image`: `[label](dest)` / `![alt](dest)`; require a trailing `)` and take the part after the
     last `](` up to the closing `)`. A Windows path contains no `](`, so "the last one" is safe inside the gate
     and brackets inside label/alt cannot skew the slice.
   - `definition`: `[ref]: dest`; take the part after `]:`. A reference link's URL comes from the definition,
     and the same loss occurs on that path.
4. Skip the angle-bracket form (`<…>`).
5. **Verify**: only when `unescapeCommonMarkPunctuation(raw) === node.url` is the slice taken as correct and
   the restoration unambiguous; then set `node.url = raw`, otherwise leave it unchanged.

The unescape rule matches CommonMark:

```text
\ followed by ASCII punctuation (! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~)
  → drop the backslash
otherwise → keep as is
```

Step 5 is the safety valve of the design: a wrong slice, source containing entity references (`&amp;`), or any
unforeseen syntax makes the equality fail, so restoration is abandoned instead of writing a wrong path.

### Mounting

In `message.tsx`, `messageRemarkPlugins` was provided explicitly only when
`renderZCodeFileCitations && workspacePath`, otherwise `undefined` (Streamdown default). This plugin must take
effect **unconditionally**, so it now always provides `defaultRemarkPlugins +
windowsFileLinkEscapeRemarkPlugin`, with the citation plugin still appended under the original condition.
Passing the default plugins explicitly is an existing convention (see the existing comment there: omitting them
degrades tables).

## Impact and risk

- **Multi-platform**: the gate recognizes only drive-letter/UNC shapes; macOS/Linux models do not produce such
  URLs, so the plugin costs one regex check for them.
- **Performance**: the source is sliced only when the gate matches, which is very rare in normal sessions.
- **False positives**: guarded by the step 5 equality; if it fails, give up.
- **History**: restoration happens at render time, so re-rendering history takes effect with no data
  migration.

## Acceptance

1. New unit tests cover: `\.zcode` restoration, image nodes, UNC leading-backslash collapse, reference-style
   definition, no-op when nothing needs restoring, non-Windows URLs untouched, titled links skipped, angle
   brackets skipped, and unchanged value when verification fails (entity reference).
2. `pnpm exec vitest run packages/ui/test/windowsFileLinkEscapeRemarkPlugin.test.ts` passes, and the 11
   existing test files that message.tsx depends on are all green.
3. End-to-end: the preview of `[x](C:\Users\dev\.zcode\...\screenshot.png)` opens in a conversation.
