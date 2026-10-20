# Gen UI Fixed Output Directory

## Directory Contract

Generated files use a fixed output root provided by the execution-side Host, located by default under `visualizations/` in the app data directory. The Agent must not fall back to the current working directory. Workspace identity (or `workspacePath` when identity is missing) and session ID together determine a session subdirectory under the root.

“Fixed directory” is an output-location convention, not a restriction that the directory must be outside the workspace. The Host's output root remains valid when the user opens Home, the filesystem root, or another workspace that contains the app data directory. Code must not reject initialization or reads because the output root equals or is inside the workspace. Do not change generation guidance in the Skill.

The session subdirectory organizes generated files; it is not a read-authorization boundary. When reading a file in the fixed Host output root, do not require that its path belong to the current workspace/session. A fork that inherits an HTML path from its parent session can load it directly; it does not need to copy the file or rewrite historical messages. Widget state continues to be saved by current workspace/session.

Continue rejecting paths outside the Host output root, child-directory or file symlinks under the root, non-regular files, invalid HTML fragments, and files above the size limit. The Host output root itself may be resolved through a symlink, but after resolution the same root-containment checks still apply.

## Call Chain and Impact

```text
Host provides fixed root → derive output directory by workspace/session → Agent initializes/generates
                                                                          ↓
UI read request (may reference parent session path) → execution Host validates root and file → existing desktop sandbox
```

The previous check incorrectly interpreted “do not generate in the current directory” as “the output must be outside the workspace.” This caused Gen UI initialization to fail when Home was the workspace and also blocked Skill-directory and message execution that depended on the same context initialization.

Another incorrect assumption treated output-directory grouping as read isolation, so fork messages could not render after retaining their parent-session paths.

This change removes the workspace-containment and cross-session/workspace file-read restrictions. It does not change the Skill, fixed-root selection, or fork copying rules.

HTML reads for SSH / WSL / Docker / Server must pass through the remote `gen-ui` RPC channel. The Desktop Host's forwarding registration and RPC contract must include this channel. When legacy mixed services are merged, the remote `genUiService` must be selected explicitly, and the local output root must not be used to validate remote paths merely because local services were expanded. Read failures are returned as-is and do not fall back to a local read; output-root validation is not removed.

```text
Gen UI card → workspace services → Desktop Host forwarding → Source gen-ui.readDocument
                                                              ↓
                                                   execution-side output root validation / read
Gen UI card → desktop base services → widget state / prepareSandbox → desktop sandbox
```

Workspace identity, session ID, and file path follow the original request; no caching, retry, or file copy is added. The desktop continuous and mobile replayable paths retain their existing boundaries. Mobile without a Gen UI sandbox continues to show the existing desktop-only prompt; the mobile RPC allowlist is not extended. HTML is still read by the execution-side Host, and widget state still belongs to the desktop host.

## Regression Verification

- Path unit tests cover the output root inside the workspace, equal to the workspace, the filesystem root as workspace, and local/SSH workspace identities; relative paths remain rejected.
- File-read tests cover a workspace containing the output directory, cross-session/workspace reads, root-alias resolution, and existing checks for escaping the root, symlinks, file type, and size.
- Existing Electron Gen UI E2E sets the workspace to an ancestor of the output root and verifies real file reading, rendering, and page interaction. When switching sessions, reference the same parent-session file to verify fork-history loading semantics. This is a local fixture for remote identity, not validation of real SSH transport or the full fork command.
- The remote-service regression passes two real RPC segments, Source → Desktop Host → Renderer, covering SSH / WSL / Docker / Server, legacy merge, original identity passthrough, and read-error passthrough; the mobile channel still rejects Gen UI.
- The Electron fixture uses different local and execution-side output roots and the production Renderer service-merge function. It verifies remote HTML rendering, cross-session remounting, widget state saved on the desktop, and the mobile prompt without a sandbox. The fixture validates service routing and the real Electron sandbox; it does not replace real SSH network or cross-OS real-machine validation.
