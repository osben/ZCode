# Skill `agent_step` telemetry

## Goal

While keeping the existing `agent_step` counting, timing and tool-attribution definitions, identify which skill a
`Skill` tool call actually loaded and which plugin/source it came from.

This change adds no skill-description step and does not write SKILL.md bodies or descriptions into the
high-frequency `agent_step` event.

## Fields

Added on demand only in `agent_step.event_extra_detail` of existing `tool_name=Skill` steps:

| Field                  | Description                                                           | Source                                                                                |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `skill_name`           | Skill name of all Skill steps, regardless of plugin source            | Only the resolved `SkillContent.metadata.name`; `unknown` when unresolved or failing validation |
| `skill_qualified_name` | Normalized skill name, e.g. `document-skills:pptx`                    | `SkillContent.metadata.qualifiedName`                                                 |
| `skill_plugin_id`      | Full plugin id, e.g. `document-skills@zcode-plugins-official`         | `LoadedPlugin.id`                                                                     |
| `skill_source`         | Existing `SkillSource` enum value                                     | `SkillContent.metadata.source`                                                        |

`skill_name` is always filled in a `tool_name=Skill` step but accepts only the name of resolved metadata. The
`input.skill/name` of the scheduling or compatibility stream is not read; failure before loading, denial, stop and
legacy events lacking a resolved name are all `unknown`, with no fallback even if the request string looks like a
valid name.

A name is 1-64 ASCII letters, digits, underscores or hyphens starting with a letter or digit; it is not trimmed or
truncated. Path separators, colons, whitespace, newlines, URLs, emails, non-ASCII characters and over-long values
are replaced by `unknown` as a whole. The existing telemetry credential-scrubbing rules are reused; a name
recognized as a credential is likewise replaced entirely and no fragment is kept. Format validation does not prove
arbitrary text safe, so real resolution source and format validation must both hold.

The same pure function is used for the CLI terminal fact, the UI compatibility metadata/step and the final
`/report` scrubbing; the V4 schema validates the name constraints. The skillName of an old scheduling fact is not
treated as resolved metadata; a name is accepted only in a terminal state with a source, so mixing in an old CLI
does not reintroduce a request-parameter fallback. Business Skill input and loading rules are unchanged. The other
three plugin fields stay optional with existing semantics; the source is not guessed from the name. Old data is not
back-filled.

## Data chain

```text
ToolCallScheduled (Skill, request name not extracted)
        |
        v
SkillPort.loadSkill() -- resolved SkillMetadata --> ToolCallResult / ToolCallError
        |
        v
tool.lifecycle fact
        |
        v
existing agent_step finalization
```

Skill metadata propagates as telemetry-only data of a session event and does not enter the model-visible tool
result content or error body. If a Skill was resolved but a later serialize/post_hook stage fails, the metadata is
kept to the final failed `agent_step` via `ToolCallError`. The scheduling fact carries no name; a terminal state
accepts only resolved, constraint-satisfying metadata; the name is held by the existing step owner and no cache or
queue is added. Desktop continuous and mobile replayable use the same fact fields and their own delivery
boundaries.

## Boundaries and invariants

- A step with `tool_name !== "Skill"` must not contain any `skill_*` field.
- Bash/MCP steps produced by flows such as document, CUA and BUA do not inherit Skill metadata.
- If a CUA/BUA flow itself calls `Skill`, only that `Skill` step gets the fields.
- No step is added, so `agent_step_cnt`, `loop_index`, duration and token definitions are unchanged.
- Official bundled plugins are currently exposed through the plugin root; `skill_source` still reports `plugin`
  and `skill_plugin_id` uses the real marketplace id; it is not changed to `bundled`.

## Compatibility

Old session events and Skill calls whose metadata cannot be resolved still close under the existing `tool_name=Skill`
logic; the protocol's new field is optional and new clients stay compatible with old events. The new fields are
reported by the matching CLI/App; historical telemetry is not back-filled.

## Acceptance

- `zcode`, `agents`, `bundled`, `remote` and `plugin` sources all report a resolved `skill_name` that satisfies the
  telemetry rules; non-conforming names become `unknown`.
- A plugin-qualified request name becomes the original skill name after successful resolution; existing plugin
  fields are unchanged.
- Failure, denial or stop before resolution is always `unknown`; no request name is kept.
- Compatibility with old `input.name`, terminal-only arrival and old metadata: a missing resolved name is
  `unknown`; non-Skill tools carry no `skill_name`.
- Paths, URLs, newlines, simulated credentials and 65/5000-character names cannot enter a fact or the final
  `/report` request body; covers failure, denial, stop and HTTP retry, while normally resolved ordinary/plugin
  names remain countable.
- The App ↔ CLI strict schema accepts the optional `skillName`; existing step count, status and token are
  unchanged.
