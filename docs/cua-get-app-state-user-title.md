# CUA `get_app_state` user title

## Feature Summary

| Field            | Value                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | The model supplies a concrete, user-readable action title for "read app UI", instead of one generic string for every observation        |
| Capability       | Computer Use observation tool projection                                                                                                |
| Change layer     | validation + presentation                                                                                                               |
| Operating mode   | planning                                                                                                                                |
| Primary seeds    | `apps/zcode-cli/packages/core/src/mcp/index.ts`, `packages/ui/src/ToolCallBlocks/renderers/cua.tsx`                                     |
| Out of scope     | Changing Computer Use Helper permission boundaries, changing `get_app_state` observation results, requiring titles from other CUA tools |

## Product Contract

- The model-visible input schema of the official CUA `get_app_state` must include a required `title`: 1–120 characters, in the user's current language, describing the purpose of this read — not restating implementation names such as `get_app_state`, CUA, or MCP.
- `title` is ZCode display metadata, not an upstream `zcode-cua` runtime parameter. The Core MCP bridge must remove it before calling `McpPort.callTool`, so the upstream strict schema stays intact.
- The conversation tool card prefers `input.title`. Old sessions or historical provider calls without a title keep the fallbacks 「读取 {app} 应用界面」 or 「读取应用界面」.
- The convention applies only to CUA `get_app_state`. Same-named plain MCP tools, other CUA tools, and the existing `node_repl` title contract are unchanged.

## UI Surface Matrix

| User scenario      | UI entry                  | Shared implementation                          | Display/draft owner                        | Validation/gating                                                                    | Commit action                                      | Authority/persistence                                                                | Mode boundary                                                                                        | Must remain isolated from                               |
| ------------------ | ------------------------- | ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Model reads app UI | Conversation CUA tool row | MCP descriptor projection + `CuaToolCallBlock` | Agent tool input / Conversation projection | Core injects the required title; CUA server identity + `get_app_state` double gating | `McpPort.callTool`, title stripped before the call | CUA runtime owns only real observation params; title projects with tool call history | Desktop continuous and mobile replayable show the same persisted input; delivery semantics unchanged | Upstream CUA param schema, other MCP, other CUA actions |

## State And Call Boundary

```text
CUA tools/list descriptor
        |
        | Core 只为官方 get_app_state 叠加 required title
        v
Model tool contract -----> model emits { title, app_ref, ... }
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
          Conversation projection      MCP bridge runtime call
                    |                           |
                    | 展示 input.title          | 移除 title
                    v                           v
             CUA tool summary          zcode-cua get_app_state
                                                |
                                                v
                                      Helper observation result
```

## Shared And Divergent Behavior

| Concern      | Shared                                          | Deliberately different                                                                                    | Why it matters                                                       |
| ------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Model title  | Model supplies a short title, like `node_repl`  | CUA title is layered by Core onto the external MCP descriptor; `node_repl` defines it in its own contract | The external CUA server must not be forced to know ZCode UI metadata |
| UI fallback  | New and old sessions share one CUA renderer     | New calls prefer the model title; old calls keep the localized fixed copy                                 | Historical tasks must keep rendering                                 |
| Runtime args | Existing `app_ref`, `detail`, etc. pass through | Only `title` is removed before dispatch                                                                   | Observation semantics and upstream compatibility must not change     |

## Feature Relationships

| Rank           | From                    | Semantic edge                   | To                             | Why inspect it                                                | Evidence                |
| -------------- | ----------------------- | ------------------------------- | ------------------------------ | ------------------------------------------------------------- | ----------------------- |
| must-inspect   | CUA tools/list          | projects model contract through | Core MCP bridge                | Required fields must truly reach the provider schema          | `registerMcpTools`      |
| must-inspect   | Core MCP bridge         | strips display metadata before  | CUA runtime                    | The upstream contract has no title                            | `McpPort.callTool`      |
| must-inspect   | Conversation projection | renders title in                | CUA tool card                  | The user needs to see the model's stated purpose              | `CuaToolCallBlock`      |
| invariant-only | CUA title projection    | must not change                 | Helper/broker authorization    | title has nothing to do with permission, tokens, or TCC owner | CUA broker spec         |
| invariant-only | CUA title projection    | must not change                 | continuous/replayable delivery | title is just part of the existing tool input                 | conversation projection |

## Must-Preserve Invariants

| Invariant                                                                 | Surfaces/modes                           | Proof needed                                  |
| ------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| Only the official CUA `get_app_state` requires a title                    | local/current/legacy server names        | bridge unit tests covering CUA vs plain MCP   |
| `title` is never sent to upstream CUA                                     | Agent runtime                            | `McpPort.callTool` argument assertions        |
| Old sessions without title stay readable                                  | Desktop/Web/Mobile history               | renderer fallback unit test                   |
| Model title beats the fixed app string in the tool card                   | Desktop/Web/Mobile conversation          | renderer summary unit test                    |
| Computer Use Helper permissions and remote attachment semantics unchanged | macOS desktop-local / mobile shared host | No broker, protocol, or delivery file changes |

## Codegraph Evidence

No callable codegraph command or index exists in this worktree; depth-2 paths were verified with feature-graph code seeds and exact symbol search, not a full static call graph.

| Seed                        | Query            | Direct callers / key path                                                          | Depth | Interpretation                                                            |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| `registerMcpTools`          | symbol/file scan | MCP tools/list → `createMcpToolEntry` → ToolRegistry contract / `McpPort.callTool` | 2     | One bridge owns both the provider schema and runtime dispatch boundaries  |
| `CuaToolCallBlock`          | symbol/file scan | `ToolCallBlock` CUA route → summary projection                                     | 2     | Summary currently uses fixed i18n copy; adding title priority is safe     |
| `buildNodeReplDisplayModel` | symbol/file scan | node_repl input title → renderer summary                                           | 2     | The existing precedent is model title first, implementation-name fallback |

## Graph Delta

| Status    | Node/edge                                        | Semantic reason                                                      | Action                   |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------- | ------------------------ |
| confirmed | `capability.computer-use` aliases/docs           | `get_app_state` user title becomes a searchable product semantic     | Update the feature graph |
| confirmed | `service.cua-tool-contract-projection`           | Core bridge owns model-schema layering and runtime-strip boundaries  | New node and edges       |
| confirmed | `surface.computer-use-task-experience` code seed | The dedicated CUA renderer is the current user-visible landing point | Add code seed            |

## Boundary Decisions And Pruning

| Boundary               | Decision                                                            | Includes                                                                   | Excludes / prunes                                         | Source                             |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| Tool scope             | Only `get_app_state` changes                                        | Current official, `computer-use`, and legacy `zcode-cua` server identities | screenshot, click, type, etc.                             | User request                       |
| Title authority        | `input.title` from the model is the display authority for new calls | 1–120 chars, user language                                                 | UI rewriting the model title from the app name            | User request + node_repl precedent |
| Upstream compatibility | title is stripped before Core dispatch                              | provider contract, history projection                                      | Modifying or upgrading the external CUA package schema    | Current dependency boundary        |
| History compatibility  | missing title uses the existing i18n fallback                       | old sessions, old providers                                                | Migrating historical inputs                               | Compatibility invariant            |
| Multi-surface matrix   | Pruned via projection invariants                                    | Representative renderer unit-test semantics for Desktop and mobile         | Expanding the theme/locale × clientMode cartesian product | No layout or delivery changes      |

## Accepted Cases

| Case ID      | Setup                        | Action                   | Assertions                                                          | Evidence layers | E2E status |
| ------------ | ---------------------------- | ------------------------ | ------------------------------------------------------------------- | --------------- | ---------- |
| CUA-TITLE-01 | official CUA descriptor      | register `get_app_state` | `title` required in the model schema, original required fields kept | contract unit   | automated  |
| CUA-TITLE-02 | model call includes title    | run the tool handler     | `McpPort.callTool` receives the other params but not title          | runtime unit    | automated  |
| CUA-TITLE-03 | new CUA tool row             | render summary           | model title shown, fixed app summary not                            | UI unit         | automated  |
| CUA-TITLE-04 | historical row without title | render summary           | falls back to the existing localized app summary                    | UI unit         | automated  |

## Planning Handoff

| Item             | Destination                                                    | Status     |
| ---------------- | -------------------------------------------------------------- | ---------- |
| Spec update      | this document                                                  | complete   |
| Case catalog     | Accepted Cases above                                           | complete   |
| Coverage matrix  | Accepted Cases above                                           | complete   |
| Decision backlog | none                                                           | complete   |
| E2E handoff      | no new E2E; contract/runtime/UI unit tests cover this boundary | not-needed |
