# Visualize Skill CLI Loading Boundary

## Behavior

The built-in `visualize@zcode-plugins-official` provides in-conversation interactive views; a plain terminal has no matching host.

1. Non-`--stdio` entries (TUI, `-p` / `--prompt` / `--target`, `skills list/inspect`) do not inject this plugin's skill root by default. The skill catalog available to the model and Skill body loading use the same discovery result. Even `-p` with `--surface desktop` (simulated presentation surface) does not auto-enable the skill.
2. The `--stdio` protocol entry passes `includeVisualize: true` explicitly when creating the App and scanning the draft skill directory. This is an internal bootstrap assembly option, not a user config, environment variable or protocol request field; the default is off. It is independent of the Desktop context presentation-surface gray rollout and keeps the existing protocol-side loading behavior.
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
- Plugin marketplace catalog, cache seed, install records and enable/disable config are unchanged; `plugins list` can still manage the plugin.
- Filtering happens when App startup resolves plugin skill roots; the main session and workflow children use the same result, and ordinary subagents keep inheriting the parent session's skill port. A resumed session is reassembled by the current startup entry.
- Desktop local and attached SSH/WSL/Docker workspaces keep using the stdio protocol; mobile `/remote` reuses the same shared host. Workspace identity, owner/lease, queue, event stream, snapshot and recovery are unchanged; the desktop continuous and mobile replayable boundaries are unchanged.

## Verification

- With the default or explicit off, the official skill catalog has no built-in visualize and loading by name or qualified name reports not found.
- With the protocol enabled, the full skill is discoverable and readable; user-disable config still applies.
- Main-session startup and workflow children share the filtered root; other built-in skills stay available.
- The protocol App assembly and the draft directory both keep visualize; same-named ordinary project skills are unaffected.
- Build the real CLI and verify non-stdio list/inspect and the stdio skill-catalog request.
- No Renderer interaction or protocol schema change; the loading boundary is verified by CLI/protocol integration, with no new UI E2E.
