# Port: LocalToolSearch (upstream 3.16.3)

Status: draft for the fork port of upstream ZCode 3.16.3 (source not yet published; the reference is the shipped minified agent bundle `zcode.cjs`, read-only). Fork baseline: upstream 3.16.2 (`3c5b2276`) plus fork features.

## Scope

In local tool-search mode the model-facing search tool is named `LocalToolSearch` instead of `ToolSearch`. The registry entry, its handler, its permission record, and the deferred catalog keep the canonical name `ToolSearch`. Only the model-facing name and the text that refers to it change. Native mode is unchanged. Out of scope: the query-schema wording drift described under "Not ported".

Evidence for these rules: minified-bundle anchors (`PM="LocalToolSearch"` alias on the `ToolSearch` handler, `buildToolExposure`, `projectToolReferences`, `renderToolSearchAnnouncement`, `normalizeToolNameAlias`, the renderer's search block matching both names); only `zcode.cjs` and the renderer assets contain `LocalToolSearch`.

## Rules

R1. `LOCAL_TOOL_SEARCH_NAME = "LocalToolSearch"` lives in `@zcode/contracts` (`packages/contracts/src/tools/tool-search.ts`). `toolSearchNameForMode(mode)` returns the local name for `local`, and `ToolSearch` otherwise. `isToolSearchName(name)` is true for either name.

R2. The registry entry for `ToolSearch` declares `aliases: [LOCAL_TOOL_SEARCH_NAME]`, so a call named `LocalToolSearch` resolves to the search handler.

R3. In local mode `buildToolExposure` emits the search contract as `LocalToolSearch` with `LOCAL_TOOL_SEARCH_DESCRIPTION`. Catalog building, deferred classification, `enabled`, and `DeferredToolCall` filtering use the canonical name.

R4. Announcements are rendered from `metadata.toolSearchAnnouncement` at projection time, not replayed from stored text. The local added-tools notice names `LocalToolSearch`. The readded and removed paragraphs use `toolSearchNameForMode(mode)`. Native output is unchanged.

R5. The projection rewrites, for non-`off` modes only:

- a message `toolName` and each `toolCalls[].name` that is a search name and differs from `toolSearchNameForMode(mode)`;
- an announcement attachment whose re-rendered text differs from the stored text.

Stored history is never modified. The rewrite applies to the request copy only.

R6. A successful search row is detected with `isToolSearchName`, under either name.

R7. Local loaded-reminder text says `LocalToolSearch`. The undiscovered-schema hint uses `toolSearchNameForMode(search.mode)`. The DeferredToolCall description says `LocalToolSearch`.

R8. `normalizeToolNameAlias` maps `LocalToolSearch` to `ToolSearch`. Consequences: a rule such as `disallowedTools: ["LocalToolSearch"]` removes the search tool, `allowedTools` normalization accepts either name, and `Bash(...)`-style rule parsing is unchanged.

R9. Explore allowlists keep `ToolSearch`. The UI renders `LocalToolSearch` with the search block.

R10. Handler error and cancel strings stay `ToolSearch`, as in the bundle.

R11. In native projection, a `tool_reference` that names an alias is rewritten to the catalog entry's canonical name. Local projection expands references as before.

R12. The fork's trajectory tooling (`tools/prompt-trajectory`) recognizes both names in the announcement heading and in tool_use blocks, so offline comparison keeps working in local mode.

## Compatibility (shared `~/.zcode/cli/db/db.sqlite`)

Stored rows keep the name they were written with. Rows are never migrated.

- Old fork (3.16.2 base) rows, written as `ToolSearch`, replayed by the ported build: in local mode rewritten to `LocalToolSearch`; in native mode unchanged; announcements re-rendered for the current mode.
- 3.16.3 rows, written as `LocalToolSearch`, replayed by the ported build: in local mode unchanged; in native mode rewritten to `ToolSearch`; recognized as successful searches under either name.
- Ported build writing rows (pinned by `tests/tool-search-local-runtime.test.ts`, local mode, model emits `LocalToolSearch`): the pending and running tool parts keep `LocalToolSearch`, and the completed part is written as the canonical `ToolSearch`. Both forms are read by the projection.
- Stock 3.16.3 reading rows written by the ported build: stock `isToolSearchName` accepts both names — compatible. Stock 3.16.3 reading rows written by 3.16.2: compatible, the same rewrite applies.
- Stock or fork 3.16.2 reading rows written as `LocalToolSearch`: **not verified.** 3.16.2 checks only `=== "ToolSearch"` for successful searches, so loaded-reminders and "already loaded" state may be off on that replay; the `tool_reference` blocks still drive discovery; and the old build does not rewrite the tool-call name, so the provider sees a call whose name is not in its tool list. Known risk for mixed-version use of one database.

## Acceptance scenarios

1. Local mode, fresh session: the request tool list contains `LocalToolSearch` and not `ToolSearch`; `DeferredToolCall` is present; the deferred catalog is unchanged.
2. Model calls `LocalToolSearch({query:"select:X"})`: the executor runs the search handler; the result contains the tool_reference for `X`; X is loaded through the Local definition path.
3. Replay of an old `ToolSearch` row in local mode: the projected entry and any assistant tool-call name read `LocalToolSearch`; loaded-reminders are emitted as before.
4. Replay of a `LocalToolSearch` row in native mode: the projected name reads `ToolSearch`.
5. Off mode: nothing is renamed; announcement entries are dropped as before.
6. Announcement written in local mode, replayed in native mode: text re-rendered with `ToolSearch`.
7. `disallowedTools: ["LocalToolSearch"]`: the search tool is not registered for the child.
8. Schema error on a deferred tool in local mode: the hint says `call LocalToolSearch ...` followed by the DeferredToolCall line.
9. UI: a tool row named `LocalToolSearch` renders the search block.

## Reconciling with the real 3.16.3 source

- The identifier `LOCAL_TOOL_SEARCH_NAME` is a guess (the bundle minifies the constant to `PM`). Rename to the upstream name when the source ships.
- `toolSearchNameForMode` and `isToolSearchName` are the names registered by the bundle, so they are likely exact.
- The bundle's `LocalToolSearch` description includes a "Regular expressions are not supported" paragraph shared with native; the fork omits it. See "Not ported".
- Upstream may place the constants and helpers in a different module. Only the names matter for the merge.

## Not ported

- Query-schema wording (bundle query description gains "Regular expressions are not supported.", the query-forms section is rewritten, and the example changes to `select:TodoWrite,mcp__byob__browser_navigate`). Affects native and local descriptions alike; not part of the local name change. The fork keeps the 3.16.2 wording. Decision for the user.
- The bundle's `web_search` alias: already present in the fork (`normalizeToolNameAlias`).
- Bundle cancel and error strings for ToolSearch: unchanged upstream, nothing to port.
- `tools/prompt-trajectory` runner: its own tests do not load under this checkout (module path `.js` to `.ts` mapping); pre-existing, not changed here.
