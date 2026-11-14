# Gen UI Fixed Output Directory

## Directory Contract

1. Generated files use a fixed output root provided by the execution-side Host, by default under `visualizations/` in the app data directory. The Agent must not fall back to the current working directory.
2. Workspace identity (or `workspacePath` when identity is missing) and session ID together determine a session subdirectory under the root.
3. "Fixed directory" is an output-location convention, not a requirement that the directory lies outside the workspace. The root stays valid when the user opens Home, the filesystem root, or a workspace that contains the app data directory. Code must not reject initialization or reads because the root equals or is inside the workspace. Skill generation guidance is unchanged.
4. The session subdirectory organizes files; it is not a read-authorization boundary. Reading a file under the Host output root does not require its path to belong to the current workspace/session, so a fork that inherits an HTML path from its parent session loads it directly (no copy, no rewriting of historical messages). Widget state is still saved by current workspace/session.
5. Still rejected: paths outside the Host output root, child-directory or file symlinks under the root, non-regular files, invalid HTML fragments, and files above the size limit. The root itself may be resolved through a symlink; the same containment checks apply after resolution.

## Call Chain

```text
Host provides fixed root → derive output directory by workspace/session → Agent initializes/generates
                                                                          ↓
UI read request (may reference parent session path) → execution Host validates root and file → existing desktop sandbox
```

Remote (SSH / WSL / Docker / Server) HTML reads pass through the remote `gen-ui` RPC channel. The Desktop Host's forwarding registration and RPC contract include this channel. When legacy mixed services are merged, the remote `genUiService` is selected explicitly; the local output root is never used to validate remote paths. Read failures are returned as-is with no local fallback; output-root validation stays.

```text
Gen UI card → workspace services → Desktop Host forwarding → Source gen-ui.readDocument
                                                              ↓
                                                   execution-side output root validation / read
Gen UI card → desktop base services → widget state / prepareSandbox → desktop sandbox
```

Workspace identity, session ID, and file path follow the original request; no caching, retry, or file copy. Desktop continuous and mobile replayable paths keep their boundaries. Mobile without a Gen UI sandbox keeps the existing desktop-only prompt; the mobile RPC allowlist is not extended. HTML is read by the execution-side Host; widget state belongs to the desktop host.

Rationale: the old check read "do not generate in the current directory" as "output must be outside the workspace", which broke Gen UI initialization with Home as workspace, and treated session grouping as read isolation, which broke fork messages.

## Position in the prompt

The session output directory changes with the session ID, so it is not written into system but only into the environment notice (` - Visualization directory for this session: <path>`, see `apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`). App assembly reuses the effective enabled state of the official visualize plugin; when it is disabled or uninstalled, no output root is provided to the runtime. So a new session injects neither the directory nor the whole `Interactive views` of the Desktop section (including the control state notes), and sends no "unavailable" substitute hint. When enabled with a directory the existing explanation is kept; the rest of the Desktop context is unchanged. On upgrade the old switch is turned off once per [Visualize loading boundary](visualize-cli-loading.md), after which it may be enabled again. Enabling and disabling follow the runtime assembly timing; history prompts are not deleted, and resuming an old session still allows the existing environment delta to revoke the old directory. This change only controls context injection and does not change skills, file reads, rendering or state echo.

```text
parent session  system (snapshot, no directory) + # Environment ... Visualization directory: <parent dir>
  | fork: copy history and the prompt snapshot, and write one environment update after the copied history
  v
child session   system bytes identical to the parent
                # Environment update
                 - Visualization directory for this session: <child dir> (was <parent dir>)
```

Reason: system is frozen by the prompt snapshot, and a fork copies the snapshot to the child session. With the directory in the Desktop section of system, the child session would keep sending the parent's directory and generated files would be written into the parent's directory. In the environment notice system can be frozen as a whole and a directory change is announced as an environment update. The update is written into the child session at fork time and does not wait for the child's next collection of input attachments: the child's first request may be a new-turn notice, new-turn notices collect no attachments, and the model would write files into the parent's directory. The baseline is the latest environment notice in the child session's model view (after the last compaction); when the view has no environment notice nothing is written and the child's next notice sends a full block; when there is a notice but no directory and the fork carries no target working directory, nothing is written either.

When forking to another working directory (a managed worktree, see `docs/git/worktree.md`), the child's directory is computed from the child's working directory: the directory is determined by the workspace identity (the workspace path when there is no identity) and the session id. A local worktree child has no workspace identity, so its workspace path is the working directory, the same key as the child's own notice. The same environment update also writes the new `Primary working directory`; when the parent's notice has no directory, a fork that carries a target working directory also writes this update. The update is written the same way as an ordinary environment notice: when the baseline has no full block a full block is written, and when the Desktop section wording changed the new wording is included.

## Regression Verification

- Path unit tests: output root inside the workspace, equal to it, filesystem root as workspace, local/SSH workspace identities; relative paths remain rejected.
- File-read tests: workspace containing the output directory, cross-session/workspace reads, root-alias resolution, and the existing escape/symlink/file-type/size checks.
- Electron Gen UI E2E: workspace set to an ancestor of the output root; verifies real file reading, rendering, interaction. Switching sessions references the same parent-session file to verify fork-history loading. This is a local fixture for remote identity, not real SSH transport or the full fork command.
- Remote-service regression: two real RPC segments (Source → Desktop Host → Renderer) across SSH / WSL / Docker / Server, legacy merge, original identity passthrough, read-error passthrough; the mobile channel still rejects Gen UI.
- Electron fixture with different local and execution-side output roots and the production Renderer service-merge function: remote HTML rendering, cross-session remounting, widget state saved on the desktop, mobile prompt without a sandbox. It validates service routing and the real Electron sandbox, not real SSH network or cross-OS machines.
- CLI assembly tests capture the actual model request: the plugin is default off; when explicitly enabled the directory and explanation are kept; with no explicit config, disabled, uninstalled and globally disabled, nothing is injected and the other Desktop notes are kept.
- CLI unit tests cover: system has neither the Desktop section nor the directory; the environment full block has the directory and the Desktop section; after a fork the child's system bytes are unchanged, the child history carries one directory environment update after the copied messages and before the fork hint, nothing is written when the environment notice exists only before compaction, and a line is added when old environment metadata has no directory; when forking to another working directory the directory in the update equals the one the child runtime computes itself and the new working directory is written.
