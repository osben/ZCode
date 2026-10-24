# Local Project Uses the System Multi-Directory Picker

## Behavior and Ownership

Desktop "create local project" and "add folder" when editing a local project use the operating system's
native directory dialog and allow selecting several directories at once. It reuses the platform interface's
native-dialog capability and adds an optional `IPlatformService.selectDirectories(): Promise<string[]>`;
Electron main uses `openDirectory`, `createDirectory`, `multiSelections`, returns all paths, and returns an
empty array on cancel. The old single-select `selectDirectory` contract is unchanged.

ProjectEditor stays the sole draft owner of name, roots and primary. Multi-select results append in return
order with de-duplication. With no prior roots the first directory becomes primary, otherwise the existing
primary is kept. Selecting creates no project, opens no workspace and starts no Agent; only an explicit
save calls the original `saveProject`.

```text
desktop + local Host -> platform selectDirectories -> preload IPC -> main native multi-select
                                                         ↓ all paths / []
                                                ProjectEditor draft
                                                         ↓ explicit save
                                                   Host saveProject
remote / Web / mobile -> original projectService.readDirectory(hostId) -> same draft
```

## Boundaries and Failure Semantics

- The system picker is used only when `hostId` is unspecified or `local` and the platform provides
  `selectDirectories`; the decision does not depend on the current tab/cwd. A remote project keeps
  browsing its own Host; Web/mobile lack this capability and cannot choose a directory on the browser's
  device as a Host root.
- While a native selection is in flight, edit, save, delete and close are disabled so the async return and
  draft edits do not interleave; the result is merged once afterward. A result after unmount cannot trigger
  persistence or reopen the editor.
- Cancel does not modify the draft; a failure shows the original error area, keeps the draft and allows
  retry, without auto-switching to another selection method.
- Directory selection does not change Host organization state, workspaceIdentity, owner/lease, desktop
  continuous or mobile replayable semantics; no database/CLI protocol migration.
- Light/dark themes follow the original editor; the system dialog is rendered by the OS; macOS, Windows
  and Linux share the Electron native directory options.

## Acceptance Cases (accepted / pending)

| Case  | Action and assertion |
| ----- | -------------------- |
| NDP01 | Desktop local: click add, select two real directories at once; native args include multi-select, no in-app directory browser; after save, re-edit still has two directories |
| NDP02 | Append a multi-select result containing an existing directory: only new ones are appended and the original primary is kept; cancel changes nothing; cancelling the edit does not save |
| NDP03 | In-flight native selection blocks save/close; after failure the draft is kept and retryable; a remote Host browses via the Host even with native capability; Web/mobile without native capability can still browse |
| NDP04 | Old single-select still returns one path or null; multi-select cancel returns []; light/dark editor usable |

Electron interaction candidate:
`packages/desktop/test/e2e/ui-shell/manual-review/pending/project-native-directory-picker.test.ts`. The mock
replaces only the user's return value of the system dialog and really exercises UI -> preload -> main, save
and re-edit; it does not claim to cover mouse multi-select inside the native OS window. Unit tests cover
Host/platform boundaries and failure/in-flight states. The existing local directory browse E2E uses the
native dialog mock. Real phone connection and Windows/Linux GUI need separate verification.

Verification outcome (2026-09-15): 5 unit files / 21 tests, `pnpm typecheck`, desktop `typecheck:e2e`,
`pnpm lint` (0 errors) passed; Electron 2/2 (NDP01/NDP02, existing WCP01 delete-then-restart regression,
light/dark screenshots); `architecture:check --changed --base HEAD` 0 violations. Not run: real phone
pairing, SSH/WSL Host, Windows/Linux GUI, manual multi-select inside the native dialog.
