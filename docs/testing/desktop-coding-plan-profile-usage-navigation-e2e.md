# Desktop Profile Usage Navigation E2E

## Scope

The avatar-menu entry `使用统计` (Usage statistics) is a settings-page navigation entry and must be covered in two page contexts:

- The workspace sidebar footer avatar menu.
- The settings sidebar footer avatar menu.

These cases verify navigation semantics only, not Coding Plan entitlements, quota or Team Plan data. Usage-data assertions stay in the dedicated Team Plan / Coding Plan E2E.

## Cases

| Case         | Precondition                                                                    | Action                                        | Expected                                                                                |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| ECR-usage-01 | Desktop default workspace is open                                               | Click `使用统计` in the workspace avatar menu | Settings opens with the `usage` section selected                                        |
| ECR-usage-02 | Desktop default workspace is open; settings is already on the `general` section | Click `使用统计` in the settings avatar menu  | Stays on settings and switches to the `usage` section; does not return to the workspace |

## Test placement

Both cases live in `packages/desktop/test/e2e/e2ecase-regression.test.ts` with the default-workspace precondition. The test clicks the currently visible avatar menu and the `使用统计` item through shared test ids, so hidden workspace DOM kept by the settings page cannot affect the assertions.
