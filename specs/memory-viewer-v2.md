# Memory viewer v2 (ZCO-16, extend-only)

Settings → Memory gains frontmatter metadata, date grouping, an inline accordion preview, and folder access — purely additive extensions of the shipped flat viewer. Nothing that works today may change behavior or break: layout, search, open-in-editor, refresh, service signatures, and the CLI v4 memory engine (`default-index` branch) are the untouched baseline. The `semantic-recall` branch stays OFF; enabling it is a separate product decision.

Authoritative engine spec: `apps/zcode-cli/docs/design/v2/memory/README.md` (§3.3 viewer, §4 file protocol, §11 non-goals). This document extends it for the viewer; §3.3 is amended additively, not rewritten.

## Current state (verified 2026-10-13)

- Viewer: flat per-workspace file list (`packages/ui/src/settings/MemorySettingsViewer.tsx`): file icon, name, relative `updatedAt` via `formatMemoryUpdatedAt` (`memoryUpdatedAt.ts`: `<30 min` → "N min ago", then "Today HH:MM" / "Yesterday HH:MM" / weekday / date, always with time), filename search, `WorkspaceEditorButtonGroup` per row (selected-IDE pill + chevron dropdown of installed editors, last selection persisted).
- Service (`packages/services/src/memory/memoryService.ts`): `listProjectMemories` returns name/path/kind/size/updatedAt (readdir + lstat, no file content); `readProjectMemoryFile` is implemented and tested (stable read handle, containment re-checks, 5 MiB cap, `PROJECT_MEMORY_FILE_CHANGED` / `PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED` codes).
- Dead i18n keys from the pre-open-source viewer are reusable, not deletable: `settings.memory.viewer.tree|indexMissing|collapse|expand|fileLoading|fileDeleted|fileTooLarge|fileChanged|noSelection|…`.
- Engine: `MEMORY.md` is injected per session and truncated at `MEMORY_INDEX_LINE_LIMIT = 200` lines / `MEMORY_INDEX_CHARACTER_LIMIT = 25_000` chars with an exact warning (`apps/zcode-cli/packages/core/src/memory/index-content.ts`); the Dream prompt targets the same budget. Fact files carry YAML frontmatter with `name`, `description`, `metadata.type` (`user|feedback|project|reference`), `metadata.originSessionId`.

## Design decisions (agreed in mockup review 2026-10-13)

1. **No token estimates anywhere.** Tokenization is model-dependent; UI-side per-file estimates would be invented numbers. Show deterministic size (KB) and the existing date format only. If an index-cost hint is ever wanted, it must be computed where exact injection accounting lives (CLI), not estimated in the renderer.
2. **Rows**: icon, name, type badge (from frontmatter; soft tinted pill, text label + color), one-line muted description, size, `formatMemoryUpdatedAt` date. Editor pill stays exactly as today (`WorkspaceEditorButtonGroup` pattern; clicking it must not toggle the row).
3. **Accordion preview**: reuse the existing accordion element (`packages/ui/src/components/ui/accordion.tsx`). Any row, including the index, expands to an inline preview rendered by the existing Markdown renderer; content loads lazily via `readProjectMemoryFile`. The preview body contains only the rendered file content — no session-id metadata, no duplicated type badge. No "5 MiB limit" captions in the UI; the service cap and error codes are the enforcement layer, with localized error states reusing `fileTooLarge` / `fileChanged` / `fileDeleted` / `noSelection` keys.
4. **Index budget chip**: `MEMORY.md` shows the number of lines in the exact content the CLI injects, against the `200`-line limit. Count after the CLI's frontmatter removal, top-level HTML-comment removal (including comments indented by up to three spaces), and trim; empty injected content is `0` lines. Remove only comments with a closing `-->`; malformed unterminated comment tokens remain in the injected content and count. This is a real system limit — the injection-time truncation bound — deterministic, not a UI invention. When the file exceeds the bound the agent silently sees a truncated index, so proximity to 200 is decision-relevant.
5. **Index separated from date groups.** `MEMORY.md` is pinned in its own top section; fact files are grouped below by local day ("Today" / "Yesterday" / date), group headers sticky within the settings scroll container. The index is a different kind of object (loaded every session, carries the budget); its mtime changes on every fact write, so placing it inside date groups would pin it under "Today" forever. Missing index → no index section, fact files render directly (matches §3.3 "no virtual parent"). The budget chip lives inside the `MEMORY.md` row next to the name, not in the section heading.
6. **Folder access** (supersedes the earlier WorkspaceFileTree route and the v4 §11 open-directory non-goal): the viewer header has an "Open folder" dropdown listing every workspace of the local catalog. Selecting one resolves the memory directory host-side via `IMemoryService.getProjectMemoryDirectory` (same containment and case-exact validation as reads) and opens it in the system file manager through `IPlatformService.openInFileManager`. The renderer never constructs data-root paths; failures log a warning without retry.
7. **Search** keeps filtering by name and additionally matches the (now visible) description text, client-side. No new filter controls beyond that.
8. **Staleness badges are deferred** (architectural reason, not UX): the active `default-index` branch performs no recall, so "unused for N months" is unobservable today. Revisit together with recall/usage statistics (slice 4) or a `semantic-recall` enablement decision.
9. **Web remote / mobile**: unchanged — viewer remains desktop-local behind `projectMemoryViewerAvailable`; no catalog calls from remote surfaces.

## Slices

1. **Catalog meta + index section (S–M)**: `listProjectMemories` additionally returns optional `description` and `type` per file plus index `lineCount`; additive optional fields only, old clients must ignore them. Bounded scan: read at most the first ~30 lines / 2 KiB per file; broken or missing YAML → file renders without meta (never fails the catalog). Parser lives locally in `packages/services` (CLI core is not importable from services; ~30 lines, tolerated duplication). Viewer: index section + date groups + badges + index chip. Search matches descriptions.
2. **Accordion preview (M)**: wire `readProjectMemoryFile` into the accordion content; loading, deleted, changed, and over-limit states reuse the existing service codes and i18n keys; preview renders through the existing Markdown renderer; multiple items can be open at once; the expanded preview is the rendered body only — no session-id meta.
3. **Folder access (S, shipped 2026-10-14)**: "Open folder" header dropdown per decision 6 — host-side directory resolution + `openInFileManager`; no Workspace Shell dependency.
4. **Deferred (separate spec work)**: staleness/archive policy, recall/usage statistics, review mode, index auto-trim — each currently a §11 non-goal and requires a §4/§11 amendment first.

## Boundaries

- Renderer never builds data-root paths; catalog and file reads stay behind the local Host Memory service.
- Catalog file metadata and parsed contents come from a no-follow stable handle after revalidating the projects root, workspace, memory directory, exact filename, and path containment. If the opened file no longer matches the current path or changes while read, omit that file from the catalog snapshot.
- Catalog read order: enumerate path → open without following a file symlink → revalidate directory chain and containment → read frontmatter/index from the handle → verify the handle is unchanged → publish summary.

  ```mermaid
  sequenceDiagram
    participant S as Memory service
    participant F as Filesystem
    S->>F: lstat candidate, then open O_NOFOLLOW
    S->>F: fstat handle and revalidate path containment
    S->>F: lstat path and compare file snapshots
    alt snapshots match
      S->>F: read content through the handle
      S->>F: fstat handle again
      F-->>S: publish summary only if unchanged
    else path or file changed
      F-->>S: omit catalog entry
    end
  ```

- `ProjectMemoryFileSummary` changes are additive optional fields; consumers must tolerate absence. The v4 §3.3 catalog contract ("catalog returns name, kind, size, mtime") is amended to "…plus optional frontmatter meta and index line count" in the same change that ships slice 1.
- i18n: en-US + uk-UA parity for every new key; reuse dead keys before adding new ones.
- Telemetry: extend the existing `settings.memory` `runUserAction` feature ids (`open_folder`, `expand_preview`); no new telemetry systems.
- Retry: closing and reopening a preview in an error state retries the file read. Ready previews remain cached until the catalog or selected workspace changes.
- Tests: services unit tests for frontmatter scan (tolerant parser, bounded read, lineCount); viewer component tests for grouping/chip/preview states; E2E for the expand-preview interaction (CI is the e2e gate locally).
