# Superpowers ZCode P0 Compatibility Spec

ZCode supports built-in plugins, Claude/Codex manifest discovery, plugin hooks, the Skill tool, and the Agent subagent tool, but Superpowers had two P0 gaps: (1) Superpowers docs and tests call skills as `superpowers:<skill>` while the ZCode agent runtime only exact-matched bare `skill.name`, so names like `superpowers:test-driven-development` failed to load; (2) the Superpowers `SessionStart` bootstrap injects `using-superpowers`, whose Claude Code ecosystem docs reference `Task` and other Claude Code tool names — ZCode cannot fix that by appending translation text to hooks. Goal: without touching users' external Claude plugin caches, both the built-in Superpowers and the full `.claude-plugin` form must reach: skills loadable as `superpowers:*` once enabled, bootstrap working, and `Task` subagent dispatch mentioned in Claude Code plugin docs executable directly on the ZCode tool surface.

## Skill alias rules

For a skill root with `source: "plugin"`, the ZCode agent runtime derives the plugin name from the plugin root manifest and generates an optional fully qualified alias per skill:

```text
<plugin manifest name>:<skill frontmatter name>
```

Example, `skills/test-driven-development/SKILL.md` in the Superpowers plugin: bare name stays `test-driven-development` (compatibility); qualified name `superpowers:test-driven-development` is the recommended invocation name exposed to the model.

Manifest search order (compatible with plugin discovery): `.zcode-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json` — searched upward from the skill root with a bounded walk, covering standard `plugin/skills/<skill>/SKILL.md` and custom skills subdirectories. An unreadable manifest or missing valid `name` does not block skill loading; it only skips alias generation.

Skill loading must accept both bare and qualified names. Skill context listings prefer the qualified name and note that the bare name still loads, so the model never calls a mixed/missing name after reading Superpowers docs.

## Subagent skill filtering

Custom subagent profiles declaring a `skills` whitelist must match both bare and qualified names; otherwise a profile listing `superpowers:*` loads in the parent runtime but is rejected by the child's whitelist.

## Claude Code tool compatibility

Users must not have to rewrite external Claude plugin skill docs or `hooks/session-start`. The compatibility layer lives in tool registration and hook matchers:

- `Task` is registered as a Claude Code-compatible tool name delegating to ZCode's existing `Agent` subagent handler — same input/output schema, permission capabilities, result budget, and background-task recovery semantics.
- With no subagent port configured, neither `Agent` nor `Task` is exposed; when the child agent runtime forbids recursive subagents, both are filtered.
- Tool hook stdin keeps the actual tool name (no fake names in traces); hook matchers additionally accept compatible aliases — an `Agent` call matches a `Task` matcher and vice versa.
- If `ApplyPatch` is re-enabled, its hook matcher may accept Claude Code-style `Write`/`Edit` matchers without changing the actual toolName.

The Superpowers `SessionStart` hook output only injects its own `using-superpowers` context; ZCode no longer appends Superpowers-specific tool-mapping text. Other `.claude-plugin` plugins reuse the same layer. Full subagent compatibility boundaries: `docs/subagent-compatibility.md`.

## SessionStart bootstrap verification

With Superpowers enabled, the `SessionStart` hook on `startup|clear|compact` matches must: run the plugin hook via `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT`; parse `hookSpecificOutput.additionalContext`, top-level `additionalContext`, or Cursor-style `additional_context`; and inject `using-superpowers` into the current turn's `hook_context` system reminder. `resume` is not in Superpowers' default matcher unless a future plugin manifest declares it.

## Verification requirements

- Plugin skill roots derive `superpowers:*` aliases from `.claude-plugin/plugin.json`; `Skill(skill="superpowers:test-driven-development")` loads; skills context shows `superpowers:*`; subagent whitelists accept qualified aliases.
- `Task` dispatches ZCode subagents; `Task`/`Agent` hook matcher aliases interoperate while hook input keeps the actual toolName; Superpowers SessionStart context carries no Superpowers-specific ZCode tool mapping.
