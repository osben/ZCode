# Subagent model and reasoning effort overrides

> Current ruling (2026-09-08, Todo88/96/97): when the user actively picks a model, fill in that
> model's highest effort level; a missing level in history is not backfilled with a default.
> Candidates and capabilities come only from the target Environment's Selection View, not from a
> dual-source backfill of App metadata and catalog. Earlier acceptance notes about a "default level"
> or "catalog reconciliation" yield to this note and the current coverage matrix; do not restore the
> old abstraction from them.

## Goals

Settings lets users configure a persistent model and reasoning effort for the built-in
`general-purpose` and `Explore` agents, custom subagents and plugin-provided subagents. A local
integrated session reads the Host config when a new parent context starts and fixes the definitions
for that turn; `Agent` and terminal `SendMessage` use that definition. The standalone CLI and remote
workspaces keep their startup config source. See [config refresh contract](./subagent-runtime-refresh.md).

### Todo103 G04-A: staging availability behavior port

- Keep the user behavior of `5161e0914f`: when the original model no longer exists among clearly
  ready candidates, the custom edit trigger shows "Select model"; the list badge may still show the
  original model name; the original draft/Markdown is not cleared; the historical model is not added
  back to the candidates; save is disabled and reasoning is hidden.
- loading/error/unavailable does not mean the model is invalid; the original intent is not rewritten
  and a new list is not declared ready because of it.
- Candidate updates keep the first read and notification of `useModelSelectionServiceView`;
  `useModelProviders`, Family selected-key, the App metadata/catalog dual source, or an extra Registry
  push on entering the page are not reintroduced.
- Start and Individual are isolated by Provider ID even when they share an endpoint and have
  same-named models: Start's dynamic list must not flow into Individual/API Key, and an Individual
  model with the same name must not swallow a Start model. The existing Account Overlay / Resolver
  guarantees this and it is regression-verified.
- Acceptance: SU covers missing-model trigger with the original selection kept, public hook update
  and re-entry, and Resolver isolation of same-address members; SE-03 deletes a member in a real
  window and checks the trigger, dropdown, disabled save and that file bytes are unchanged.
- This section replaces the older "Custom edit still shows the original model name"; the historical
  metadata/catalog reconciliation notes are not a basis for wiring.

### Todo103 G04-B: current-architecture contract for plugin overrides

Behavior from `dbb3ec0ce8` is kept and accepted in three parts: B1 override storage/loading, B2
official plugin discovery, B3 shared UI and store refresh.

```text
plugin Markdown default Selection (read-only)
                        |
user agents-state.json plugin override --replaces the whole Selection by stable agentId
                        |
             canonical-name profile + bare-name alias
                        |
           Todo99 explicit effective selection resolution
                        |
               fix this child's Model
```

- Newly written field `pluginAgentModelSelectionOverrides`: stable agentId → complete ModelSelection.
  agentId stays `plugin:<name>@<marketplace>:<agent bare name lowercase>` without a version.
- Service/RPC saves with one `{agentId, modelSelection?}`; it shares the same state write queue and
  atomic write entry, does not split model/thoughtLevel into two saves, and does not depend on the
  current connection or candidate list to decide what to persist.
- Clearing an override deletes the whole Selection; specifying a new model without a level cannot
  inherit the plugin's original model level. With no override the plugin's original Selection is
  returned; an already-fixed running model is not changed; a new local parent context re-applies the
  latest override.
- The source staging's plugin dual map is converted once only at the existing `migrateSubagentStateFile`
  storage import boundary, using the existing offline Provider mapping; the official reader reads
  only the structured map. If the new map exists (including empty/corrupt) the old map is not read
  back. This does not accommodate the unreleased wrong Markdown intermediate format of this branch
  and adds no other migration or account query flow.
- Bootstrap reuses the already-awaited user state load result to inject into the plugin loader, adding
  no sync disk read. Canonical names and aliases get the override before the same expansion;
  leftover overrides of non-existent/renamed plugins do not affect other agents.
- Built-in and plugin agents share the inline model control, and actively picking a model still takes
  the highest level; a failed save rolls back the draft, while a refresh failure after a successful
  save does not roll back. Plugins do not open prompt/tools editing, delete, single enable/disable,
  and project/plugin Markdown is not written. The same responsive control serves desktop and narrow screens.
- Official-cache supplementary discovery obeys install-record priority, explicit disable/suppress
  priority and valid-manifest version selection, and must not resurrect an uninstalled plugin.
- Store auto-refresh is verified separately by that source's throttle/concurrency dedupe behavior;
  install, source, state and display cache are not merged into one state.
- B1 acceptance: shared migration of old/new authority; Host full-combination save/clear/concurrency;
  Agent canonical-name and alias get the same override; model-only does not keep the old level;
  different plugins are isolated; plugin files unchanged; the final B3 runs a closed loop with real
  Settings and cold start.
- B2 wiring: the default-enabled IDs move to the shared marketplace contract and are reused by the
  three resource entries, including `computer-use`, which is explicitly default-enabled today (the
  upstream four-item list misses it), mechanically compared with the CLI definition. Directory
  scanning sits in a Node-only shared entry; no new imports of concrete Plugins-domain
  implementation from Subagents/Skills/Commands; other resource discovery is not refactored.
- B2 acceptance: a default built-in without an install record is visible; non-default / explicitly
  disabled / suppressed are not; old and new valid versions pick the newer, a name not matching the
  manifest falls back, temp/backup directories do not participate; install records take priority and
  a disabled record is not resurrected by cache fallback.
- Settings' `settingsUserOnly` still lists only user/built-in manageable items and reads no project
  files, but `pluginAgents` must return a read-only resource projection of local plugins, otherwise the
  shared override control is unreachable on the user page. This does not add plugin aliases to the user
  edit list and does not extend the automatic migration directory.
- Cold-start plugin seeding may land after the first file list read. The settings page's existing
  plugin inventory initialization is reused: the user page picks an available local workspace as call
  context with an explicit user scope, and the resource list refreshes after initialization. The first
  user/built-in list does not wait for plugin initialization and a failure does not clear the list;
  page switch/unmount discards late callbacks; delays or polling do not solve it.

## Non-goals

- No editing of a built-in agent's name, description, system prompt, tools, permissions or deletion state.
- No disabling a built-in agent.
- No workspace-level built-in override.
- No change to the workspace subagent edit scope; a plugin subagent opens only the model and
  reasoning effort override, not name, description, prompt, tools, deletion or single enable/disable.
- No per-invocation model or reasoning effort override on the `Agent` tool.
- A running parent context and its children keep the original config; a save takes effect at the next parent context.
- No change to the desktop continuous and mobile `/remote` replayable message flow boundary.

## Default behavior

- `general-purpose` without an override inherits the parent session's main model.
- `Explore` without an override also inherits the parent session's main model, like `general-purpose`.
- Clearing an override restores the above defaults.
- An explicit model with no `thoughtLevel` uses the target model's default reasoning level in the current catalog.
- With no explicit model, `thoughtLevel` is not applied alone and the parent runtime's provider options are still inherited.

## Storage format

A custom subagent stores an optional `thoughtLevel` in Markdown frontmatter:

```yaml
model: custom:custom-openai:gpt-5.4
thoughtLevel: high
```

A built-in subagent stores the complete structured Model Selection in the existing state file:

```json
{
  "disabledAgentIds": [],
  "builtInModelSelectionOverrides": {
    "general-purpose": {
      "providerId": "custom-openai",
      "modelId": "gpt-5.4",
      "options": { "reasoningLevel": "high" }
    },
    "Explore": {
      "providerId": "custom-openai",
      "modelId": "glm-5.2",
      "options": { "reasoningLevel": "max" }
    }
  }
}
```

An absent key means no override. A built-in's model and reasoning level must be written together by
one service call; clearing the model deletes the whole Selection. The published old dual map is
imported and persisted only at the shared Node migration entry; the official reader reads only the
new map, and an empty or corrupt new map must not fall back to the old map.

### Todo97: in-place migration of user Markdown

```text
old model value in the user directory -> offline Provider replacement -> original file written back
                                                                         |
project/plugin original files (not migrated) ----------------------------+-> official codec -> internal ModelSelection
```

- Host and standalone Agent initialization reuse `migrateUserSubagentMarkdown` and access only
  `agents/` under their own data directory; project and plugin files are not written automatically;
  symlinks and read-only files are not rewritten.
- Only the old Provider value in frontmatter is replaced; model name, level, comments, body, unknown
  fields, line endings and file permissions are kept; the whole-file serializer is not used for
  automatic migration.
- Official Markdown reads/writes only the string `model` and `thoughtLevel`, with no compatibility for
  the unreleased `modelSelection` intermediate field. IDs containing separators round-trip via the
  existing custom encoding.
- The ordinary reader no longer temporarily maps out-of-scope old Providers to a new account; explicit
  identity is kept and execution validation applies. No automatic account-switch protocol or parent
  model fallback is added.
- See [all-scope Selection audit](working-memory/provider-refactor/research/todo97-selection-storage-audit.md);
  the Wiki read-time write conflict still awaits a ruling and is not counted as done.

## Runtime semantics

```ts
type BuiltInSubagentName = "general-purpose" | "Explore";
type BuiltInSubagentModelSelectionOverrides = Partial<Record<BuiltInSubagentName, ModelSelection>>;
```

Bootstrap reads the state at startup; the local integrated entry uses the Host in-memory state at a new
parent context to update the built-in profile's model / thought level overrides. Overrides passed
explicitly in the startup config win over disk config; if the startup config replaces an agent's model
without providing a thought level, that agent does not inherit the old model's thought level from disk.

The `Agent` tool's provider-visible input has no `model` or `thoughtLevel` parameter and no
invocation-level override. The child runtime of an ordinary session reads the final resolved `AgentProfile`:

- A profile with no model inherits the parent session's main model and provider options.
- A profile with a concrete model and no thought level builds provider options from the target
  model's catalog default level.
- A profile that also has a thought level must first confirm the level belongs to the target model,
  then reuse the main runtime's reasoning resolver to build provider options; an illegal value is
  rejected directly and never falls back to the default or a neighboring level.

When an idle-time task supplies `turnExecutionModel` for this turn's foreground child, that snapshot
overrides the profile's model, thought level, provider options and model limits, and the profile
thought level is neither validated nor applied. The snapshot only applies to the current turn and is
not persisted; later ordinary calls restore the profile semantics above; background children are
still rejected by the idle-task boundary.

An old `Agent.model` field already persisted in history messages is not data-migrated and is dropped
as an unknown field on later execution; it cannot override the current profile.

The loading, naming priority and model fields of custom / workspace profiles are unchanged. The
naming priority of plugin profiles is unchanged; when bootstrap loads plugin agents it reads the same
state file and injects the model / thought level override by id into both the canonical-name profile
and the bare-name alias profile; on a miss the model declared in md is kept.

## Plugin subagent discovery scope

Settings and runtime must see the same plugin subagents. The runtime loads both marketplace-installed
and built-in official plugins through plugin resolve, while services' `discoverPluginAgents` used to
read only `installed_plugins.json`, so built-in official plugins (such as `document-skills`' `judge`)
were invisible in Settings. Services now additionally scan
`<cli storage>/plugins/cache/zcode-plugins-official/<name>/<version>/`:

```text
installed_plugins.json records ───────────┐
                                          ├─> dedupe by pluginId (install records win)
cache/zcode-plugins-official/<name>/<ver> ┘        │
   take the first usable version directory         ▼
   in numeric-aware descending order           enabled check:
   skip .backup / .seed-lock / .tmp- dirs       enabledPlugins[pluginId]
                                               ?? default-enabled set (shared with skills/commands)
                                               and not in suppressedBuiltins
```

An official plugin's `pluginId` is `<manifest.name>@zcode-plugins-official`, matching the CLI
`PluginMetadata.id`, so override keys line up on both sides.

## Explore tool surface

`Explore`'s allowed tools must use the final effective child model to decide the embedded-search
branch. Without an override the tool surface must not keep being computed from the old `lite` default.

## UI semantics

In the Settings Subagents list:

```text
Subagent Settings
                                      |
                                      v
target Environment ModelSelectionService.getView()
                                      |
       +--> provider/model candidates
       `--> reasoning option specs
```

The Subagent settings page reads only the target Environment's Model Selection View. A remote
Workspace reads the remote View directly and a local Workspace reads the local View; the page does not
compare the App snapshot with the workspace catalog and does not trigger a Registry push.

1. Built-in and plugin agents show the model control; both share the same control and save-on-change
   semantics. A plugin agent's default item also reads "inherit default", meaning fall back to the
   model declared in the plugin md, or inherit the parent session's main model when md declares none.
2. When a built-in or custom agent's explicit model supports reasoning, the main composer's
   `ThoughtLevelCycleControl` is reused to the right of the model control.
3. The effort loading gate matches Draft: the target model's Option Spec in the Selection View is the
   only capability source; the page does not read Session `configOptionsStatus` and does not backfill
   from another Environment's metadata.
4. Provider/Model identity is `providerId + modelId`; a display-state variant creates no second model identity.
5. While the target Environment is not ready, loading shows; a read failure shows an error and allows
   an explicit retry; the old Registry Snapshot or the local View is not used as a fallback for remote.
6. A missing reasoning Option Spec or an empty level list means the current model has no selectable
   reasoning level; a non-empty list is the legal set for that model.
7. Choosing a different model clears the in-memory explicit `thoughtLevel` at once; re-selecting the
   same model is a no-op.
8. When a concrete model has no explicit `thoughtLevel`, the control may show the catalog default
   level, but the shown value is not an already persisted override. The Select's real selected value
   is always the current effective level so keyboard focus and accessible selected state are
   consistent; the explicit state is maintained independently. Saving without touching the effort
   control keeps `thoughtLevel: undefined`; re-confirming the current effective level or choosing
   another legal level must write the choice into the draft and persist it.
9. `inherit` or a model that does not support reasoning shows no effort control.
10. A writable control renders when the Selection View gives a non-empty level list; with an empty
    array or a missing Option Spec the control is hidden, with no backfill from the old catalog or
    App-local metadata.
11. A historical effort not belonging to the current model shows the raw value and an error and blocks
    custom save, without auto-mapping to the first level; a built-in can be corrected by choosing a
    legal level or switching model.
12. When a saved concrete model is removed from the current candidates, the open menu shows only
    current candidates and does not add the historical model back; since the target model capability is
    gone, the effort control is hidden. A built-in trigger shows the "Select model" hint; a custom list
    badge keeps the original model name and the edit-form trigger shows the "Select model" hint. The
    custom form keeps the original model / `thoughtLevel` as uncommitted state and blocks save until
    the user re-selects an available model; merely opening the edit page cannot rewrite the original
    Markdown. This rule changes only the model trigger display, not candidate source, validation, save
    or runtime semantics.
13. Built-in and plugin agents show no edit, delete, enabled switch, prompt editor or tools editor;
    plugin rows cannot be clicked into a form.
14. The default item of `general-purpose` and of `Explore` reads "inherit default".
15. Builtin / plugin model / effort save atomically in one call, both controls are disabled during the
    write, and a failed write restores the previous combination and shows a toast. A successful write is
    the commit point; a later list refresh failure cannot roll back the persisted combination.
16. Custom save overwrites the Markdown directly with the current `{ model, thoughtLevel }`; a
    `thoughtLevel` of `undefined` deletes the old field.

## E2E scope

Tests must not use `workspace/updateProviderRegistry` as a Subagent config reconciliation step.

Desktop E2E verifies real-window editing and cold-start effect:

1. Settings changes a builtin model / effort; check the full combination in `agents-state.json`.
2. Settings changes a custom model / effort and saves; check the Markdown frontmatter; after switching
   the model confirm the old effort is deleted.
3. Inject an illegal historical effort; confirm an error shows, save is blocked, and choosing a legal level corrects it.
4. After cold start, trigger a child request through the `Agent` tool; confirm the provider-visible
   model and reasoning parameters come from the profile config and the parent request is unaffected.
5. The `Explore` child request exposes no write tools.
6. Even if the provider returns a historical `Agent.model` parameter, it cannot override the current profile model.
7. For `claude-opus-4-8`, whose reasoning App metadata does not declare, the main composer and the
   builtin/custom Subagent must show the runtime catalog's `low/medium/high/xhigh`, and parent/child
   effort isolation is verified through the raw provider request and model-io.
8. When Settings selects only a reasoning model without touching the effort control, check that the
   builtin state gains no thought-level key and the custom Markdown frontmatter gains no
   `thoughtLevel`, while the control still shows the target model's catalog default level.
9. After saving custom model A with an effort, delete A in the model provider settings and reopen that
   Subagent's edit page; check the model control shows the "Select model" hint, the dropdown does not
   contain A, the effort control is hidden, save is unavailable, and the original Markdown was not
   rewritten.
10. After a BigModel login when the workspace catalog still lacks Coding Plan, first confirm effort can
    show at once from App metadata, then independently wait for background reconciliation to write the
    target model and `high` / `max` into the runtime catalog.
11. After the user claims Start Plan and enters Subagents, the model group first shows Start; after the
    user switches back to Individual in the model provider settings and re-enters Subagents, the model
    group must show Individual candidates. A UI unit test additionally verifies the same connection-key
    chain switching to Team.

Settings CRUD uses a separate E2E without provider requests to verify saved artifacts; it is not
chained with the child runtime scenarios above:

| Scope / type              | Create                | Edit                   | Artifact checked after save                                                                     |
| ------------------------- | --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| Builtin `general-purpose` | not supported, pruned | covered                | atomic model / effort combination in `agents-state.json`                                        |
| Builtin `Explore`         | not supported, pruned | covered                | atomic model / effort combination in `agents-state.json`                                        |
| Custom user               | covered               | covered (incl. rename) | full frontmatter and body of `<user-data>/agents/<name>.md`, and old path deleted               |
| Custom workspace          | covered               | covered (incl. rename) | full frontmatter and body of `<workspace>/.zcode/agents/<name>.md`, and old path deleted        |
| Plugin                    | not supported, pruned | covered                | model / effort atomic combination of `pluginAgent*Overrides` by agent id in `agents-state.json` |

This E2E only consumes the existing model/capability projection to drive the controls; it sends no
prompt, does not restart to verify a child, and does not modify the CLI or model resolver. Custom user
and workspace share the form and service serializer, but the two real on-disk directories are verified
separately.

"Show the default level without touching effort" uses its own case so it is not masked by a later
explicit effort choice in the same flow; it checks the final file artifacts of both the builtin
`agents-state.json` and the custom Markdown.

Settings save and clearing overrides are covered by UI/service unit tests. The real Desktop E2E
SHR01-SHR03 verifies an existing session's next-turn spawn, failed-child recovery, and keeping the old
config within the same turn; see [config refresh acceptance](./subagent-runtime-refresh.md).

## Acceptance

- A built-in agent in Settings has a model control, and still has no edit, delete or disable entry.
- Built-in official plugins (such as `document-skills:judge`) and marketplace plugins' subagents are
  both visible in Settings with a model control; plugin agents still have no edit, delete or disable entry.
- After saving a plugin agent override, list/state echo the override model by agent id; after cold
  start the child request uses the override model.
- After saving a `general-purpose` or `Explore` override, list/state echo the override model.
- Builtin/custom can save, echo and clear reasoning effort.
- With no explicit effort, explicitly choosing the displayed catalog default level can still be
  written to state / Markdown; merely displaying the default without touching the control adds no override.
- A model switch clears the explicit effort in the form at once; a provider catalog refresh does not clear it.
- Different models show only the levels they support; the control is hidden when reasoning is unsupported.
- Unknown catalog and explicitly no levels are not conflated; loading/old payload does not clear or
  misjudge a historical effort.
- An illegal historical level is neither silently fallen back nor saved.
- Clearing the override restores the default model.
- The runtime child request uses the override model and that model's provider options.
- The provider-visible `Agent` input has no `model`; a historical version passing the field does not change the child model.
- `Explore` child tools match the override model's capability.
