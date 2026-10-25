# Skill Integration Plan

## Document Scope

Implementation-level plan for integrating skills into ZCode v2. It follows the v2 architecture
principles:

- Spec first, then contracts and implementation.
- Core never reads files, scans directories, accesses the network or reads environment variables.
- Like MCP, plugins and subagents, skills enter the agent runtime only through capability, schema,
  permission and trace boundaries.
- Skills first serve on-demand loading of professional knowledge for NL -> Code. The first version has no
  remote marketplace, plugin installation or subagent orchestration.

## Design Points

Model entry and context:

- The entry is the `Skill` tool. At startup the model sees only the list of available skills, not full
  bodies; it must call the tool to get the full instructions.
- The skill list has a budget, and each description is hard-truncated; over budget, descriptions are
  truncated, the list degrades, or a warning is emitted.
- `Skill` input is a skill name and optional args; output is the full content and the base directory, so
  the model can read references/scripts on demand.
- Loaded skills are recorded so that skill content can be restored after compaction.

Capability domain and permissions:

- Skills are an independent capability domain with explicit models: `SkillMetadata`, `SkillLoadOutcome`,
  `SkillRoot`, `SkillPolicy`, `SkillDependencies`.
- Roots have a scope (repo, user, system, admin); config rules can enable/disable by name or path.
- Discovery paths cover native and compatible directories; project-local discovery scans from the
  current directory up to the worktree root.
- Frontmatter may carry runtime-affecting items: `allowed-tools`, `model`, `effort`,
  `disable-model-invocation`, `when_to_use`.
- Permission does not only ask whether reading `SKILL.md` is safe; it asks whether the skill changes the
  tool allowlist, model, hooks or fork execution. Only simple skills with safe attributes are
  auto-allowed; everything else goes through permission. Rules can express allow/deny/ask by skill name
  pattern.
- The loader uses a filesystem abstraction; local I/O is not exposed to core.

Not in the first version:

- Skills and slash commands are not merged; only `SKILL.md` instruction packs.
- Forked skills (`context: fork`) depend on a mature subagent runtime; only the schema is reserved.
- Remote / URL skill discovery needs network, cache, signing/verification and audit; not in phase one.
- Large bodies are not retained long-term; prefer a metadata snapshot plus on-demand body reads.
- Product gating, env dependency prompts and root alias rendering are Phase 2+; the first version keeps
  only fields and diagnostics, without full dependency completion.

## ZCode Design Choices

### Current implementation status

The skill P0 mainline has landed (last checked 2026-05-08). The rest of this document is the contract baseline.

Landed:

- Contracts: `packages/contracts/src/skills/index.ts` defines `SkillRoot`, `SkillScope`,
  `SkillMetadata`, `SkillDiagnostic`, `SkillContent`, `SkillLoadOutcome`, `SkillPort`, `SkillConfig`;
  `packages/contracts/src/tools/skill.ts` provides the `Skill` tool runtime schema and provider JSON
  schema.
- Adapter loader: `packages/adapters/src/skills/index.ts` discovers, through the Node adapter,
  `.zcode/skills`, `.agents/skills`, `.claude/skills` from cwd up to the worktree root and the matching
  user roots; supports config extra roots, flat YAML frontmatter, unknown-field diagnostics, same-name
  priority dedup, on-demand body reads and 100KB truncation.
- Core runtime: `packages/core/src/context/sections/skills.ts` renders skill metadata as a `meta_user`
  section (no body in the system prompt); `packages/core/src/tool/handlers/skill.ts` loads the body
  through `SkillPort` and declares read-only, session side effect, runtime input/output schema, result
  budget, timeout, cancellation and trace propagation.
- Bootstrap / CLI / ZCode app-server: `packages/bootstrap/src/index.ts` injects `SkillPort` by feature
  gate and `skills.*` config; `listZCodeSkills()` reuses the same adapter; `zcode skills` /
  `zcode skills list` support human, `--json` and `--verbose` diagnostics; bare `/skill` in
  TUI/command-center is a read-only listing and `/skill <name> [task]` is rewritten into a prompt that
  must call the `Skill` tool first; ZCode app-server exposes `/skill <skill-name> [task]`, and bare
  `/skill` there returns usage without starting a model turn.
- Tests: `packages/adapters/tests/skills.test.ts` (discovery, body load, duplicate-name priority);
  `packages/core/tests/skill-tool.test.ts` and `packages/core/tests/context-builder.test.ts` (metadata
  injection, `Skill` tool); `packages/cli/tests/cli.unit.test.ts` (CLI/TUI `/skill`);
  `packages/bootstrap/tests/zcode-protocol.test.ts` (ZCode app-server command exposure, disabling,
  prompt rewrite).

Not yet landed (remaining scope):

- A TUI/debug projection page for skill diagnostics, and explicit `$skill-name` / `skill://...`
  mentions.
- Allow/deny/ask rules by concrete skill name or wildcard. The `Skill` tool's permission declaration is
  still a tool-level low-risk auto-allow; it does not escalate to ask for unsafe frontmatter,
  remote/plugin sources or runtime-modifier fields.
- Skill lifecycle events (`SkillRootsResolved` / `SkillLoaded`, ...), a loaded-skill session snapshot,
  restoring the full skill body after compact, and a structured observability surface for diagnostics.
- bundled/system/plugin/admin/remote roots, dependency/env prompts, `context: fork`, `model` / `effort`
  runtime modifiers, `allowed-tools` scoped suggestions (P1/P2).

### Core principle

ZCode skills use two-layer loading:

1. **metadata discovery**: at startup/turn init, scan skill roots and put only lightweight information
   (name, description, source, scope, path, policy) into context.
2. **content load**: only after the model explicitly calls the `Skill` tool is the matching `SKILL.md`
   body read and injected into the session.

This gives token control, permission visibility, trace and a single cross-platform I/O boundary.

### Layer boundaries

`contracts` adds the skill contract: `SkillRoot`, `SkillScope`, `SkillMetadata`, `SkillPolicy`,
`SkillLoadOutcome`, `SkillDiagnostic`, `SkillContent`, `SkillPort`, `SkillConfig`.

`adapters` implements the Node skill loader: scan directories, parse YAML frontmatter, read bodies,
handle symlinks, permission errors, path normalization, case differences and max bytes, and return
structured diagnostics.

`core` adds a skill registry / manager: holds the session's skill metadata snapshot, lets the context
builder render the available-skills section, registers the `Skill` tool contract. The `Skill` tool loads
bodies only through `SkillPort`, never by reading files.

`bootstrap` assembles: generates skill roots from config, injects `SkillPort` into the runtime/tool
executor, and passes the skill feature gate, permission config and context budget to core.

## File Format

P0 requires only that each skill directory contains `SKILL.md`:

```text
my-skill/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` must have YAML frontmatter:

```markdown
---
name: my-skill
description: When this skill should be used
---

# My Skill

Workflow instructions.
```

P0 frontmatter:

- `name`: required. Recommended `^[a-z0-9]+(-[a-z0-9]+)*$`, length 1-64.
- `description`: required, length 1-1024.
- `when_to_use`: optional, appended to the description budget.
- `license`: optional, metadata only.
- `metadata`: optional string map.

Reserved for P1/P2: `allowed-tools`, `model`, `effort`, `context: inline | fork`,
`disable-model-invocation`, `policy.allow_implicit_invocation`, `dependencies.tools`, `interface`.

P0 does not error on unknown fields but records them in diagnostics, so future fields are not silently
misused.

## Discovery Roots

P0 default roots:

1. configured extra roots: `skills.roots[]`, in config order.
2. project native: `<dir>/.zcode/skills/*/SKILL.md` from cwd up to the worktree root.
3. project agent-compatible: `<dir>/.agents/skills/*/SKILL.md`, same walk.
4. project Claude-compatible: `<dir>/.claude/skills/*/SKILL.md`, same walk.
5. user native: `~/.zcode/skills/*/SKILL.md`
6. user agent-compatible: `~/.agents/skills/*/SKILL.md`
7. user Claude-compatible: `~/.claude/skills/*/SKILL.md`

Project discovery is nearest-first: check the working directory's native / agent-compatible /
Claude-compatible roots, then the parent, up to the worktree root (the directory containing a `.git`
marker). If no worktree root is found, only the passed working directory's project roots are used, to
avoid scanning the user directory or filesystem root by accident.

Additional implemented roots:

- **bundled skill pack** (`bootstrap/src/app/bundled-skills.ts`): the skill pack shipped with the CLI at
  `apps/zcode-cli/packages/bundled-skills/skills/`, discovered as `source: "bundled"`,
  `scope: "system"`, injected into the runtime, `zcode skills list` and the protocol skill catalog
  alongside plugin roots. It is not a plugin: not in the marketplace catalog, no enable/disable switch,
  cannot be uninstalled, and does not appear in Settings or the `$` reference panel
  (`skills/referenceCatalog` filters `bundled`). Dev/desktop/ZCode Server distributions read it in place
  next to the entry, using the same candidate directories as the official plugin (the Server
  distribution stages it at `runtime/packages/bundled-skills`); the SEA build extracts it once by
  content hash to `~/.zcode/cli/bundled-skills/<hash>/`. Every file in the pack is a required asset;
  one missing file rejects the whole pack with a warning. The first member is `dynamic-workflows`
  (`docs/dynamic-workflow/authoring.md`).
- plugin-provided skill roots.

Plugin-provided skill roots are defined by [`plugin-compat.md`](plugin-compat.md). They use the same
`SKILL.md` format and enter discovery as `source: "plugin"` roots. Plugin loading does not inline skill
bodies; the `Skill` tool remains the only P0 path for loading full plugin skill content into the model
context.

P2 adds remote URL discovery/cache and admin/managed policy roots.

**Priority** (highest first):

1. session override / configured extra roots
2. nearest project native
3. nearest project compatible
4. ancestor project native / compatible, nearest directory first
5. user native
6. user compatible
7. bundled/system
8. admin/managed

On a same-name collision the higher-priority entry wins and duplicates go to diagnostics. If a plugin
namespace is introduced later, `plugin:skill-name` can be supported.

## Context Injection

ContextBuilder adds a `Skills` section after the user/project context. Tool descriptions are not a
ContextBuilder section; they come with the model request's `tools` array.

The section contains metadata only, no bodies. Initial format:

```text
## Skills

A skill is a set of local instructions stored in SKILL.md. Use the Skill tool to load full instructions only when relevant.

### Available Skills
- my-skill: When this skill should be used (file: /abs/path/to/SKILL.md)

### How To Use Skills
- If the task matches a skill description, call Skill with the skill name before doing the task.
- If the user types `/<skill-name>`, call Skill only when that exact skill appears in the available skills list. Do not guess missing skill names.
- After loading a skill, read only the referenced files you need.
- Resolve relative references from the skill base directory.
```

Budget policy:

- P0: default 1% of the context window, or an 8k chars fallback.
- A single description is at most 250 chars.
- Over budget: truncate descriptions first, then degrade to names-only, and record a diagnostic/log.
- P1: root aliases (short aliases instead of absolute skill root paths) to cut long-path cost.

## `Skill` Tool

Named `Skill`, matching the `Read` / `Write` / `Edit` / `Bash` style.

Input:

```json
{
  "name": "my-skill",
  "args": "optional user/model supplied arguments"
}
```

P0 output:

```text
<skill_content name="my-skill">
# Skill: my-skill

...SKILL.md body...

Base directory for this skill: /abs/path/to/my-skill
Relative paths in this skill are relative to this base directory.
</skill_content>
```

Tool metadata:

- `readOnly: true`
- `destructive: false`
- `concurrentSafe: true`
- `sideEffectScope: "session"`, because it changes the current session context.
- `riskLevel: "low"` for safe inline skills.
- `maxOutputBytes` default 100k.
- `timeoutMs` default 30s.

Permission policy:

- P0 implements inline load only.
- A safe skill is auto-allowed: only P0 safe frontmatter fields, and source is project/user/native/
  compatible.
- `allowed-tools`, `model`, `effort`, `context: fork`, `hooks`, `dependencies`, or a remote/plugin
  source default to ask.
- An explicitly denied skill does not appear in available skills and cannot be loaded through the tool.
- Permission rules should support `Skill(my-skill)` and wildcards such as `Skill(internal-*)`.

P1 behavior:

- `allowed-tools` does not bypass permission directly; it is only a permission suggestion or scoped
  allow rule.
- `model` / `effort` take effect through a runtime context modifier and record an event.
- `context: fork` waits until the subagent runtime is stable.

## Manual Command

P0 adds a slash command:

```text
/skill [<skill-name> [task...]]
```

Semantics:

- Bare `/skill` is read-only discovery listing the skills discoverable from the working directory. It
  creates no app/session, loads no model, submits no prompt and does not call the `Skill` tool.
- `<skill-name>` matches the `SKILL.md` frontmatter `name`.
- `[task...]` is optional. With it: "use this skill for this task"; without it: "load the skill first and
  answer the current turn based on its instructions".
- A command with `<skill-name>` does not read skill files directly and does not bypass the `Skill` tool,
  permission, trace or session persistence.
- command-center only rewrites the user input into an explicit model instruction: call the `Skill` tool
  to load `<skill-name>`, then continue the original task.
- `--prompt "/skill"` and TUI `/skill` both return the skill list; `--prompt "/skill <name> ..."` and TUI
  `/skill <name> ...` both rewrite into an explicit `Skill` tool call requirement.

P1 may add `$skill-name` explicit mention; P0 uses the slash command to avoid confusion with ordinary
natural language.

## CLI Discovery Commands

Implemented read-only CLI commands:

```text
zcode skills list
zcode skills inspect <name>
```

`skills list`:

- Local skill discovery only: no session, no model, no prompt, no `Skill` tool call.
- Discovery reuses the `SkillPort`/Node skill adapter contract injected by bootstrap; the CLI only parses
  subcommands, formats output and sets exit codes, and never walks skill directories itself.
- `zcode skills` without a subcommand equals `zcode skills list`.
- Normal output shows skill name, scope/source, description and path, so users can copy `<skill-name>`
  into `/skill <name>`.
- `--json` outputs `{ skills, diagnostics, totalDiscovered, cwd }`; `skills` keeps name, description,
  whenToUse, scope, source, path, directory, rootPath.
- `--verbose` appends discovery diagnostics after normal output; normal output prints no warnings so
  recoverable diagnostics do not flood regular use.

`skills inspect <name>`:

- Local discovery plus a single skill body read; no session, no model, no prompt, no `Skill` tool call.
- Reuses the injected `SkillPort`/Node skill adapter contract; the CLI never reads `SKILL.md` directly.
- Normal output shows name, scope/source, path, directory, description, whenToUse, safe-to-auto-load,
  size/truncation and the body without frontmatter.
- `--json` outputs `{ cwd, skill, diagnostics }`; `skill` keeps metadata, baseDirectory, content,
  bytesRead, sizeBytes and truncated.
- `--verbose` appends discovery diagnostics; normal output prints no warnings.

An unknown `skills` subcommand or wrong argument count returns non-zero and prints
`Usage: zcode skills [list|inspect <name>]`.

Error behavior:

- A discovery adapter error bubbles to the CLI boundary, which prints `Error: <message>`; `--verbose` may
  append the stack.
- `skills inspect <name>` with an unknown skill returns non-zero with the stable error
  `Skill not found: <name>`; if the skill feature is disabled by config it returns non-zero with
  `Skills are disabled.`.
- Frontmatter/read diagnostics of a single skill do not fail the command; they are returned as
  diagnostics.
- No skills found returns 0 and prints `No skills found.`; in JSON `skills` is an empty array.

## Config

Candidate `RuntimeConfig` fields:

```text
features.skill
skills.enabled
skills.includeInstructions
skills.metadataBudget
skills.roots
skills.compatibility.claude
skills.compatibility.agents
skills.rules
```

Skill config declares no environment variable entry. Changing the skill switch, compatible directories or
metadata budget goes through the config file, CLI/session override or a higher-level runtime config
contract.

A new `ZCODE_` environment variable needs a spec first, stating purpose, priority, error behavior and
test coverage, so temporary implementation details do not become a long-lived config surface.

Config merging keeps the system/user/project/session/env/cli priority; core does not read environment
variables.

## Events and Observability

New or reused event semantics: `SkillRootsResolved`, `SkillDiscovered`, `SkillDiscoveryWarning`,
`SkillLoadRequested`, `SkillLoaded`, `SkillLoadFailed`.

Every event carries traceId/sessionId/turnId. Logs do not record the full skill body by default, only
name, scope, source, path hash, size, truncated, durationMs.

Context diagnostics expose: total skill count, included count, omitted count, truncated description
count, duplicate names, parse/read errors, disabled skills.

## Security and Cross-Platform Constraints

- All path handling uses the `path` / `url` / `fs` adapters; no hand-written separators.
- `SkillPort` accepts only adapter-normalized absolute paths or stable skill ids.
- The `Skill` tool must not read files outside the skill directory.
- references/scripts are never auto-executed. Running a script must explicitly go through
  `Bash`/`ExecutionPort` and permission.
- Symlinks need canonical-identity dedup; the displayed path may stay user-readable.
- On Windows handle case, backslashes, path length and permission errors.
- A body over `maxOutputBytes` returns a truncated summary plus a diagnostic; artifact/storage comes
  later.

## Phased Plan

Status of each phase is as in "Current implementation status" above.

### Phase 0: Spec and test skeleton (completed)

Acceptance: this document covers the design points and trade-offs; later tasks can be split by contract.

### Phase 1: Contracts (completed for P0)

Skill schema/type in `packages/contracts/src/skills`, a minimal skills config in `RuntimeConfig`, skill
diagnostics/error codes. Finer policy / dependency fields stay as later extensions.

Acceptance: `contracts` types are importable alone by core/adapters/bootstrap; the schema covers invalid
frontmatter, duplicate, disabled, too large.

### Phase 2: Adapter loader (completed for P0)

Node loader in `packages/adapters/src/skills` with P0 roots and frontmatter, max bytes, canonical path,
diagnostics, pre-cancel checks. Not implemented: symlink canonical dedup, remote/cache, plugin roots.

Acceptance: adapter unit tests cover project/user/compat roots, duplicate name, no permission, symlink,
invalid YAML; no core dependency.

### Phase 3: Core context and registry (completed for P0)

`SkillRegistry` / `SkillManager` in core, ContextBuilder renders the Skills section as an independent
`meta_user` section, context diagnostics record budget and truncation; the registry omits the `Skill` tool when
there is no `SkillPort`. Not implemented: session-level loaded-skill snapshot and compact restore.

Acceptance: a fake skill snapshot renders into the system prompt; over budget does not drop all skill names;
core still imports no Node I/O.

### Phase 4: `Skill` tool (completed for P0 inline load)

The handler reads the body through `SkillPort` and returns `<skill_content>`, declaring output schema, result
budget, timeout, cancellation and trace propagation. Not implemented: dynamic approval by skill name/policy,
unsafe-frontmatter ask, runtime modifiers, fork context.

Acceptance: after a fake model calls `Skill`, the next model turn sees the body; under a deny rule the skill
is absent from available skills and a direct call fails; unsafe frontmatter goes to ask and a safe inline
skill is auto-allowed.

### Phase 5: CLI/TUI (partially completed)

Implemented: `zcode skills list` and `zcode skills inspect <name>` (read-only, no model/session), `--json`,
`--verbose`, TUI/command-center `/skill` list and `/skill <name> [task]` rewrite, ZCode app-server
`/skill <name> [task]`. Not implemented: TUI/debug diagnostics projection.

Acceptance: CLI output supports `--json`; errors carry a traceId or diagnostic code.

### Phase 6: Advanced

Root alias rendering; explicit mention `$skill-name` and `skill://.../SKILL.md`; bundled/system skills; plugin
skill roots; skill dependency/env prompt; forked skill; remote URL discovery/cache.

## Out of Scope for P0

- Remote skill download.
- Executing skill scripts.
- Automatically modifying the tool allowlist.
- Forked skills.
- Merging skills with slash commands.
