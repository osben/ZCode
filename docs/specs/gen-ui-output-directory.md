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

## Regression Verification

- Path unit tests: output root inside the workspace, equal to it, filesystem root as workspace, local/SSH workspace identities; relative paths remain rejected.
- File-read tests: workspace containing the output directory, cross-session/workspace reads, root-alias resolution, and the existing escape/symlink/file-type/size checks.
- Electron Gen UI E2E: workspace set to an ancestor of the output root; verifies real file reading, rendering, interaction. Switching sessions references the same parent-session file to verify fork-history loading. This is a local fixture for remote identity, not real SSH transport or the full fork command.
- Remote-service regression: two real RPC segments (Source → Desktop Host → Renderer) across SSH / WSL / Docker / Server, legacy merge, original identity passthrough, read-error passthrough; the mobile channel still rejects Gen UI.
- Electron fixture with different local and execution-side output roots and the production Renderer service-merge function: remote HTML rendering, cross-session remounting, widget state saved on the desktop, mobile prompt without a sandbox. It validates service routing and the real Electron sandbox, not real SSH network or cross-OS machines.
