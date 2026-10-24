# ZCode test endpoint menu (desktop test builds)

## Problem

Desktop test builds (`ZCODE_ENV=test`) show Help → ZCode Endpoint with Production / Test / Custom /
Reset. The open-source import set every `TEST_*` host in `packages/shared/src/zcodeEndpoint.ts` to the
production value (`TEST_ZCODE_ENDPOINT_ORIGIN === DEFAULT_ZCODE_ENDPOINT_ORIGIN`, identical upstream).
As a result:

- "Test" saves the production origin, and the menu immediately re-selects "Production", because
  selection checks the default origin first. The Test radio can never be checked.
- A real test origin supplied through `ZCODE_TEST_BASE_URL` is ignored by the menu: selecting "Test"
  overwrites it with the production origin, and a session running on it shows as "Custom".

The real test hosts are not in the repository, so this change does not invent them and keeps every
endpoint default as is (local dev builds keep working against production).

## Product rules

1. The menu's test origin is `ZCODE_TEST_BASE_URL` (process env first, then the local `.env` files the
   host already loads), normalized to an origin. Without it the fallback is
   `TEST_ZCODE_ENDPOINT_ORIGIN`.
2. The test endpoint is available only when that origin differs from `DEFAULT_ZCODE_ENDPOINT_ORIGIN`.
   When it is not available, the Test radio is not shown; Production, Custom and Reset stay.
3. Selection: production builds always report Production. Otherwise the current origin equal to the
   default is Production; equal to an available test origin is Test; anything else is Custom.
4. "Test" saves the resolved test origin as the endpoint override. If no test origin is available
   (command sent without a menu item, for example from a stale menu), nothing is saved and a warning
   is logged.
5. Production builds are unchanged: the endpoint submenu stays hidden.

## Owners and interfaces

- `packages/shared/src/zcodeEndpoint.ts` (pure, next to the other env → origin resolvers): `resolveZCodeTestEndpointOrigin`
  and `selectZCodeEndpointMenuEntry`.
- `packages/desktop/src/main/index.ts`: resolves the test origin once from the host env and passes it to
  menu building (`zcodeTestEndpointAvailable`) and to `executeDesktopCommand`
  (`zcodeTestEndpointOrigin`).
- `desktopApplicationMenu.ts` renders the Test radio only when `zcodeTestEndpointAvailable` is true.
- `desktopCommandHandlers.ts` `SetZCodeEndpointTest` writes `zcodeTestEndpointOrigin`.

## Acceptance

- ZTE-01: no `ZCODE_TEST_BASE_URL` → test endpoint unavailable, Test radio hidden, current production
  origin selects Production.
- ZTE-02: `ZCODE_TEST_BASE_URL=https://test.example.com/` → available as `https://test.example.com`;
  that current origin selects Test; Test command saves it.
- ZTE-03: `ZCODE_TEST_BASE_URL` equal to the production origin → unavailable.
- ZTE-04: a different override origin selects Custom; production builds always select Production.
- ZTE-05: Test command with no available test origin saves nothing and warns.
