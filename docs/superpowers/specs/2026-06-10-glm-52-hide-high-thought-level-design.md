# GLM-5.2 Default Max Thought Level

For ZAI, BigModel, ZAPI, custom, and dynamic GLM-5.2-like models, and every GLM dated temporary model, `high` stays visible and selectable, but automatic model switches default to `max`. The behavior is consistent across frontend configOptions, model switching, workspace defaults, active task config, zcode-cli model capability, and provider request mapping.

Model matching:

- GLM-5.2 matching compares the final model id segment: `glm-5.2`, `GLM-5.2`, `glm-5.2-pro`, and provider-prefixed forms like `zai/glm-5.2`.
- GLM dated temporary models match final id segment prefix `glm-` followed by digits, for example `glm-0606[1m]`.

Rules:

- Visible thought levels for these models: `max`, `high`, `nothink`, default `max`.
- OpenAI-compatible transport maps `high` to canonical `reasoningEffort = "high"`, serialized by the AI SDK as top-level `reasoning_effort = "high"`. Anthropic-compatible maps `high` to `effort = "high"` with `thinking.type = "enabled"` and a fixed budget lower than `max`.
- Frontend configOptions preserve incoming `currentValue: "high"` instead of normalizing it away.
- Switching into, or draft-initializing, such a model sets thought level to `max` when available; switching into any other model keeps the existing thought-level preference behavior. Users can still manually select `high` — the rule only controls the automatic default.

Data flow:

- The frontend stores agent-returned thought-level options with no GLM-specific `high` filter; general normalization still applies (missing current value falls back to the first legal option).
- zcode-cli reasoning metadata is the runtime source of truth: capability must include `high`, and providerOptions for `high` must exist so runtime snapshots and session updates pass the level through to the provider request.
- After a successful model switch, the toolbar detects a GLM-5.2-like or GLM dated temporary model from the authoritative configOptions and, if `max` is offered, updates the active task or workspace default thought level to `max` — runtime state, not just local display.
- The workspace prepare path does the same detection when projecting draft session settings to configOptions, preferring `max` over a stored `high` preference. The automatic `max` choice is never written back to the global last-thought localStorage preference.

Testing: UI store tests preserve `high`; model-switch tests force `high` → `max`; workspace prepare tests prefer `max` over stored `high`; neighbor coverage proves non-GLM-5.2-like models are not forced to `max`; zcode-cli adapter/bootstrap tests prove capability `max`/`high`/`nothink` with generated providerOptions.
