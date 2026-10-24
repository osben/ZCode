# Deep Link and project config trust boundary

> Status: Implemented (2026-08-06)
>
> Related spec: `docs/specs/workspace-hook-trust.md`

## Background

ZCode Desktop supports `zcode://workspace/open?path=...` to open a local workspace, and within the project
discovery scope also reads the Hook declarations of `zcode.json` and `.zcode/config.json` and the subagent
profiles of `.zcode/agents/*.md`. External deep links, repository files and remote workspaces are not
user-level trusted configuration: confirming "open this directory" does not mean confirming "execute the code
in this directory".

## Security boundary

- The Windows `zcode://` protocol command must put the external URL after `--`: in production `"<ZCode.exe>" "--" "%1"`, in development `"<electron.exe>" "<entry>" "--" "%1"`. `registerDeepLinkProtocol` is the registration owner; every normal startup overwrites the old registration so no unsafe template is kept.
- Windows packaged artifacts disable `enableNodeCliInspectArguments` before signing, so even when the old registration is not yet updated `--inspect` / `--inspect-brk` cannot start the main-process debugger. This setting does not modify the unpackaged dev Electron and does not disable the `runAsNode` that Agent startup needs.
- Argument isolation must happen before Electron's native startup parsing. URL validation and the single-instance lock in application JavaScript cannot replace this boundary; the OAuth, payment, workspace and share callbacks keep their original routing and validation.
- `zcode://workspace/open` is external input and is not equivalent to the user choosing a directory inside the app.
- The workspace path passed by a deep link must reject UNC / network paths before any filesystem probe.
- Opening a local directory from a deep link requires user confirmation first; when the user cancels, the workspace path must not be cached or delivered.
- The deep-link confirmation authorizes only opening the path and does not establish Workspace Hook Trust.
- `zcode://task/new` (see `specs/deeplink-new-task.md`) is external input of the same level: it must reuse the confirmation flow above and show a task text preview in the confirmation; it only fills a new draft and never sends automatically; `promptFile` is read by main, must lie inside the project directory after `realpath`, and rejects UNC, symlink escape, oversize and non-UTF-8 files; logs must not record the task text or file content.
- Project-level `zcode.json` and `.zcode/config.json` Hook declarations are treated as untrusted code and cannot enter an executable path by default.
- Discovery only produces an immutable `WorkspaceHookBundleSnapshot`; Runtime admission must complete before the Hook lifecycle and process start.
- Persistent Trust matches only by `workspaceIdentity + hookDeclarationDigest`; the bundle digest ensures the reviewed and the executed snapshots are consistent.
- Trust can be established only by review in a trusted Host's `设置 → 钩子 → 工作区` (Settings > Hooks > Workspace) or by an explicit `zcode hooks trust` command; a repository, environment variable or ordinary permission answer cannot authorize it.
- managed `deny` outranks persistent Trust and takes effect at the next dispatch gate.
- User-level Hooks and enabled-plugin Hooks keep running under their respective existing trusted-source rules.
- Project-level `.zcode/agents/*.md` must not rewrite the child runtime permission mode through frontmatter; `permissionMode` takes effect only for user-level or trusted-plugin profiles.

## Rollout and rollback

```text
external URL → exe [entry] -- URL written by the Windows protocol registration owner
             → Electron treats what follows -- as data → existing Deep Link routing and confirmation
old registration → the new Windows artifact's Inspector fuse rejects debug args → safe registration rewritten after a normal start
```

```text
trusted embedder / Host
  ├─ workspaceHookTrustEnabled = false
  │    -> project Hook hard block
  │    -> Trust store not read
  │    -> no review request created
  │    -> Trust records on disk kept
  └─ workspaceHookTrustEnabled = true
       -> discovery snapshot
       -> managed policy
       -> persistent Trust evaluation
       -> pending review or admitted dispatch
```

`ZCodeAppOptions.workspaceHookTrustEnabled` is a trusted bootstrap input and is not parsed from
workspace/project config or environment variables. The generic App factory defaults it to off; the Desktop/
Web/Mobile workspace Hosts of the ZCode Protocol turn it on explicitly at the trusted boundary. On a security
issue the Host can turn this field off to restore the hard block without deleting user records. This flag only
decides whether Trust admission is entered and never means automatic trust.

## Observability and privacy

Workspace Hook Trust records low-frequency structured events through the existing Logger Port, including
review created, trust selected, timeout, superseded, snapshot mismatch, policy block, Trust store failure and
toggle/rebuild failure. Logs contain only stable reason codes, generation, the SHA-256 digest of the workspace
identity and short digests of the bundle/declaration digest; they must not record command text, script
content, source path, Trust payload or interaction response body.

## Verification points

- Both the Windows production and development registrations put `--` before the URL, and repeated registration keeps the safe template; macOS/Linux registration behavior is unchanged and a registration failure still logs the original warning.
- With `--` added, OAuth, payment, workspace and share URLs stay unchanged in cold-start argument parsing and single-instance delivery.
- On a real Electron start, `--inspect`, `--inspect-brk` and `--remote-debugging-port` after `--` must not open a debugger; the Windows release package must also verify that the Inspector fuse is off, covering the old-registration upgrade scenario.
- Windows release acceptance covers fresh install, old-registration upgrade, cold start and an existing instance, and the path where the browser actually opens the protocol.
- A UNC deep link does no filesystem stat and delivers no `OpenWorkspacePath`.
- When the user cancels the deep link confirmation, the directory is not opened.
- After the user confirms a local directory, untrusted project Hooks still cannot execute.
- With the flag off, even when the Trust store already has an exact record, `workspace_hooks_feature_disabled` is returned, no record is read and no review is sent.
- With the flag on, execution happens only when the exact declaration digest matches; after a config change the affected declarations are reviewed again.
- managed deny can override an existing record and blocks later dispatch.
- A stale task/run/remoteSession/generation/snapshot response is rejected before store mutation.
- User-level Hooks, plugin Hooks and the project subagent permission boundary are not widened by this rollout gate.
