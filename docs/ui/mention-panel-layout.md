# Composer Trigger Routing and Mention Panel Layout

> Status: implemented and passed focused tests and Desktop E2E (2026-07-31); the workspace/session lifecycle
> of the Composer Skill catalog was added on 2026-08-20, see
> [conversation-skill-catalog-lifecycle.md](./conversation-skill-catalog-lifecycle.md). This change only
> adjusts the input's main entries, group order and default hints; it removes no old candidate capability,
> trigger, canonical Markdown, history parsing or recovery compatibility.

## Product Decision

The Composer has `@`, `/` and `$` as three main discovery entries:

| Main entry | Main group order | Semantics |
| --- | --- | --- |
| `@` | 1. Plugins; 2. Files; 3. Conversations | Reference the context the current task needs. The file group contains both files and folders; conversations stay on the current workspace's sessions-index. |
| `/` | 1. Commands; 2. Skills; 3. Subagent | Choose the command or capability to run. |
| `$` | Skills | Choose a skill directly. |

Old capabilities are kept:

- The existing Whiteboards group in `@` keeps showing, after the three main groups; the provider, chip and
  history rendering capabilities are not deleted.
- `#` can still open the original conversation candidate panel directly.
- `$`, `¥`, `￥` can still open the original Skills candidate panel directly, with `¥`, `￥` normalized to `$`.
- File, whiteboard, session, skill and subagent mentions produced by old drafts, history messages and external
  entries keep parsing and displaying in their original format.
- Other capabilities not placed in the main groups remain usable via ordinary natural-language prompts; no
  runtime capability is deleted.

The input's `+` action menu explicitly highlights `@`, `/` and `$` and no longer shows a separate `#`
conversation shortcut, since conversations entered the `@` main entry; but when the user types `#` by hand,
the original candidate panel still opens. The empty-query search hint of the `@` panel lists only plugins,
files and conversations, with no mention of whiteboards.

```text
Composer
├─ @  reference context
│  ├─ 1. Plugins
│  ├─ 2. Files / folders
│  ├─ 3. Conversations
│  └─ 4. Whiteboards (old capability kept)
├─ /  choose capability
│  ├─ 1. Commands
│  ├─ 2. Skills
│  └─ 3. Subagent
├─ $  choose skill
├─ #  conversation candidates (compat entry kept)
└─ ¥ / ￥  Skills candidates (compat entry kept)
```

## Entry vs Canonical Carrier

The discovery entry decides only "from which panel to find the candidate" and must not change the stable
carrier after sending:

| Candidate | Discovery entry | Canonical carrier after selection |
| --- | --- | --- |
| Plugin | `@` | `[@Plugin](plugin://stable-id)` |
| File / folder | `@` | existing file/directory Markdown link |
| Conversation | `@` or compat `#` | existing `[#Title](#sess_id)` / `#sess_id` |
| Whiteboard | `@` | existing whiteboard mention |
| Command | `/` | `/command` |
| Skill | `/` or compat `$` / `¥` / `￥` | existing `$skill` or a path-carrying Skill Markdown link |
| Subagent | `/` | existing `@agent-name` |

So adding "conversations" to `@` adds no session-reference protocol, and putting Skill and Subagent under `/`
does not serialize them as slash commands. Send, edit, queue, retry, fork and cold resume keep consuming the
original canonical text.

## UI Surface Matrix

| User scenario | UI entry | Candidate source | Local state | Commit result | Mode boundary | Must isolate |
| --- | --- | --- | --- | --- | --- | --- |
| Reference Plugin / file / conversation / Whiteboard | `@` panel of `MentionPlugin` | plugin reference catalog, file provider, sessions-index, whiteboard provider | Lexical active trigger + selected index | Insert the matching original canonical Markdown | Desktop/Web/Mobile shared; remote uses the target workspace services | No change to Plugin catalog freeze, file path semantics or session catalog authority |
| Choose command / Skill / Subagent | `/` panel of `SlashCommandPlugin` | CLI command catalog, Skills, Subagents | Lexical active trigger + selected index | Insert `/command`, Skill mention, `@agent` respectively | workspace identity isolation unchanged | Do not mistake Skill/Subagent for a command to run |
| Use compat entries | `#`, `$`, `¥`, `￥` | sessions/skills provider; only `#` aggregates the workspace sessions-index of the same authority | original trigger state | original canonical Markdown | `#` does not cross Agent Hosts; other triggers as today | A `#` widening must not change the `@` conversation scope nor break old drafts |
| Discover entries from the input `+` menu | `ChatPromptActionMenu` | static entries | no persisted state | Insert the `@`, `/` or `$` trigger character | each end only adapts layout | Do not expose `#` again, but do not affect manually typed `#` |

## Shared and Different Behavior

- `@` and `/` keep reusing the virtual list, keyboard navigation, disabled state and scroll mask of
  `MentionPanel`. The two main panels share layout, not candidate authority: Plugin, file, conversation,
  command, Skill and Subagent stay with their own providers/hooks.
- File candidates are indexed uniformly by `listWorkspaceFiles` of the Host owning the workspace and follow
  the [workspace file search default filter](../superpowers/specs/2026-08-07-workspace-file-search-default-filter-design.md);
  the UI keeps no second blocklist. An ordinary hidden directory hides only directory candidates and scanning
  continues into descendants; future custom rules attach by replacing the service filter, with no config
  source in this phase. The left Workspace File Tree search state reuses the same file index and match ranking
  but inherits none of the `@` panel's grouping, empty-query preview limit, keyboard candidate commit or
  canonical Markdown mention insertion; tree search results keep opening previews or locating directories per
  file tree semantics.
- Cross-group search in `@` shows in fixed group order with no global relevance re-ranking; inside a group the
  existing filtering and ordering is kept.
- `/` keeps the fixed order Commands -> Skills -> Subagent; the keyboard default selection may still use the
  cross-group best match without changing the visual group order.
- Skill candidates of `/` and `$`/`¥`/`￥` share one catalog authority: a new draft reads the workspace's
  current catalog before prewarm is ready, and after ready reads the frozen catalog of the runtime for
  `prewarmSessionId`; an existing Session reads the frozen catalog of the runtime for the formal `sessionId`;
  after cold resume/runtime restart it re-queries with the new runtime. The live management catalog in
  Settings stays independent and cannot backfill or hot-update an existing Session. Full timing:
  [Composer Skill Catalog lifecycle](./conversation-skill-catalog-lifecycle.md).
- With an empty query each group shows a preview; with a query only the default helper text hides, never the
  empty, loading or error states.
- The conversation provider selects scope by trigger: `@` stays on the current workspace; only `#` aggregates
  all workspaces under the same Agent service/session store authority; in `#` current-workspace candidates
  come first and the rest sort by latest update time, with the workspace name still shown in the candidate
  description. With an empty `#` query each workspace shows at most the 20 most recent; when searching, all
  history of that workspace is matched first and then at most 20 matches kept. This limit does not apply to
  `@`.

## Layout and Interaction

- The candidate list preferably shows above the panel; the helper text of an empty query sits below the list.
- The list keeps compact menu density; group titles use `text-ui-base`, `text-foreground-subtle` and `h-8`
  (32px) vertical centering; virtual row height is 34px like command items; it follows the menu surface and
  keyboard focus styles prescribed by `DESIGN.md`.
- When the virtual list scrolls, the scroll container uses top and bottom fade masks, shown only when that
  direction can still scroll.
- Enter and Tab select the current candidate; Up/Down navigate continuously across groups; Esc closes only the
  current panel without rewriting the input.
- A disabled Plugin stays visible and shows the conflict reason; the disabled state cannot be selected by
  Enter or Tab.
- Desktop, ordinary Web and Mobile keep the same group semantics; narrow screens change only size and visible
  count, not groups or the canonical carrier.

## Boundaries and Pruning

- The 2026-07-31 entry grouping is `presentation + option-source` and does not modify the message protocol.
  The 2026-08-20 Skill lifecycle addition adds a read-only `skills/referenceCatalog` query and a Session
  runtime catalog projection, but does not modify the provider request, canonical input, session/task stream,
  continuous/replayable or remote recovery chain.
- `@` and `#` still reuse one provider and the current Agent Host authority, but the trigger scopes are
  explicitly isolated: `@` takes only the current workspace, and only `#` enables cross-workspace aggregation.
- "All workspaces" of `#` is bounded by the workspaces in the current window-scoped Tab Store that are open or
  restored and share the same session store authority as the composer. local-local and the same remote
  authority can aggregate; local-remote and different remote authorities do not share a SQLite session store,
  and are pruned in this round, so a selected conversation is never missing for `ReadSessionContext`.
- Skill under `/` and `$`/`¥`/`￥` shares one provider-filtered catalog, with no two sets of enable/filter
  semantics.
- Whiteboard, theme, language, task phase and model/provider are not Cartesian-multiplied with group order;
  they are covered by shared component invariants and a representative Desktop case.
- A remote workspace verifies multi-workspace aggregation under the same `remoteSessionId`/service authority,
  and that different remote authorities and unconnected remotes do not enter candidates; no remote scope may
  fall back to the local base service.

## Acceptance

- Typing `@`: main groups show fixed Plugins -> Files -> Conversations, with Whiteboards as a kept group after.
- Typing `/`: groups show fixed Commands -> Skills -> Subagent.
- Typing `#`, `$`, `¥`, `￥`: the original candidate panels still open and can select.
- Typing `#` can select conversations of other open or restored workspaces under the same session store
  authority; the current workspace comes first and candidate rows show the source workspace name. Typing `@`
  still shows only the current workspace's conversations.
- The `#` candidate cap buckets by `workspaceIdentity?.trim() || workspacePath`, at most 20 per workspace; a
  global 20 must not let one workspace crowd out others; search still covers history beyond the latest 20.
- The `+` action menu shows add, plugins, files, sessions directly; the bottom explains the shortcut symbols
  in order `@`, `/`, `$`, with no separate `#` shortcut.
- A conversation selected by `@` still writes the `#sess_...` canonical session mention; a Skill/Subagent
  selected by `/` still writes the existing Skill / `@agent` mention.
- The empty-query helper text is below the list and hides after a query is typed; the `@` empty-query helper
  mentions only plugins, files and conversations, with no whiteboards in zh/en.
- Up/Down, Enter, Tab, Esc, scroll mask and Plugin disabled state stay usable.
- Whiteboard, Session, Skill and Subagent mentions in old drafts and history still echo correctly.

## Implementation and Verification

- `MentionPlugin` fixes the `@` order plugins -> files -> sessions -> whiteboards through a pure routing
  table, while keeping the `#` sessions provider and the `$` (incl. Yen normalization) Skills provider.
- `ChatPromptActionMenu` shows add, plugin, file and session candidates; `@`, `/`, `$` only as bottom hints.
- Candidate serialization functions are unchanged: `@` selecting a conversation still writes the `#session`
  canonical, and the compat Skills entry still writes the original Skill Markdown.
- The sessions provider builds the same-authority scope set from the current window's workspace tabs only
  under the `#` trigger; `@` keeps building a single current-workspace scope. Both reuse the sessions-index
  registry; authority, cross-Host pruning and coverage details:
  [cross-workspace session mention](../superpowers/specs/2026-08-04-cross-workspace-session-mention-design.md).
- Focused tests cover main-entry order, compat entry routing, the `+` menu action set, Yen normalization and
  the existing canonical construction.
- The formal Desktop E2E `conversation-session-v4-mention.test.ts` covers `@` / `#` sharing sessions-index,
  `$` / `¥` / `￥` skill selection, the `+` menu showing `@` / `/` / `$` bottom hints, manually typing `$` after
  closing to open skill candidates, and in S08 verifies an old Session's frozen Skill catalog and a new task
  re-discovering the real `SKILL.md`.
- The full plugin/file/session/whiteboard and command/skill/subagent keyboard interaction combinations remain
  in the manual-review pending corpus; the coverage matrix does not use the representative gates above to
  pretend all combinations are promoted.

The current `+` categories and bottom hints are in [chat-composer-action-menu.md](chat-composer-action-menu.md):
directly choose attachment, goal, plugin, file and session; `@`, `/`, `$` are explained at the bottom and no
longer separate menu items.
