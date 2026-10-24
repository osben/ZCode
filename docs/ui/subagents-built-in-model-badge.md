# Built-in Subagent Model Control

Settings shows the same inline model control for built-in and plugin subagents; other fields stay
read-only.

1. `general-purpose` and `Explore` inherit the parent session's main model by default.
2. Choosing a concrete model writes a built-in model override; clearing the override restores the
   built-in default behavior.
3. Thinking level and Draft both read the target Environment's Selection View; no App metadata/catalog
   dual-source backfill.
4. Load failure is distinct from explicitly unavailable; only when the current ready candidates lack the
   original model, the "Select model" (选择模型) hint is shown, and the persisted intent is not cleared.
5. Built-in agents show no edit, delete, enabled switch, prompt editor or tools editor.
6. User subagents keep the existing model summary display.
7. For a plugin subagent, "Inherit default" deletes the user override and returns to the model declared in
   the plugin Markdown; with no declaration it inherits the parent model. The row shows no duplicate model
   badge, is not clickable into edit, and the override is not written to the plugin directory.

```text
target Environment Selection View
                  |
                  +--> ready --> same candidate and level source
                  |
                  `--> loading / error --> keep intent, distinguish loading from failure
```

Actively choosing a new model uses its highest level; missing historical levels are not auto-filled.
Built-in and plugin overrides write a complete ModelSelection at once; a save failure rolls back the
combination, a refresh failure after a successful save does not. Full contract:
`docs/subagents-built-in-model-overrides.md`.
