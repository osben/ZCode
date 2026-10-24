# SEA SMB Upload

## Background

`docs/design/v2/sea-cross-target-packaging.md` defines the first 6 SEA binaries:

- `zcode-darwin-arm64`
- `zcode-darwin-x64`
- `zcode-linux-arm64`
- `zcode-linux-x64`
- `zcode-windows-arm64.exe`
- `zcode-windows-x64.exe`

They are generated in `packages/cli/dist` and must be uploaded at release time to the
`zcode/deps/zcode-cli-<version>` directory of the internal SMB share. `<version>` must come from the
`version` of the repository root `package.json`, the same source as the CLI version.

## Goals

- A standalone Node.js script uploads the 6 SEA binaries.
- Default destination is the mounted SMB directory `/Volumes/shared/zcode/deps/zcode-cli-<version>`.
- Check whether the target version directory already exists before uploading.
- If the target version exists and `--force` is not given, interactively prompt the user to abandon or
  force the update.
- Show file-level and total progress during upload.
- Parameters override the dist directory, destination root, SMB URL label and version, for testing and
  temporary releases.
- No new `ZCODE_*` environment variable; never write the SMB password into the repository, logs, command
  examples or test fixtures.

## Non-goals

- No full release pipeline, signing, checksum manifest or package-manager publishing.
- No SMB protocol client. The script writes into the mounted share through Node.js file system APIs
  only.
- Never save, read or print the SMB password. Credentials are handled by the OS SMB mount, keychain or
  an administrator flow.
- When the default `/Volumes/shared` is missing, do not create a same-named local directory, to avoid
  copying artifacts to a fake local mount point.

## User interface

- `node packages/cli/scripts/upload-sea-smb.mjs`
- `node packages/cli/scripts/upload-sea-smb.mjs --force`
- `node packages/cli/scripts/upload-sea-smb.mjs --dest-root /Volumes/shared/zcode/deps`
- `node packages/cli/scripts/upload-sea-smb.mjs --dist packages/cli/dist`
- `node packages/cli/scripts/upload-sea-smb.mjs --version 0.12.3`
- `pnpm --filter @zcode/cli upload:sea`

Defaults:

- SMB URL label: `smb://10.0.0.100/shared` (host overridable via `INTRANET_MACHINE_HOST`)
- Mount root: `/Volumes/shared`
- Destination root: `/Volumes/shared/zcode/deps`
- Version directory: `zcode-cli-<root package version>`

`--smb-url` is used only in error messages and the target description in logs; it plays no part in
authentication and carries no password.

## Upload contract

The script must derive the full file list from `supportedTargets` and `outputBinaryName()`, so that
hand-written artifact names cannot drift from the packaging contract.

Upload flow:

1. Read the root `package.json` `version`, or use `--version`.
2. Validate the version string: non-empty, no path separators, no `.` / `..` directory names.
3. Validate that all 6 SEA binaries exist under `packages/cli/dist` and are regular files.
4. Validate that the default mount root `/Volumes/shared` exists; a custom `--dest-root` may be created
   on demand.
5. Create the destination root.
6. If `zcode-cli-<version>` already exists:
   - `--force`: continue with a forced update.
   - Interactive TTY: prompt the user to choose `abandon` or `force`.
   - Non-interactive: abort and suggest `--force`.
7. Copy first into a temporary staging directory under the same destination root.
8. Replace the target version directory only after the staging copy completes, to shorten exposure of a
   half-finished upload.
9. After upload, print the target directory, file count and total bytes.

The forced-update replacement deletes the existing version directory and renames the staging directory
to the final directory. Deletion is restricted to the `zcode-cli-<version>` directory; deleting the
destination root or any ancestor is not allowed.

## Progress contract

Copying counts bytes from stream chunks and prints:

- Current file index and file name.
- Bytes copied of the current file / file size.
- Total bytes copied / total size.
- Total percentage.

A TTY may reuse a single refreshed line; a non-TTY prints discrete progress lines so long runs do not
look silent.

## Error behavior

- Root `package.json` missing, unparsable or `version` invalid: abort.
- Any SEA binary missing: abort and suggest running `pnpm --filter @zcode/cli build:sea` first.
- Default SMB mount root missing: abort and suggest mounting `smb://10.0.0.100/shared` first.
- Target version exists and the user chooses abandon: leave the target directory untouched, exit
  successfully.
- Target version exists, non-interactive and no `--force`: abort.
- Staging copy fails: clean the staging directory and keep the existing version directory.
- Rename or delete fails: rethrow the original cause; the CLI boundary formats it.

## Test coverage

- Argument parsing: defaults, `--force`, `--dest-root`, `--dist`, `--version` and unknown arguments.
- The version directory name comes from the root `package.json`, and path-traversal versions are
  rejected.
- The SEA binary list comes from the `supportedTargets` mapping; a missing file errors.
- Choosing `abandon` for an existing version directory copies no files.
- Choosing `force` or passing `--force` replaces the target directory.
- Copying emits progress events and preserves file contents.
- A missing default mount root does not create a fake `/Volumes/shared` directory.
