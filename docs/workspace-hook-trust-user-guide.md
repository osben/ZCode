# Workspace Hook Trust user guide

Workspace/project Hooks come from repository config and can run local commands, so they are untrusted
by default. Opening a workspace, enabling the general Hooks master switch or confirming a deep link
never grants trust automatically.

## Trusting in Settings

When a natural event hits an untrusted Hook, the conversation continues as usual and the Hook stays
fail closed. The chat area shows that Workspace Hooks await review; clicking it opens
`设置 → 钩子 → 工作区` (Settings -> Hooks -> Workspace).

An untrusted row shows a "信任" (Trust) button only, immediately left of the row's config switch:

```text
Hook name and command                                 [信任] [switch]
```

- Clicking "信任" creates the persistent Trust for the current `workspaceIdentity + hookDeclarationDigest`; the button disappears on success.
- The config switch only controls whether the Hook is enabled; it never creates or revokes Trust.
- The page has no one-time grant, bulk trust or inline revoke.
- Closing Settings, a timeout or a disconnect all mean "no decision" and do not change Trust.

Trust affects only later natural events. A SessionStart already skipped because of missing trust is
not re-run on the next message of the current task; the earliest it runs is the SessionStart of the
next real new task/session.

When the declared command, matcher or other semantics change, the digest changes: the new declaration
returns to untrusted and shows the button again, while unchanged declarations keep hitting the
original Trust.

`Allow once` in ordinary tool-execution permissions is a different permission system and is not part
of Workspace Hook Trust.

## Safety and recovery

- Managed `deny` always wins over user Trust.
- When the rollout gate is off, all project Hooks are hard-blocked; existing records are kept but not read.
- Stale task/run/remoteSession/generation/snapshot responses are rejected before writing the Trust store.
- Desktop continuous and mobile replayable use the same Runtime-authoritative review binding; reconnecting cannot widen authorization.

To revoke an existing record, use a trusted management/CLI entry by exact digest; the config switch
carries no revoke semantics.

### Corrupt Trust store (`workspace_hooks_trust_store_corrupt`)

The persistent Trust store (`~/.zcode/security/workspace-hook-trust-v1.json`, redirectable via the
user config `storage.dir`) is parsed with a full strict schema. JSON syntax errors, a missing
`schemaVersion`, records missing required fields (`decision` / `grantedAt` / `digestAlgorithm`,
etc.), invalid timestamps and unknown fields are all judged corrupt and fail closed. Every consumer
(Settings UI, Runtime admission, CLI) reaches the same verdict on the same file; under corrupt no
`trusted_persistent` is shown and all Hooks are skipped by the untrusted soft gate.

`zcode hooks trust status` reports a corrupt store explicitly as
`reasonCode: workspace_hooks_trust_store_corrupt` (not `pending_trust`), and `grant` / `revoke` are
rejected until it is repaired. On first read the corrupt file is renamed to
`workspace-hook-trust-v1.json.corrupt-<timestamp>`. To recover, restore the file from a backup, or
once the leftovers are confirmed disposable, delete the `*.corrupt-*` files to rebuild an empty
store, then run grant again.

## Manual acceptance

The repository provides a harmless fixture:

```bash
node scripts/create-workspace-hook-trust-uat-fixture.mjs
```

Full steps and expected results:
[`workspace-hook-trust-manual-acceptance.md`](./testing/workspace-hook-trust-manual-acceptance.md).
