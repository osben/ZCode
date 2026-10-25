# Multi-Workspace / `--add-dir` Design Draft v2

> Historical draft: the 2026-09 virtual project refactor did not adopt this multi-workspace model. The
> current approach is that the Host resolves project roots and passes only a directory list over the
> protocol (`additionalDirectories`); the CLI is unaware of projects, and additional directories are
> consumed only by skills / commands / subagents and the writable scope. See section 4.3 of
> `docs/superpowers/specs/2026-09-09-virtual-project-design.md`. The text below is a historical record.

## Goals

Make multi-workspace first-class state, so one session faces one primary workspace and several
additional workspaces. The goal is not "allow access to more paths" (core path policy does not block
paths outside the workspace anyway) but:

- A clear session/runtime/permission/context contract.
- A stable CLI/TUI/ZCode app-server entry.
- A persistable, recoverable, auditable workspace scope that sandbox, resume, skills, AGENTS.md and MCP
  can plug into later, instead of scattering semantics in `cwd` special cases.

## Semantic choice

`--add-dir` can mean:

- Narrow: "additional writable roots". Directories are resolved against `cwd` and merged into the writable
  roots of the sandbox / permission profile; if the effective permission cannot extend writable roots it
  errors or warns. Few intrusion points, but no instruction, skills, plugin or session grouping for the
  extra directories.
- Wide: "add the directory to the current workspace scope". It enters the tool permission context and
  sandbox allowWrite and takes part in loading instructions, rules, skills and plugin settings;
  `/add-dir` distinguishes session-only from persisted-to-local-settings. Complete, but deeply coupled to
  trust / permission / sandbox / context.

Recommendation: design the state model for wide semantics (explicit workspace roots in session/runtime
state) but roll out from the narrow end (CLI, runtime, session, permission, context contracts first;
then skills, AGENTS.md, sandbox, resume). Reasons: ZCode has only a single `workingDirectory` as first
class; `workspaceRoot` is a single-valued alias in the tool context; permission rules record only
`allow/deny/ask`; path policy and tests allow paths outside the workspace, so a bare `--add-dir` without
state modeling would mislead users into seeing a permission boundary. The first step is `WorkspaceScope`,
not a flag.

## Target semantics

- A session has one `primaryRoot` and zero to many `additionalRoots`.
- A session has one current `workingDirectory`, which must lie inside some root. The active cwd stays
  single-valued; multi-workspace is not "multiple active cwds".
- File tools, grep/glob, bash `cwd`, skills, instructions and resume policy all read the same
  `WorkspaceScope`.

## Non-goals (phase 1)

- Automatic discovery of sibling repos; several active cwds like an IDE; pouring the full git state of
  extra directories into the prompt; a full workspace-level trust UI; hard filesystem deny based on
  roots unless the execution/fs adapter is wired in too.

## Data model

```ts
type WorkspaceRootRole = "primary" | "additional";

interface WorkspaceRoot {
  path: string; // canonical absolute path
  role: WorkspaceRootRole;
  label?: string; // basename by default
}

interface WorkspaceScope {
  workspaceId: WorkspaceId;
  primaryRoot: string;
  additionalRoots: string[];
  allRoots: string[];
}
```

- `primaryRoot` is the stable semantic source of `allRoots[0]`; array order need not be externally
  visible.
- `allRoots` is canonicalized, deduped, and stripped of subdirectories contained in an existing root.
- `workingDirectory` lies inside some root.
- `workspaceId` is a stable hash of `primaryRoot + sorted(additionalRoots)`.

## Persistence

No SQLite schema change first. The session keeps writing `directory` and starts filling the existing
`session.workspace_id`. Roots metadata goes into `local_setting(scope, scope_id, namespace, key, value,
...)` with `scope = "workspace"`, `scope_id = workspaceId`, `namespace = "workspace"`, `key = "roots"`:

```json
{
  "version": 1,
  "primaryRoot": "/abs/project-a",
  "additionalRoots": ["/abs/project-b"]
}
```

This needs no new migration, gives `workspace_id` a real use, and later workspace title, recent roots and
trusted roots can use the same entry.

## Entries

- CLI: repeatable `--add-dir <path>`. Relative paths resolve against the primary working directory from
  `--cwd`. Startup builds a `WorkspaceScope` and injects it into the runtime. Invalid, duplicate or
  covered directories give a stable warning or error.
- TUI: not `/add-dir` first, but `/workspace`, `/workspace add <path>`, `/workspace remove <path>`,
  `/workspace list` (active root, display, resume and trust actions follow; `/add-dir` looks like a
  one-off allowlist). `/add-dir` can later alias `/workspace add`.
- ZCode app-server: session/new should later allow `cwd` and `additionalDirectories`; the first phase
  wires local CLI/TUI only and keeps the app-server single-workspace.

## Core / Contracts changes

1. Runtime config: add `WorkspaceRuntimeConfig { primaryRoot: string; additionalRoots: string[] }`;
   `workingDirectory` stays as the current active directory, not the sole workspace definition.
2. `ToolExecutionContext`: currently `workingDirectory` and `workspaceRoot`. Evolve to
   `workingDirectory`, `primaryWorkspaceRoot`, `workspaceRoots: string[]` and `workspaceRoot` (compat
   field, temporarily equal to `primaryWorkspaceRoot`), so tool handlers migrate in phases.
3. `ContextSourcePort`: `ContextSourceRequest` has only a single `workingDirectory`; add
   `workspaceRoots?: string[]` and `primaryRoot?: string`, and extend the context snapshot so
   instruction / project context resolve per root.
4. `ExecutionSandboxPolicy`: add `workspaceRoots?: string[]` and `writableRoots?: string[]`. Even if the
   Node adapter does not enforce in phase 1, complete the contract first.
5. Permission: do not stuff extra directories into `PermissionRuleset.allow/deny/ask`; add a separate
   workspace update contract so TUI approval and a future `/workspace add --remember` share one update
   chain:

```ts
type PermissionUpdate =
  | {
      type: "addRules";
      behavior: "allow" | "deny" | "ask";
      rules: PermissionRuleValue[];
    }
  | {
      type: "addWorkspaceRoots";
      roots: string[];
      destination: "session" | "workspace";
    }
  | {
      type: "removeWorkspaceRoots";
      roots: string[];
      destination: "session" | "workspace";
    };
```

## Context / AGENTS.md / Skills

- Phase 1: `EnvInfo` shows only the environment of the current `workingDirectory`; `AGENTS.md` /
  `CLAUDE.md` still prefer the upward chain from the active cwd; additional roots load only the top-level
  instruction file of each root as "additional workspace instructions" with a separate budget.
- Phase 2: skills discovery adds `.zcode/skills`, `.agents/skills`, `.claude/skills` of each additional
  root; project context may summarize per root but must not include each root's full package scripts /
  git status.
- Wiring all dynamic context in phase 1 would amplify prompt size, cache misses and recovery complexity,
  since the context builder, skills adapter, resume and permission are still single-workspace.

## Resume / session grouping

`--continue` and session list match `directory` exactly today. Phase 1: session persistence writes
`workspaceID`; `--continue` stays compatible with the primary directory. Phase 2: if the current cwd lies
in a workspace root, `/continue` and the session list look up by `workspaceID` or "cwd belongs to
workspace roots"; old sessions without `workspaceID` fall back to the directory logic.

## Warnings about the current implementation

1. `--add-dir` cannot claim a security boundary: core path policy and tests allow paths outside the
   workspace and Bash `cwd` may leave the root. Until the execution/fs adapter consumes `workspaceRoots`,
   it has workspace-membership semantics, not filesystem-enforcement semantics.
2. Separate project permission and workspace membership: project permission is "tool rules", not
   "workspace topology"; mixing them would leave resume, list and UI without clean workspace metadata.

## Phased rollout

- Phase 0, spec and contracts: this spec; `WorkspaceScope` / `WorkspaceRoot` contracts; incremental
  fields of `ExecutionSandboxPolicy`, `ToolExecutionContext`, `ContextSourceRequest`; persistence via
  `workspace_id + local_setting(scope=workspace)`.
- Phase 1, minimal usable: CLI `--add-dir`; bootstrap builds `WorkspaceScope`; runtime/tool
  executor/context source get `workspaceRoots`; session persistence writes `workspaceID` and roots
  metadata; TUI shows the current roots.
- Phase 2, workspace-aware context: budgeted AGENTS.md / CLAUDE.md of additional roots; skill discovery
  for additional roots; session list / continue grouping.
- Phase 3, permission and sandbox: PermissionUpdate add/remove workspace roots; `/workspace add/remove`
  with session-only and remember; execution/sandbox adapters consume `workspaceRoots` / `writableRoots`.
- Phase 4: ZCode app-server multi-workspace injection; workspace-level trust / remember policy; active
  root switching; workspace-level MCP / plugin / memory policy.

Recommended order: contracts, then bootstrap/runtime/session persistence, then CLI `--add-dir`, then
context / skills / TUI, strong-constraint sandbox last.

## Test checklist

Phase 1:

- CLI `--add-dir` is repeatable and paths normalize against `--cwd`.
- Subdirectories, duplicates and directories covered by a parent are deduped.
- runtime/tool context sees `workspaceRoots`.
- First session persistence writes `workspaceID` and reads back the roots metadata.
- An old session without `workspaceID` does not affect resume.
- The context source behaves exactly as today when no additional roots are passed.

Later: `/workspace add/remove/list`, skill roots overlay, AGENTS.md multi-root loading, execution sandbox
roots enforcement, restoring the same workspace session from an additional root cwd.
