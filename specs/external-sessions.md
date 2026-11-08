# External sessions: sessions recorded by other AI coding CLIs

Status: v1 implemented on `feat/sessions-other-programs` (2026-11-07).

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

- **Read-only by construction.** The scanner never writes under another tool's directory. SQLite
  stores are opened `readOnly`; JSONL files are read with bounded head/tail reads. Nothing from
  another tool is written into `tasks-index.sqlite` or any ZCode store: external rows exist only
  in a per-Host in-memory cache and are rebuilt on demand.
- **Desktop and local only.** External sessions live on the machine that runs the Host. The service
  is registered only by the local desktop Host (`createLocalServices`); it is absent on web, on
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
  `workspaceMissing`.
- **Subagent and sidechain records are excluded** from listing and counts (Claude `isSidechain`
  and `subagents/` files; Codex `thread_source` ≠ main; Cursor `subagents/`).
- **Privacy.** Logs name sources, counts and file paths only; never titles or message text.
  Nothing leaves the machine: the panel is desktop-local and no relay or web path carries it.
- **No new persistence, no `setting.json` keys, no shared-DB changes.** Filter and column state of
  the panel live in `localStorage` like the rest of the sessions manager.

## Sources (v1)

| Source      | Id         | Where it is read                                                                                                  | Listing fields                                                              | Transcript                                                                                                                       | Resume command                              |
| ----------- | ---------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Claude Code | `claude`   | `~/.claude/projects/<slug>/<sessionId>.jsonl` via the upstream `claudeNativeSessionImportRepo` scan + head parser | cwd, created/updated, preview title, (model, branch, count from head/tail)  | yes (upstream parser `parseClaudeNativeSessionFile`)                                                                             | `claude --resume <sessionId>`               |
| Codex       | `codex`    | `~/.codex/state_5.sqlite` table `threads` (read-only); rows whose `rollout_path` is missing on disk are dropped   | cwd, title/first_user_message, created/updated, model, git_branch, archived | yes, from the rollout JSONL (`response_item` messages of role user/assistant; `developer` skipped); `.zst` archives are not read | `codex resume <sessionId>`                  |
| OpenCode    | `opencode` | `~/.local/share/opencode/opencode.db` tables `session_v2` + `session_message` (read-only)                         | directory, title, created/updated, model JSON, message count                | yes (`session_message` rows of type user/assistant, text parts only)                                                             | `opencode --session <sessionId>`            |
| Cursor      | `cursor`   | `~/.cursor/acp-sessions/<id>/meta.json` and `~/.cursor/chats/<md5(cwd)>/<agentId>/meta.json`                      | cwd, title (acp) / name, created/updated (chats meta), no model             | **no** (blob stores are opaque; `transcriptAvailable: false`)                                                                    | `cursor-agent --resume <sessionId>`         |
| Gemini CLI  | `gemini`   | `~/.gemini/projects.json` → `~/.gemini/tmp/<name>/chats/session-*.jsonl`                                          | project path, created (`startTime`) / updated (`lastUpdated`), model, count | yes (records of type user/gemini; `$set` lines skipped)                                                                          | `gemini --resume <sessionId>` (best effort) |

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
  resumeCommand: string; // ready to paste; argument quoted for POSIX sh
}

interface ExternalSessionsListParams {
  workspacePath?: string; // omit = all workspaces
  sources?: ExternalSessionSource[];
  search?: string; // case-insensitive substring over title + sessionId
  limit?: number; // default 200, max 1000
  refresh?: boolean; // bypass the cache
}

interface ExternalSessionsListResult {
  sessions: ExternalSessionSummary[]; // sorted by updatedAt desc
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
  /** macOS: opens Terminal.app running `cd <cwd> && <resumeCommand>`; elsewhere `{opened:false, command}` and the UI offers copy. */
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
`cd <quoted cwd> && <resumeCommand>` and the same launch-rule check rejects NUL/CR/LF in any
argument. Session ids are validated against `^[A-Za-z0-9._:-]{1,128}$` before they reach a command
line; anything else is `transcript`-only. When the workspace directory is missing the command runs
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
- Header: source chips (one per catalog source with its count; unavailable sources are shown
  disabled with the reason in a tooltip) and Refresh. An empty stored selection means "every
  source"; toggling a chip expands that sentinel first, so a click always flips that chip alone.
- Rows (virtualised list, same row height as the ZCode table): source mark + label, title, cwd leaf
  (hidden when scoped), model, message count, updated (relative), and a `⋯` menu:
  - **Open transcript** (disabled with hint when `transcriptAvailable` is false)
  - **Resume in <tool>** → `openExternalSessionInTerminal`; on `{opened:false}` falls back to copy +
    toast
  - **Continue in ZCode** → reads the transcript, resolves the session folder's local project through
    `projectService.saveProject({ roots: [cwd], reuseExistingRoot: true })` (the same idempotent step
    "Open folder" performs; `targetWorkspace.workspacePath` alone would let `prepareSession` allocate
    an unrelated managed directory) and calls `onCreateTask({ initialPrompt, projectId, hostId:
"local", targetWorkspace })`; nothing is sent automatically, the user reviews the draft. A session
    whose folder is missing gets a toast instead. The pack is: a one-line header naming the source and
    title, then the last `CONTEXT_PACK_MESSAGES` (12) user/assistant messages, each trimmed to
    `CONTEXT_PACK_CHARS_PER_MESSAGE` (1200), ending with "Continue from here." This is lossy by
    design and labelled as such in the UI.
  - **Import to ZCode** (Claude Code only) → existing `zcodeTaskService.importClaudeSessions` for
    the session's workspace, then `onOpenSession` on the imported task. Other sources do not offer
    it: imported rows would need a `migrationSource` value the upstream realtime schema rejects
    (`z.enum(["claudeCode"])`) and the tasks index is shared with upstream.
  - **Copy resume command**, **Copy session id**, **Show in file manager** (`sourcePath`).
- Transcript dialog: read-only list of user/assistant bubbles rendered through the existing
  markdown `MessageResponse`; a banner states the source, the count and whether it was truncated;
  footer buttons Resume / Continue in ZCode / Import (as above).
- Empty states: "No sessions from other tools for this workspace" (scoped) / "…on this Mac"; a
  source with `reason` shows it inline when every source is unavailable.
- i18n: all strings in `en-US`, `zh-CN`, `uk-UA` (`externalSessions.*`); catalog labels are product
  names and stay untranslated.

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

## Tests

Fork Vitest (`scripts/fork-test-files.json`):

- `packages/services/test/externalSessions.adapters.test.ts`: fixture directories under a temp
  `homeDir` for every source (JSONL heads, a tiny OpenCode/Codex SQLite built in the test), asserting
  listing fields, exclusions (sidechain, worktree cwd, missing rollout), transcript extraction and
  truncation.
- `packages/services/test/externalSessions.service.test.ts`: per-source isolation
  (`allSettled`), cache TTL / refresh, filters, zod rejection, resume command quoting and the
  id pattern, `.command` script content.
- `packages/ui/test/externalSessionsContextPack.test.ts`: context pack composition and limits.
