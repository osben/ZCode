# Managed worktree trust identity on zcode-rs

Status: implemented (PR 642).

## Background

A Desktop task can run in a managed worktree, a checkout the Host creates under
`<dataBaseDir>/.zcode/worktrees/<bucket>/<name>`. Node keys workspace hook trust and workspace plugin trust for such a
checkout by its source repository (D23 in `docs/specs/workspace-hook-trust.md`). A hook or plugin trusted in the
source repository is trusted in its worktrees too, as long as the declaration digest is the same, and a grant made in
the worktree is written under the source repository.

Before this change Rust keyed both stores by the session's root. In a worktree task every project hook and project
plugin waited for trust again, and a grant made there was written under the worktree path, so the source repository
and its other worktrees did not see it. The E2E `conversation-session-hook-trust-worktree` (HK20) checks that the
source and worktree records share one identity.

## Node reference

`resolveWorkspaceHookTrustIdentity` (`packages/shared/src/managed-worktree/trust-identity.ts`) and
`parseManagedWorktreePath` (`layout.ts`). Callers: `create-app.ts` (hook snapshot), `workspace-plugin-trust/index.ts`
(plugin records), `workspace-hook-trust-cli.ts` (`zcode hooks trust`), the hook review controller.

Node's MCP trust does not use it: `createWorkspaceMcpTrust` keys by `workspaceIdentity || workingDirectory`, and the
MCP digest contains the working directory. Rust MCP trust stays as it is.

## Rules

1. Only a local workspace is mapped. A remote workspace keeps its own key.
2. `dataBaseDir` is `ZCODE_DATA_BASE_DIR` when set and not blank, else the home directory, the same value that moves
   the config root. The managed root is `<dataBaseDir>/.zcode/worktrees`.
3. The root path maps to `<sourceRoot>/<rest>` when every check passes, after `realpath` of the managed root and of
   the root path:
   - the real path is `<managedRoot>/<bucket>/<name>[/<rest>]`, where `bucket` is 4 lowercase hex characters;
   - `<worktreeRoot>/.git` is a regular file whose first line is `gitdir: <admin>`, relative to the worktree root;
   - the real admin dir's parent is a directory named `worktrees`; its parent is `common`;
   - `<admin>/gitdir`, relative to the admin dir, resolves (realpath) to the real `.git` file of the worktree;
   - `<admin>/commondir`, relative to the admin dir, resolves (realpath) to `common`;
   - `<dirname(common)>/.git` is a directory whose realpath is `common` (not bare, not nested).
4. Any failed check or IO error leaves the root path unchanged. The mapping never grants more than the source has.
5. The mapped value is only the trust store key. The plugin root key (`pluginRoot`) and the plugin files are still
   computed from the session's root, and the hooks engine keeps its workspace key. Both digests are built from paths
   relative to the root, so the same declaration hashes the same in the source and in the worktree.
6. One resolver (`cli/src/config/trust_identity.rs`) serves the hook trust (`WorkspaceHooks::inspect`: the session
   loader, the process assembly, the App hook review and its grants, `zcode hooks trust`) and the plugin trust
   (`plugin_dirs`).
7. A session's trust banners (`workspaceHookAdmission`, `workspaceMcpAdmission`) and its hook review read the
   session's cwd: the execution worktree it runs in, else the root it was opened on (Node builds them in the session
   runtime, whose working directory is the cwd). The listed workspace, which a worktree session shares with its
   project, is not used. The refresh after an input reads the cwd after any worktree activation queued before it, so
   the first input of a new worktree task already reads the worktree. A grant or revoke for a workspace refreshes the
   open sessions whose cwd or listed workspace is that path, each with a read of its own cwd.

```text
session root (worktree path) ──► trust_identity::resolve ──► source path (or the root itself)
        │                                                     │
        ├─ hook digests (relative paths)  ─────────────┐      ├─ hook trust store key
        └─ plugin roots and digests (relative paths) ──┴──────┴─ plugin trust store key
```

## Acceptance

- Rust unit tests on a hand-built layout: a worktree root and a subdirectory map to the source; a symlinked managed
  root maps; each failed check (wrong bucket, `.git` a directory, no admin `worktrees` parent, a backlink to another
  checkout, a wrong `commondir`, a bare common dir) leaves the path; a path outside the managed root is unchanged.
- A plugin trusted under the source path loads in the worktree. A hook trusted under the source path is admitted in
  the worktree, and a hook grant made in the worktree is written under the source path.
- Node's `resolveWorkspaceHookTrustIdentity` gives the same answers on the same layout (checked once with tsx: root,
  subdirectory, relative CRLF pointers, wrong `commondir`, uppercase bucket, bare common dir).
- HK20 (`conversation-session/hooks/conversation-session-hook-trust-worktree`) passes on Node and on Rust in the box,
  with D24 ported (`specs/fork-rust-hook-script-entry.md`) and the banners read at the session cwd (rule 7). HK05,
  HK06, HK07, HK18 and HK19 pass on Rust too.
- A protocol test opens a worktree task, queues its worktree and checks the banner refresh reads the worktree path, and
  that a grant for the worktree or for the source project refreshes that session.

## Known differences

- Node re-resolves identities in a running process (`zcode-protocol/server.ts`), so a source grant reaches a worktree
  session that is already open. Rust reads the trust stores when a session opens and when a hook review writes, so a
  grant made elsewhere is picked up by the next session.
