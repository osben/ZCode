# Todo 105: Trim the Personal / Team Account Provider Preset Model List

> Status: Completed (2026-09-10): implementation, config/Registry verification and per-item review. Evidence, boundary
> review and real-environment limits: [delivery review](./provider-todos-105-113-delivery-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-105-account-provider-model-list-trim.md`

## Rules

1. The preset model lists of the personal and team Account Providers (BigModel and Z.ai, four Providers) no longer
   contain `GLM-5-Turbo` and `GLM-5.2`.
2. Only those Providers' preset members change. No general model capability rule is deleted; Start Plan, Off-Peak and
   ordinary API Key Provider lists are untouched; user-added models and saved Model Selections of history sessions and
   tasks are not cleaned or rewritten.

## Result

- Only the four personal/team `builtinModelIds` changed; no capability/override rule and no Start/Off-Peak template list changed.
- `account-model-membership.test.ts` verifies the trimmed preset for the four Providers and that an explicit Personal
  add of 5.2/Turbo still enters the Registry (the list assertion failed before the fix and passes now); Builtin
  integrity: 14 cases pass.
- The maintenance checklist is synced. No history/task/user-config write or migration; settings and selector share the
  resolved list, so no UI filter was added.
