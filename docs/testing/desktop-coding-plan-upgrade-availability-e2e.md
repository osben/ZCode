# Desktop Coding Plan Upgrade Availability E2E

Date: 2026-07-03

## Coverage goal

Simulate a BigModel account that is signed in but has no personal Coding Plan entitlement, where the user enters the `Upgrade Coding Plan` purchase page from the settings page or the sidebar avatar menu upgrade entry. Personal plan data comes from the local E2E fixture server; the real BigModel / ZCode backend is never contacted.

The account fixture provides a resolvable personal project and project credentials; the subscription list is empty and the entitlement API explicitly returns no plan. An empty project list must not be used to simulate "no entitlement": that turns the account state into a query failure instead of signed-in-but-not-subscribed.

A mixed suite may reuse the mock origin fixed before the build, but every worker must explicitly reset the scenario and the marketing switch. Only `marketing-touch-*` workers enable the marketing fixture; purchase cases return an empty placement and must not inherit a previous case's Popup, Banner or pending claim. Re-enabling marketing uses fresh fixture state.

```text
worker spec -> reset(scenario, marketingTouch) -> same mock origin
  purchase cases: empty placement      marketing cases: fresh placement state
```

## Case: BigModel personal plans all sold out

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/coding-plan-upgrade-personal-sold-out.test.ts` |
| Data source | `BigModel Coding Plan E2E mock server` |
| Status | verified |

### Setup

1. The isolated E2E HOME contains only BigModel OAuth credentials (signed in; no other account family).
2. A BigModel Coding Plan provider is written, with no subscription.
3. `ZCODE_TEST_BASE_URL` and `BIGMODEL_TEST_API_BASE_URL` point to the local mock server.
4. `client/configs` returns the static BigModel personal Lite / Pro / Max plans.
5. `pay/batch-preview` returns the same personal plans, every SKU with `soldOut=true`.

### Action

1. Open the default workspace.
2. Open the settings model-provider section and enter the BigModel brand entry by the shared Provider ID.
3. Wait until the subscription entry is clickable, confirm the purchase webview is not open yet, then click the subscription entry.

The brand entry no longer offers the old API Key connection mode, so the removed mode switch is not used to create a sync wait. The subscription button's loading and disabled state during sync is kept by the corresponding unit test in `packages/ui/test/modelProviderCodingPlan.test.ts`; this E2E verifies only the current subscription-entry-to-sold-out-page interaction.

### Assert

- The subscription entry opens a visible Coding Plan webview with the product's window controls.
- The local purchase page fixture shows "已售罄" or "Sold out".
- SKU button disabling and cycle selection of the real external purchase site are outside this local HTML fixture.

## Case: BigModel personal plan API system busy

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/coding-plan-upgrade-personal-system-busy.test.ts` |
| Data source | `BigModel Coding Plan E2E mock server` |
| Status | verified |

### Setup

1. The isolated E2E HOME contains BigModel OAuth credentials (signed in).
2. A BigModel Coding Plan provider is written, with no subscription.
3. `client/configs` returns static personal plans so the purchase page has cards to show.
4. `pay/batch-preview` returns a business failure that the service normalizes to `coding_plan_system_busy`.

### Action

1. Open the default workspace.
2. Click the account avatar menu in the sidebar footer.
3. Click the `Upgrade Coding Plan` entry to open the purchase page.

### Assert

- The page still shows the static personal plan cards, not a blank page or endless loading.
- The Lite / Pro / Max personal plan buttons use the button-specific copy: "订阅繁忙" (zh), "System busy" (en).
- The buttons are disabled and cannot enter the cycle selection page.

## Non-coverage

- Real payment, QR codes, Stripe / PayPal or team plan ordering.
- The mobile `/remote` replayable path; this case verifies only the desktop local sidebar upgrade entry and purchase page UI.
- Real online inventory or real BigModel account entitlement, so the fixed regression is not affected by online state.

## Verification commands

The local mock origin of the upgrade page is written into the renderer build output. A new run must build normally and must not reuse artifacts of an earlier run built with `ZCODE_E2E_SKIP_BUILD=1`; otherwise the webview visits the closed old port.

- `pnpm --filter @zcode/desktop typecheck:e2e`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:e2e -- --spec ./test/e2e/coding-plan-upgrade-personal-sold-out.test.ts`
- `pnpm test:e2e -- --spec ./test/e2e/coding-plan-upgrade-personal-system-busy.test.ts`
