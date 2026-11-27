# Hook entry script binding on zcode-rs (D24)

Status: implemented (PR 642).

## Background

Node binds a project hook's direct entry script into the hook declaration digest and checks the script again before
every dispatch (D24 in `docs/specs/workspace-hook-trust.md`, §12.9 and §14.6). A trusted `./hook.sh` that is later
swapped, deleted or made unreadable stops running.

Rust built the digest without the script, so:

- a Settings grant (the Host computes the digest with D24) never matched the Rust digest: HK06, HK07, HK18, HK19 and
  HK20 failed on Rust in the box;
- a trusted hook whose script was replaced kept running.

## Node reference

- `identifyWorkspaceHookScriptPath`, `readWorkspaceHookScriptState`, `readWorkspaceHookScriptStates`
  (`packages/shared/src/workspace-hook-config.ts`).
- `canonicalDeclarationPayload` and `canonicalScriptState` (`packages/shared/src/workspace-hook-digest.ts`).
- Admission: `workspace-hook-trust-evaluation.ts`, `isWorkspaceHookScriptUnavailable` (contracts).
- Dispatch re-check: `WorkspaceHookRuntimeAdmission.verifyScriptEntry`, `verifyHookBeforeDispatch`
  (`core/src/hooks/runner-helpers.ts`), the call in `runner.ts`.
- Grants: `grantWorkspaceHookTrust` (CLI), the review controller's grant, `grantWorkspaceHookTrustForProtocol`.
- Toggle re-check: `workspace-hook-mutation.ts` reuses the reviewed entry's recorded script entry.

## Rules

1. **Entry script path** (pure, `rust_cli_hooks::script_entry::script_path`), from the raw declaration:
   - interpreters: `sh`, `bash`, `zsh`, `node`, `python`, `python3`, `ruby`, `perl`;
   - `process`: an interpreter command takes `args[0]` (none or starting with `-`: no entry); any other command is
     the script itself, and on Windows it needs an extension. Prefixes `${ZCODE_PROJECT_DIR}/`,
     `${CLAUDE_PROJECT_DIR}/`;
   - `command`: never on Windows, never with a string `shell`. Trim ASCII space and tab, split on runs of them; every
     token, after stripping a prefix, must match `^[A-Za-z0-9_./@+=:,-]*$`. The first token is the script, or the
     second after an interpreter (not starting with `-`). Prefixes `"$ZCODE_PROJECT_DIR"/`, `"$CLAUDE_PROJECT_DIR"/`;
   - the path: strip the prefix; with no prefix and no `/`, a direct position is a PATH lookup (no entry) and an
     interpreter argument needs an extension (Node `extname`); the rest matches `^[A-Za-z0-9_./-]+$`, does not start
     with `/`, has no `..` segment, is `posix.normalize`d, and `.` is no entry.
2. **Script state**: `file` with the sha256 of the content, `missing` (not found, or a path component is not a
   directory) or `unverifiable` (not a regular file, larger than 16 MiB, any other error, the deadline). The path is
   `<workspace root>/<path>`, no symlink resolution of the path itself. A local workspace stats first, opens with
   `O_NONBLOCK` (a FIFO would block) and re-stats the open handle. A remote workspace reads through its `Files` port
   (stat, then read). The App review and `zcode hooks trust` read the scripts through the same `Files` port that read
   the config, so both come from one source.
3. **Discovery reads** every identified path of the bundle once (deduplicated by path), at most 8 at a time, under one
   5 s deadline; a read not done by then is `unverifiable`. An identified entry with no state is `unverifiable`, like
   Node's synchronous build.
4. **Digest**: after the optional `["onError", "deny"]`, append `["scriptEntry", path, ["file", sha256] | ["missing"]
| ["unverifiable"]]`. A declaration without an entry script keeps its digest.
5. **Admission**: an entry whose script is `missing` or `unverifiable` never runs and is not pending, even with a
   matching trust record. Its trust state is `blocked_untrusted`, reason `workspace_hook_script_unavailable`; a
   corrupt store keeps its own reason.
6. **Grants refuse** with `workspace_hook_script_unavailable` when any selected entry is unavailable, and write
   nothing: `zcode hooks trust grant` (also `--all-current`; JSON adds `unavailableItems`
   `"<event> <display> (<source>)"`, text adds `Entry script missing or unreadable:` and the items),
   `workspace/hooks/trustGrant`, and the App review grant (checked after the bundle match).
7. **Status and review**: unavailable items show `blocked_untrusted`. The status reason is
   `workspace_hook_script_unavailable` when enabled items are neither all trusted nor any pending. The review
   interaction counts them out of `pendingCount`.
8. **Dispatch re-check**: an admitted project hook with an entry script carries the recorded `(path, sha256)`. Right
   before it starts, the engine reads the script at the workspace root (the cwd the hook runs in), with its own
   deadline equal to the hook's timeout:
   - same content: the hook runs with its full timeout;
   - other content: blocked, `workspace_hook_declaration_changed`;
   - missing, unreadable, deadline: blocked, `workspace_hook_script_unavailable`;
   - a cancelled event: the hook is cancelled, no block.
     A blocked run has no effect and is recorded `blocked` with the reason. A failed re-check counts as a hook error, so
     a foreground `PreToolUse` hook with `onError: "deny"` blocks the tool.
9. **Toggle**: the digest re-check of `.zcode/config.json` reuses the reviewed entry's script state; the rebuild after
   the write reads the script again.

```text
discovery (session open, review, CLI)          dispatch (each hook run)
  config files ─► script_path ─► read states     admitted CommandHook{script: (path, sha256)}
                     │              │                     │
                     └──► digest ◄──┘                     ├─► ScriptVerifier.state(root, path) ─ timeout
                            │                             │        same ─► run
     trust records ─► admitted / pending / blocked        │        else ─► Raw::Refused(reason) ─► blocked record
```

## Acceptance

- A Node golden for script path identification (POSIX and Windows rules), for bundle digests without states
  (unverifiable) and with each state, matched by Rust.
- Rust unit tests: the reader's states (file, missing, a path through a file, a directory, a symlink, too large
  through the port, the discovery deadline; a FIFO is not covered, since creating one needs `unsafe`); admission and pending skip an
  unavailable entry; each grant path refuses; the dispatch re-check runs a same-content hook, blocks a changed or
  deleted script, denies the tool for `onError: "deny"` and never for a background hook.
- HK05, HK06, HK07, HK18, HK19 (`conversation-session/hooks/conversation-session-hook-trust`) and HK20
  (`conversation-session-hook-trust-worktree`) pass on Rust in the box.

## Known differences

- Node runs the hooks of one event one by one and re-checks each right before it starts. Rust starts them
  concurrently, so each one's re-check runs at its own start inside the batch.
- A cancelled re-check: Node records `blocked`; Rust records `cancelled`. Neither runs the hook nor denies the tool.
