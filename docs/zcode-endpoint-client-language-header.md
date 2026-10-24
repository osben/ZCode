# ZCode Endpoint Client Language Header

## Background

The `X-Client-Language` header of ZCode endpoint requests used to take the process's
`Intl.DateTimeFormat().resolvedOptions().locale`. When the App starts from Finder/Dock the process has
no `LANG` and Node ICU falls back to `en-US`; even with `LANG` it reflects only the system language
and does not follow the UI language setting. As a result `billing/balance`, `client/configs` and
similar requests still sent `en-US` under a Chinese UI.

`marketing/touch` is unaffected: the UI passes `useZCodeIntl().locale` to the service, which writes
the header explicitly and overrides the `NodeApiClient` default.

## State owner

The owner of the live UI language is UI state. Main receives it immediately through
`SetApplicationLocale` and keeps it in `currentApplicationLocale` (already used by menus, tray, etc.).
The `locale` in `setting.json` is only for restart recovery: writing is asynchronous and its failure
does not block the UI, so it cannot be the source for live requests.

```text
UI locale --immediately--> Main.currentApplicationLocale (live owner)
   |                         |- Main's own requests: client/configs gray rollout, help config
   |                         |- spawn Host: InitLocal.locale (initial value)
   |                         '- on change: post application-locale-changed to every window's Host
   |                               '- Host in-memory clientLocale --sync read--> NodeApiClient default source header
   '--async, may fail--> setting.json (restart recovery)
```

## Rules

- The Host reads only the in-memory value and does no I/O; reading the language does not affect request cancellation or timeout.
- InitLocal and change messages travel over the same utility-process port and arrive in send order, so the initial value cannot overwrite a newer change.
- At startup Main first reads the persisted language (system language if absent) and then starts the client/configs gray-rollout prewarm, so the prewarm request does not enter the 1-hour cache with the default language.
- An explicit `X-Client-Language` passed by the caller still wins (`marketing/touch` behavior unchanged).
- If no language has been received, fall back to the original `Intl` rule and do not block the request.
- Remote `zcode-server` (SSH/WSL/Docker) is not injected and keeps the original `Intl` behavior; remote sync is designed separately.

## Test coverage

E2E: `packages/desktop/test/e2e/settings/settings-client-language-header.test.ts`. It uses
`x-request-id` to tell Host (`NodeApiClient`) from Main (Electron `net`) `client/configs` requests.

| Case   | Scenario                                                                                                 | Assertion                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CLH-01 | Persist `en-US` (different from the startup default `zh-CN`), then restart the App                       | Startup prewarm and Host requests both carry `en-US`                                       |
| CLH-02 | The second window's Host fails to write `setting.json`; switch to `zh-CN` on that window's settings page | New requests from both windows' Hosts and Main carry `zh-CN`; the disk still holds `en-US` |

Constraints E2E cannot hold stably:

- InitLocal initial value: when the renderer mounts it syncs the language to Main, which pushes to Host, so post-mount requests show no difference (reverse modification verified). Delivery is covered by `desktopWindowLifecycle.test.ts`; Host message validation by `hostMessagePortGuard.test.ts`.
- Prewarm later than reading the persisted language: there are two more `await`s before the prewarm reads the language; under normal timing the startup read completes first and the race cannot be reproduced (reverse modification verified). Guaranteed only by call order in `main/index.ts`.
- A change received during Host initialization: also masked by the post-mount sync (inferred, not verified). Order is guaranteed by "message handling assigns synchronously before any `await`".
- Push only to the initiating window's Host: other windows' renderers also sync to Main on receiving the language broadcast, so user-visible behavior is unchanged (inferred, not verified).

## Not covered

- Requests initiated by remote `zcode-server`.
- `offPeakServerClient` calls `fetch` directly and still uses the `Intl` rule.
- CLI (`apps/zcode-cli`) provider endpoint routing and standalone Built-in download.
