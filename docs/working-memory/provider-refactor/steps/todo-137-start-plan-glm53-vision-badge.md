# Todo137: Hide the vision badge of GLM-5.3 on the trial (Start) plan

> Status: implemented and accepted (2026-09-12).

## Rule

[Todo126 section 4](todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md) covered only personal and
team Coding Plan and manual plan Key; the shared check missed the trial plan `start-plan` (and an old unit
test required it to show the badge). The user confirmed the trial plan also hides the GLM-5.3 vision badge.

- Not shown when `supportsImage !== true`.
- Hidden when the model ID equals `glm-5.3` (case-insensitive, exact) and Access is a manual Coding Plan Key, or an account personal / team / trial plan. Applies to both Z.ai and BigModel trial plans.
- Flash, other models, ordinary API Keys and off-peak plans keep current behavior.
- Only the display condition of `shouldShowModelVisionBadge` changes. Settings page and model-selection menu share it (desktop and phone Web identical). Image upload, real image capability, model requests, config files, Schema and builtin revision are unchanged.

## Implementation and acceptance

- The shared pure function in UI gains `start-plan` (comment explains the omission; variable renamed so the trial plan is not called Coding Plan); settings row and menu call chains unchanged.
- Red first: 3 unit failures (both Start menus, settings row) and two browser cases failing because Start's GLM-5.3 still showed the badge. After the fix: 77 unit tests and 2 browser cases pass; each browser case visits both Start plans, personal, team and manual plan Key.
- Browser coverage at 390 Chinese light and 1200 English dark opens the real model menu and checks the settings row: GLM-5.3 hidden, Flash kept (screenshots `/tmp/zcode-provider-settings-batch/vision-start-*.png`). Shared-component browser acceptance only, not a native Windows/macOS package or real phone remote control.
- Root `pnpm typecheck` passed; `pnpm lint` 0 errors / 42 warnings in unmodified files; architecture 0 violations; `pnpm --filter @zcode/desktop typecheck:e2e` passed after the root type build.
- No change to Provider/Model config, Schema, network, image capability or upload chain; no builtin revision change.
