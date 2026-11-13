# External sessions: sessions recorded by other AI coding CLIs

Status: v1 implemented on `feat/sessions-other-programs` (2026-11-07). Hardened 2026-11-12 (PR #383
review): read-only store access that writes nothing beside a store, bounded SQLite listing, streamed
transcript replay, id and cwd rules. See "Storage access and bounds".

ZCode shows, in the existing Manage sessions settings section, the sessions that other AI coding
tools recorded on this machine for the same workspaces — Claude Code, Codex, OpenCode, Cursor and
Gemini CLI — and lets the user open a read-only transcript, resume the session in its native CLI,
continue it as a ZCode draft, or (Claude Code only) import it as a ZCode task through the existing
import path. This spec is the product contract for `packages/services/src/external-sessions`
(Host scanner + service), the `ExternalSessions` service channel and the
`packages/ui/src/external-sessions` panel.

## Problem

A developer alternates between several agents on one repository. Each tool keeps its own history
in its own format and nothing shows the whole picture per project. Upstream already ships a
one-shot Claude Code import (`scanImportableClaudeSessions` / `importClaudeSessions`, the hidden
Migration section) but it copies sessions into ZCode tasks; it is not a view, it supports one
source, and it cannot hand the session back to the native tool.

## Product rules

- **Read-only by construction.** The scanner never writes under another tool's directory: SQLite
  stores are opened without creating sidecar files (see "Read-only stores"), and JSONL files are
  read with bounded head/tail reads or streamed line by line. Nothing from another tool is written
  into `tasks-index.sqlite` or any ZCode store: external rows exist only in a per-Host in-memory
  cache and are rebuilt on demand.
- **Desktop and local only.** External sessions live on the machine that runs the Host. The service
  is registered only when `createLocalServices` runs with `serviceAuthorityMode === "desktop-local"`
  (the same gate as voice dictation), which only the desktop local Host sets; the HTTP and stdio
  server entry points share that factory and never register the channel, so it is absent on web, on
  web-remote attachments (the mobile RPC allowlist fails closed) and on remote workspaces. The UI
  treats an absent service as "unsupported" and renders nothing.
- **Metadata first, bodies lazily.** Listing reads only what a title, dates, cwd, model and a
  message count need (session heads, index tables). A transcript body is read only when the user
  opens it, and only user/assistant text — never tool inputs, tool outputs, reasoning, attachments
  or environment preambles — capped at `MAX_TRANSCRIPT_MESSAGES` (200) and
  `MAX_TRANSCRIPT_CHARS_PER_MESSAGE` (8000); the result carries `truncated`.
- **Per-source isolation.** Every source adapter runs independently; a missing tool, an unreadable
  store or a format drift marks that source `unavailable` with a reason and never hides the other
  sources. A single malformed session file is skipped with a `warn` log, not surfaced.
- **Workspace matching uses the session's own cwd**, never a directory-name slug (slugs are lossy
  in Claude Code and Cursor). Matching is a normalized-path equality against the ZCode workspace
  path (case-insensitive on win32), the same rule as the upstream Claude import. Sessions whose
  cwd no longer exists are still listed (the user may want the transcript), flagged
  `workspaceMissing`. A session with no cwd at all (Codex threads and rollouts) matches no
  workspace and is not listed.
- **Subagent and sidechain records are excluded** from listing and counts (Claude `isSidechain`
  and `subagents/` files; Codex threads whose `thread_source` is an explicit subagent kind (`subagent`, `guardian_review`,
  `review`) or that carry a subagent `source`, `agent_role` or parent thread id — unknown kinds such
  as `user`/`main` stay listed so a new Codex kind never hides every session; Cursor `subagents/`).
- **Privacy.** Logs name sources, counts and file paths only; never titles or message text.
  Nothing leaves the machine: the panel is desktop-local and no relay or web path carries it.
- **No new persistence, no `setting.json` keys, no shared-DB changes.** Filter and column state of
  the panel live in `localStorage` like the rest of the sessions manager.

## Sources (v1)

| Source      | Id         | Where it is read                                                                                                                                                                                                                                                                               | Listing fields                                                              | Transcript                                                                                                                                                             | Resume command                              |
| ----------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Claude Code | `claude`   | `~/.claude/projects/<slug>/<sessionId>.jsonl` via the upstream `claudeNativeSessionImportRepo` scan + head parser                                                                                                                                                                              | cwd, created/updated, preview title, (model, branch)                        | yes (upstream parser `parseClaudeNativeSessionFile`)                                                                                                                   | `claude --resume <sessionId>`               |
| Codex       | `codex`    | `~/.codex/state_5.sqlite` table `threads` (read-only; only `id` and `rollout_path` are required, other columns are selected when present); rows whose `rollout_path` is missing on disk are dropped; without the index, rollout `session_meta` heads are read with the same subagent exclusion | cwd, title/first_user_message, created/updated, model, git_branch, archived | yes, from the rollout JSONL (`response_item` messages of role user/assistant; `developer` skipped; `thread_rolled_back` events replayed); `.zst` archives are not read | `codex resume <sessionId>`                  |
| OpenCode    | `opencode` | `~/.local/share/opencode/opencode.db` tables `session_v2` + `session_message` (read-only)                                                                                                                                                                                                      | directory, title, created/updated, model JSON, message count                | yes (`session_message` rows of type user/assistant, text parts only)                                                                                                   | `opencode --session <sessionId>`            |
| Cursor      | `cursor`   | `~/.cursor/acp-sessions/<id>/meta.json` and `~/.cursor/chats/<md5(cwd)>/<agentId>/meta.json`                                                                                                                                                                                                   | cwd, title (acp) / name, created/updated (chats meta), no model             | **no** (blob stores are opaque; `transcriptAvailable: false`)                                                                                                          | `cursor-agent --resume <sessionId>`         |
| Gemini CLI  | `gemini`   | `~/.gemini/projects.json` → `~/.gemini/tmp/<name>/chats/session-*.jsonl`                                                                                                                                                                                                                       | project path, created (`startTime`) / updated (`lastUpdated`), model, count | yes (records of type user/gemini after replaying the journal: `$rewindTo`, `$patch`, `$set.messages`)                                                                  | `gemini --resume <sessionId>` (best effort) |

Roots honour `HOME`; tests inject `homeDir` explicitly. Adapters live one per file under
`packages/services/src/external-sessions/adapters/`, each exporting a pure
`ExternalSessionSourceAdapter { source, list(ctx), readTranscript(ctx, ref) }`. Adding a source is
adding one adapter and one catalog entry (label + resume template); the UI derives chips from the
catalog.

## Contract

### Service (`packages/services/src/external-sessions/contract.ts`, channel `external-sessions`)

```ts
type ExternalSessionSource = "claude" | "codex" | "opencode" | "cursor" | "gemini";

interface ExternalSessionSummary {
  source: ExternalSessionSource;
  sessionId: string;
  /** Stable key `${source}:${sessionId}`; the UI row key. */
  key: string;
  workspacePath: string; // the session's own cwd
  workspaceMissing: boolean;
  title: string; // never empty; falls back to the source label + short id
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
  model?: string;
  gitBranch?: string;
  messageCount?: number; // user + assistant, when the listing can know it cheaply
  sourcePath: string; // file or db path, for "Show in file manager" and diagnostics
  transcriptAvailable: boolean;
  importable: boolean; // the upstream Claude importer accepts it (not under .claude/worktree(s)); false for other sources
  resumeCommand: string; // ready to paste; argument quoted for POSIX sh
}

interface ExternalSessionsListParams {
  workspacePath?: string; // omit = all workspaces
  sources?: ExternalSessionSource[]; // duplicates are ignored, of any count: the schema dedupes before any length bound, and each source is scanned once
  search?: string; // case-insensitive substring over title + sessionId
  limit?: number; // default 200, max 1000
  refresh?: boolean; // bypass the cache
}

interface ExternalSessionsListResult {
  sessions: ExternalSessionSummary[]; // sorted by updatedAt desc
  // Requested sources report this scan; sources outside the request report their last cached
  // status, or `not scanned` when no scan ever ran (the client must not read that as unavailable).
  sources: Record<ExternalSessionSource, { available: boolean; count: number; reason?: string }>;
  scannedAt: number;
}

interface ExternalSessionTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  model?: string;
}
interface ExternalSessionTranscript {
  summary: ExternalSessionSummary;
  messages: ExternalSessionTranscriptMessage[];
  truncated: boolean;
}

interface IExternalSessionsService {
  listExternalSessions(params: ExternalSessionsListParams): Promise<ExternalSessionsListResult>;
  readExternalSessionTranscript(ref: { source; sessionId }): Promise<ExternalSessionTranscript>; // throws `not_found` / `transcript_unavailable`
  /** macOS: opens Terminal.app running `cd -- <cwd> && <resumeCommand>`; elsewhere `{opened:false, command}` and the UI offers copy. */
  openExternalSessionInTerminal(ref: {
    source;
    sessionId;
  }): Promise<{ opened: boolean; command: string; error?: string }>;
}
```

Params are validated with zod inside the service (ProxyChannel does not validate). The cache is one
map per Host keyed by `source`, holding the last full listing for `CACHE_TTL_MS` (15 s); a `search`,
`workspacePath` or `sources` filter is applied over the cached listing, so switching chips costs no
rescan. `refresh: true` and the panel's Refresh button invalidate it.

Event order and owners:

```
UI panel ──list(params)──▶ ExternalSessionsService ──(cache miss)──▶ adapters[*].list  (Promise.allSettled)
                                     │                                     │
                                     └──── per-source status + merged, filtered, sorted summaries ◀┘
UI row ──readTranscript(ref)──▶ service ──▶ adapter.readTranscript (bounded read) ──▶ messages
UI row ──openInTerminal(ref)──▶ service ──▶ macOS `.command` script (same helper as the ACP login)
```

The service owns the cache and the catalog; adapters own nothing (stateless, pure functions of the
file system). No file watcher in v1: the panel refreshes on open, on scope/source change after TTL,
and on the Refresh button. Desktop windows each run their own Host and therefore their own cache;
there is no shared state to reconcile.

### Terminal resume

`openExternalSessionInTerminal` reuses the ACP login terminal helper (`acpAgentLogin.ts`): a
temporary `.command` script run by `open -a Terminal`. The script is
`cd -- <quoted cwd> && <resumeCommand>` and the same launch-rule check rejects NUL/CR/LF in any
argument. The `--` ends `cd`'s option parsing, so a recorded cwd that starts with `-` is a path,
never an option. A bare `-` operand is special to `cd` even after `--` (it means `$OLDPWD`), so a cwd
that starts with `-` is written as `./<cwd>` before quoting (`cd -- ./-` enters a directory named `-`).
Adapter cwds are absolute paths; the prefix only matters for a malformed store value. Session ids are validated against `^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$` before they reach a
command line (see "Session ids"); anything else is `transcript`-only. When the workspace directory is missing the command runs
from `$HOME` and the UI says so. Non-macOS: `{ opened: false, command }` and the panel copies the
command to the clipboard instead.

### UI (`packages/ui/src/external-sessions`, hosted by `SessionsSettingsSection`)

- A panel titled "Sessions from other tools" renders under the ZCode sessions table in the same
  section, obeying the same scope chip (workspace-scoped when entered from a project menu) and the
  same debounced search text. It is rendered only when `externalSessionsService` is present on the
  base workspace services (desktop local Host) and the scope is not a remote workspace identity
  (`isRemoteWorkspaceIdentity`): external sessions are local facts, and a scope identity is never
  attached to one because its path happens to match.
- The hook sends `refresh: true` only for the one request the Refresh button started; later search,
  scope or source changes are served from the Host cache.
- Service calls (list, transcript, terminal, Claude import, project resolution) live in the module's
  hooks (`useExternalSessions`, `useExternalSessionActions`); the panel and dialog only render and
  keep dialog/busy state.
- Header: source chips (one per catalog source with its count; unavailable sources are shown
  disabled with the reason in a tooltip) and Refresh. Only selected chips show the unavailable
  style: a deselected source is not scanned by that request, so its chip shows the last known count
  (from an earlier scan) or none, never "unavailable". An empty stored selection means "every
  source"; toggling a chip expands that sentinel first, so a click always flips that chip alone.
  The selection rules live in pure helpers in `panelViewState.ts` and are unit-tested
  (`packages/ui/test/externalSessionsPanelSelection.test.ts`). Required cases: a persisted selection
  `["claude"]` where Claude was scanned with zero sessions and the other sources were never scanned
  shows "No sessions…" (not "No readable session stores…"); a deselected chip is never styled
  unavailable; a chip count is shown only for an active chip or a source that is available.
- Rows (a plain list, not virtualised; one request returns at most `limit` rows, default 200): source mark + label, title, cwd leaf
  (hidden when scoped), model, message count, updated (relative), and a `⋯` menu:
  - **Open transcript** (disabled with hint when `transcriptAvailable` is false)
  - **Resume in <tool>** → `openExternalSessionInTerminal`; on `{opened:false}` falls back to copy +
    toast
  - **Continue in ZCode** → reads the transcript, resolves the session folder's local project through
    `projectService.saveProject({ roots: [cwd], reuseExistingRoot: true })` (the same idempotent step
    "Open folder" performs; `targetWorkspace.workspacePath` alone would let `prepareSession` allocate
    an unrelated managed directory) and calls `onCreateTask({ initialPrompt, projectId, hostId:
"local", targetWorkspace })`; nothing is sent automatically, the user reviews the draft. A session
    whose folder is missing gets a toast naming that folder path instead, and so does a folder that is only a secondary root
    of an existing project (`prepareSession` starts drafts in the primary root, which would silently
    change the cwd). The pack is: a one-line header naming the source and
    title, then the last `CONTEXT_PACK_MESSAGES` (12) user/assistant messages, each trimmed to
    `CONTEXT_PACK_CHARS_PER_MESSAGE` (1200), ending with "Continue from here." This is lossy by
    design and labelled as such in the UI.
  - **Import to ZCode** (Claude Code only) → existing `zcodeTaskService.importClaudeSessions` for
    the session's workspace, then `onOpenSession` on the imported task. The item is disabled with
    an explanation when `importable` is false: the upstream importer rejects sessions whose cwd is
    under `.claude/worktree(s)` even though the panel lists them (transcript, resume and continue
    stay available). Other sources do not offer
    it: imported rows would need a `migrationSource` value the upstream realtime schema rejects
    (`z.enum(["claudeCode"])`) and the tasks index is shared with upstream.
  - **Copy resume command**, **Copy session id**, **Show in file manager** (`sourcePath`).
- Transcript dialog: read-only list of user/assistant bubbles rendered through the existing
  markdown `MessageResponse`; a banner states the source, the count and whether it was truncated;
  footer buttons Resume / Continue in ZCode / Import (as above).
- Empty states: "No sessions from other tools for this workspace" (scoped) / "…on this Mac"; a
  source with `reason` shows it inline when every selected source is unavailable (sources outside
  the selection never count towards that message).
- i18n: all strings in `en-US`, `zh-CN`, `uk-UA` (`externalSessions.*`); catalog labels are product
  names and stay untranslated.

## Storage access and bounds

### Read-only stores

A plain `readOnly` open still creates `-shm` next to a WAL database and can replay its `-wal`, so
`withReadOnlySqlite` (`adapters/shared.ts`) never opens another tool's store in place:

- a store with a non-empty `-wal` (Codex keeps recent threads there) is copied together with its
  wal into a private temp directory, and the copy is opened; the temp directory is removed before
  the call returns;
- any other store is opened with `immutable=1` (a `file:` URI), which takes no locks and creates no
  sidecar files.

Rule: a scan leaves the other tool's directory byte-identical. `externalSessions.hardening.test.ts`
checks the directory tree before and after a scan of a WAL-backed Codex store and a closed OpenCode
store. Trade-off: a store that is written while it is copied can yield an inconsistent snapshot;
that surfaces as a source `unavailable` on that scan and is retried on the next one.

### Scan cost

`node:sqlite` is synchronous, so SQLite work runs on the Host event loop during a scan. Decision
(this change): keep it on the loop and bound it instead of moving it to a worker thread.

- OpenCode lists the 500 most recently updated root sessions per store (`OPENCODE_LIST_LIMIT`), and
  message counts are one indexed query over only those sessions. The earlier whole-table GROUP BY
  is gone.
- The OpenCode title fallback (first user message) is one query per listed session without a stored
  title; it is bounded by the 500-row page.
- Codex reads the `threads` table in one query, then stats each rollout and cwd (no per-row SQL).
- Claude Code and Gemini list from bounded head and tail reads of each session file (upstream helper
  and `readJsonLinesHead` / `readJsonLinesTail`); Cursor reads small metadata files.

Follow-up if a scan still blocks the Host noticeably: move the SQLite listing into a `worker_thread`
owned by the external-sessions service. Not done here; the measured full scan before the bounds was
about 350 ms on the development Mac, and no re-measurement is recorded in this spec.

### Transcript bounds

- The final transcript keeps the last `MAX_TRANSCRIPT_MESSAGES` (200) user/assistant messages, each
  cut at `MAX_TRANSCRIPT_CHARS_PER_MESSAGE` (8000) characters with `…`; `truncated` is set when
  either cap applied.
- Codex and Gemini JSONL rollouts are streamed line by line (`forEachJsonRecord`). Codex keeps a
  window of at most 400 messages while it replays records in file order, so memory does not grow with
  the file. A `thread_rolled_back` that removes more turns than the window holds is approximated: the
  window's messages are dropped, and the messages before the window are not recovered. Transcripts
  longer than the window are already truncated, so the banner still shows.
- Gemini keeps every record of a session file, because its journal patches and rewinds address
  earlier messages by id; a bounded window would change its replay result. Streaming avoids holding
  the raw file text, not the parsed records.
- Claude Code transcripts use the upstream parser `parseClaudeNativeSessionFile`, which reads the
  whole file on open. Known limitation: the fork does not stream it, and upstream files are not
  changed for this. Only the user-opened transcript pays this cost, never the listing.
- OpenCode reads all rows of the one session being opened, and caps them afterwards.

### Session ids

An id reaches a command line only when it matches `^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$`. A leading
`-` is rejected: the target CLI would otherwise read the id as an option (`codex resume --...`).

## Non-goals (v1) and follow-ups

- Resuming through the ACP runtime (`session/load` with a native id): unverified whether
  `claude-agent-acp` / `codex-acp` / `opencode acp` / `cursor-agent acp` accept ids their own CLI
  created, and the only seam is pre-writing `fork_acp_session_binding` in the CLI DB. Follow-up
  after a live spike; the terminal resume is the v1 behaviour.
- Merging external rows into the ZCode sessions table itself (one table, one Source column): the
  row model is `WindowHostControllerTaskListItem` with service-backed actions; a non-task row kind
  is a separate refactor. v1 is a sibling panel in the same section.
- Importing non-Claude sources as ZCode tasks (needs a fork-owned source marker instead of
  `migrationSource`).
- Cursor transcript bodies (blob store with a `blobEncryptionKey`; format not understood).
- Codex `.zst` archived rollouts; Gemini subagents; a file watcher / live counts.
- Windows/Linux terminal launch (copy-to-clipboard fallback only).

## Acceptance scenarios

1. Desktop, workspace scoped: with a Claude Code session whose cwd equals the workspace, the panel
   lists it with its title and relative time; a Claude session with `isSidechain` or under a
   `subagents/` directory is not listed. Sessions whose cwd is a worktree are ordinary sessions of
   that worktree workspace (the upstream import's worktree exclusion is not applied).
2. Unscoped: sessions from all five sources appear sorted by `updatedAt`; a source whose store is
   absent shows a disabled chip with a reason and no error state for the others.
3. Opening a transcript of an OpenCode session shows only user/assistant text in order, tool rows
   excluded; a session with more than 200 messages shows the truncation banner.
4. Resume on macOS opens Terminal in the session's cwd running the source's resume command; the
   command never contains CR/LF, and a session id failing the id pattern has no Resume item.
5. Continue in ZCode opens the workspace composer with the context pack as an unsent draft.
6. Import to ZCode on a Claude row creates the task through the upstream import and opens it; the
   row keeps showing in the panel (the panel is a view of the external store, not of imports).
7. Web / web-remote / remote workspace: the panel is absent; no RPC call is made.
8. Desktop E2E (`packages/desktop/test/e2e/external-sessions-settings.test.ts`, run in the Linux
   container, never on the developer's Mac): with one Claude Code session and one Codex rollout
   written into the isolated E2E home, Settings → Sessions lists both with their source marks; the
   Codex chip hides its rows and a second click restores them; a Claude row opens the read-only
   transcript dialog showing the user and assistant text, and Escape closes it. Not covered: Resume
   (macOS Terminal), Import, and Continue.

## Tests

Fork Vitest (`scripts/fork-test-files.json`):

- `packages/services/test/externalSessions.{claude,codex,cursor,gemini,opencode}.test.ts`: one file
  per adapter. Fixture directories under a temp `homeDir` (JSONL heads, a tiny OpenCode/Codex SQLite
  built in the test) assert listing fields, exclusions (sidechain, worktree cwd, missing rollout),
  transcript extraction and truncation.
- `packages/services/test/externalSessions.hardening.test.ts`: read-only store access (directory tree
  unchanged across a scan, WAL rows still listed), `titleFromPrompt` on a 920 KB prompt, the Codex
  transcript window and rollback order, a missing cwd is not listed, and the id pattern.
- `packages/services/test/externalSessions.service.test.ts`: per-source isolation
  (`allSettled`), cache TTL / refresh, filters, zod rejection, resume command quoting and the
  id pattern, `.command` script content.
- `packages/ui/test/externalSessionsContextPack.test.ts`: context pack composition and limits.

- `packages/desktop/test/e2e/external-sessions-settings.test.ts`: desktop E2E for scenario 8, run only
  in the Linux container (`~/Dev/zcode-qa/e2e-box/run-e2e-box.sh`).
