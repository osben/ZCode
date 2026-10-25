# User Subagent Settings Management

> Historical implementation plan (2026-06-25), kept for the storage/state boundary rules. P0
> scope: manage global/user agents from Settings; GUI-written Markdown must be loaded and
> consumed by the real zcode-cli runtime.

## Scope Rules

- P0 manages user/global subagents only: view, create, edit, delete, enable, disable. No
  workspace/project agent creation or editing, no plugin agents, no structured MCP object
  editor, no Agent-tool carrier changes.
- Built-in agents `general-purpose` and `Explore` are read-only in P0 (no edit/delete).
- Workspace/project agents (if still needed for mentions) are read from the runtime path
  `<workspace>/.zcode/agents`; Settings P0 provides no editing entry for them.
- `packages/services` must not depend on `@zcode/core`; built-in summaries are duplicated as
  constants in the service. If duplication becomes a problem, move built-in metadata to a shared
  pure package — never import runtime core from services.
- UI must follow `DESIGN.md` (semantic tokens, existing primitives, compact settings layout,
  both themes, responsive) and add all copy to both `zh-CN.ts` and `en-US.ts`.

## Storage and Runtime Boundary

- The CLI runtime loads profiles in `apps/zcode-cli/packages/bootstrap/src/subagents.ts` from:
  - user root: `join(storageRoot, "agents")`;
  - project root: `join(workingDirectory, ".zcode", "agents")`.
- `storageRoot` defaults to `DefaultRuntimeConfig.storage.dir = "~/.zcode"`; the service reads
  `storage.dir` from `~/.zcode/cli/config.json` with fallback to `~/.zcode`. The user agent root
  is `${storage.dir}/agents` — not the legacy `~/.zcode/cli/agents`.
- The legacy `~/.zcode/cli/agents` root may be read (read-only, shadowed by the runtime root on
  name collision) but never written.
- Enabled/disabled state lives in `${storage.dir}/v2/agents-state.json` under
  `disabledAgentIds`, with stable ids `user:user:<name.trim().toLowerCase()>`. The runtime
  bootstrap reads the same state file and filters disabled user profiles before loading, so the
  GUI toggle affects the runtime, not just the Settings list or mention panel. Disabled built-in
  ids are reserved for future use; project-scope disabling is out of P0.
- Profile Markdown uses YAML frontmatter with the full runtime field set: `name`,
  `description`, `color`, `model`, `tools`, `disallowedTools`, `skills`, `permissionMode`,
  `maxTurns`, `background`, `mcpServers`, plus the body as `systemPrompt`. Parse failures return
  diagnostics (`agent_missing_frontmatter`, `agent_missing_required_frontmatter`,
  `agent_invalid_frontmatter`) instead of throwing, so Settings can show them without hiding
  valid agents.

## List Modes

`SubagentsListMode`:

- `allRuntimeScopes` — mention provider and runtime-aware surfaces: built-in + user + workspace
  (read-only) profiles.
- `settingsUserOnly` — Settings P0: built-in (read-only) + user (editable) only; workspace
  profiles intentionally hidden.

`createAgent` / `updateAgent` / `deleteAgent` operate on the user/global root only. The mention
provider must not be narrowed to `settingsUserOnly`. The store cache key is
`${workspaceIdentity?.trim() || workspacePath}::${provider}::${mode}`.

## Validation

```ts
const NAME_REGEX = /^[a-zA-Z0-9-]+$/;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 50;
```

- name: required, 3..50 chars, letters/numbers/hyphen only;
- description and systemPrompt: non-empty;
- model: `inherit` / `main` / `lite` when present;
- maxTurns: positive integer when present.

## Non-goals

- Does not change how the provider-visible agent list is carried: ZCode injects the agent list
  through `context_prefix`, not the Agent tool prompt.
- Does not implement nested YAML object editing for `mcpServers`; P0 preserves simple array
  values (raw text at most).
- Does not change the `Agent` / `Task` tool schema or SendMessage behavior.

## Acceptance

- Creating a user agent from Settings writes `${storage.dir}/agents/<name>.md` and is loadable by
  the runtime bootstrap (GUI serializer output and runtime loose parser agree).
- Disabling a user agent removes it from runtime profiles and from the provider-visible agent
  list of new sessions; enabling restores it.
- Settings list and runtime provider-visible body agree; built-ins visible but read-only; no
  workspace editing UI.
