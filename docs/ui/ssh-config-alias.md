# SSH Config Alias

## Goal

In the SSH connect dialog, support directly choosing a `Host alias` of the local `ssh config`, reducing the
cost of filling in `host/port/user/privateKey` by hand.

## Behavior

- In SSH mode a new `SSH Config Alias` dropdown lazily loads candidates on demand.
- Selecting an alias auto-fills: `HostName -> host`, `Port -> port`, `User -> username`,
  `IdentityFile -> privateKeyPath`. When the alias has an `IdentityFile`, the auth method switches to
  `privateKey` automatically.
- Later manual edits to the key SSH fields (host/port/username/privateKey) clear the "alias selected" state to
  avoid misleading.
- An SSH remote workspace established through an alias writes the alias into the remote target snapshot as
  non-sensitive connection metadata. When a Source device is first recognized through an alias, the alias is
  the device's default name; a device that already exists or was renamed manually is not overwritten by later
  handshakes.
- If an SSH remote workspace in the left task list and the chat-area header carries an alias, the workspace
  title shows `<workspaceName> [SSH: <alias>]`, e.g. `root [SSH: linux-arm64]`; without an alias or with a
  historical record lacking one, the original workspace name/host helper info is kept.
- Web in non-remote-control scenarios returns an empty list, staying compatible.

## Implementation Notes

- The parsing capability sinks to `packages/services/src/system/sshConfigAlias.ts`; the desktop main only
  forwards the platform channel.
- Supports `Include` expansion and single-alias filtering (excluding `*`/wildcards/negated patterns/multi-pattern
  Host lines).
- Prefers `ssh -G` for the final config, with protection: single alias timeout (1.5s), concurrency cap (3),
  alias count cap (200), cache TTL (30s), failure isolation and fallback to local parsing results.
- `SSHConnectOptions` / `SSHRemoteTargetSnapshot` store an optional `sshConfigAlias` field; it takes no part in
  workspace identity computation, so a user renaming the alias or an alias change on the same target does not
  wrongly split one remote workspace. The Source device default name reads the alias only when the first
  handshake creates the record; the alias still takes no part in device identity, Profile de-duplication or
  workspace identity.
- Disconnect recovery, reconnect-failure records and tab persistence keep using
  `workspaceIdentity?.trim() || workspacePath` as the isolation key; the alias is only for UI display.
- Compatible with macOS / Linux / Windows: the config entry always resolves `~/.ssh/config` from
  `os.homedir()`; Windows additionally probes common OpenSSH/Git `ssh.exe` paths; with no `ssh` executable it
  falls back to local parsing automatically.
