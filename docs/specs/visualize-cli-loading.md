# Visualize Skill CLI Loading Boundary

## Behavior

The built-in `visualize@zcode-plugins-official` provides in-conversation interactive views; a plain terminal has no matching host.

The plugin stays built in and is default off. On the first read of an old config after an upgrade, every saved visualize enable value is set to `false`, and `plugins.visualizeDefaultOffMigrated: true` is written into the same config file. The origin of the old value cannot be told apart, so the migration covers both a past default-on and a manual enable. After the migration the user can enable it again and later startups keep the new value.

```text
read user / project config -> not yet migrated and has an old switch -> re-read under file lock -> atomic save false + done marker
                           -> write / lock failure                   -> warn + this layer is off in memory -> continue merge and startup
                           -> already migrated                       -> keep the saved value
user enables again         -> same file lock                         -> atomic save true + done marker -> later startups stay on
```

The config file is the single source of the switch and the migration marker; no UI switch or separate state store is added. Migration handles only the user, ancestor project and explicit project configs loaded this time; a project that is not open migrates on its first read, with no disk scan. A config with no old switch is not rewritten and keeps the default off; the switch-writing entry also writes the done marker, so a new user's first enable is not treated as an old config and turned off again. Each config layer migrates by itself, and the original workspace > user priority is unchanged. Concurrent migration, re-enable and other config writes share the file lock and re-read under it, and the migration marker and the switch land atomically together; when the migration write or file lock fails, success is not recorded, only one warn with the config path and error code is output, and this load treats visualize of the failed layer as off before the original priority merge, without blocking App assembly and plugin or skill queries. A higher layer that has already re-enabled it and the CLI override stay effective; once the disk is writable again the next load tries the migration again. Config sources are read and discovered once; with nothing to migrate they are merged directly, and with items to migrate only that file is re-checked under the file lock and the layer is updated with the switch observed under the lock. Config diagnostics are output once at the final merge entry. The migration completes before plugin discovery and before new / cold-resume session assembly, through the same entry of the execution side shared by desktop, mobile and remote. A running session takes effect at its original reload time and does not rewrite history prompts, rendering capability or control state.

1. Non-`--stdio` entries (TUI, `-p` / `--prompt` / `--target`, `skills list/inspect`) do not inject this plugin's skill root by default. The skill catalog available to the model and Skill body loading use the same discovery result. Even `-p` with `--surface desktop` (simulated presentation surface) does not auto-enable the skill.
2. The `--stdio` protocol entry passes `includeVisualize: true` explicitly when creating the App and scanning the draft skill directory. This is an internal bootstrap assembly option, not a user config, environment variable or protocol request field; the default is off. It is independent of the Desktop context presentation-surface gray rollout and only lets the protocol side load an enabled plugin and never enables it automatically.
3. A user-disabled plugin, a disabled skill, or an uninstalled built-in plugin stays unloadable; the option never overrides user config.

## Single Discovery Chain

```text
plain CLI ── includeVisualize default ──┐
                                        ├─ official-plugin skill root filter → skill discovery / Skill loading
protocol host ─ includeVisualize=true ──┘                       ├─ main session catalog
                                                               └─ workflow child inherits
protocol draft directory ─ includeVisualize=true → same filter rule → referenced catalog
```

- Filtering is by official plugin identity only; other plugins and same-named user/project skills are kept.
- Plugin marketplace catalog, cache seed and install records are unchanged; `plugins list` can still manage the plugin.
- Filtering happens when App startup resolves plugin skill roots; the main session and workflow children use the same result, and ordinary subagents keep inheriting the parent session's skill port. A resumed session is reassembled by the current startup entry.
- Desktop local and attached SSH/WSL/Docker workspaces keep using the stdio protocol; mobile `/remote` reuses the same shared host. Workspace identity, owner/lease, queue, event stream, snapshot and recovery are unchanged; the desktop continuous and mobile replayable boundaries are unchanged.

## Verification

- With the default or explicit off, the official skill catalog has no built-in visualize and loading by name or qualified name reports not found.
- With the plugin default off, the protocol entry also neither discovers the skill nor injects Gen UI context; when explicitly enabled, the full skill is discoverable and readable.
- Main-session startup and workflow children share the filtered root; other built-in skills stay available.
- With the plugin enabled, the protocol App assembly and the draft directory both keep visualize; same-named ordinary project skills are unaffected.
- Pre-upgrade user-level and project-level `true` are turned off once; after re-enabling, repeated loads and concurrent startups do not turn it off again.
- A missing config creates no file; the migration keeps other plugins and unknown fields; a failed write produces no done marker.
- Under a read-only project directory skill discovery succeeds, visualize is off and the original file is unchanged; a lock timeout and an atomic write failure degrade the same way.
- Degradation affects only the failed config layer; an already migrated higher-priority config and the CLI override stay effective.
- With no migration, each config file is loaded once and config diagnostics are recorded once per call.
- Build the real CLI and verify non-stdio list/inspect and the stdio skill-catalog request.
- No Renderer interaction or protocol schema change; the loading boundary is verified by CLI/protocol integration, with no new UI E2E.
