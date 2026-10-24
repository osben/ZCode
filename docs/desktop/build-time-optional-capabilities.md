# Desktop build-time optional capabilities

## Goal

Three capabilities are enabled by build-time configuration and are off when unconfigured:

| Capability                       | Config key                                      | Behavior when off                                                                                        |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ARMS RUM reporting               | `ZCODE_ARMS_RUM_ENDPOINT`                       | the ARMS SDK in the main and renderer processes initializes with `enable: false` and produces no reports |
| Event reporting (data warehouse) | `ZCODE_TELEMETRY_REPORT_ENDPOINT`               | telemetry events return directly before sending                                                          |
| Auto update                      | `ZCODE_AUTO_UPDATE` (`1`, `true`, `yes` enable) | same as the Preview flavor: no update check or download                                                  |

The same source can therefore produce a build that does not report or auto-update by default, or an official
build with these capabilities enabled, without hard-coding reporting addresses in source.

## Config source and priority

1. Environment variables of the build process. An explicitly empty string means off.
2. `config/private/build-defaults.json`. Exists only in the internal repo; the open-source export excludes it.
3. If neither exists, off.

## Owner and data flow

```
env vars / config/private/build-defaults.json
        │ scripts/build-time-config.mjs (the only parsing entry)
        ▼
define of desktop tsup (main, host, preload) and desktop vite (renderer)
        │ __ZCODE_ARMS_RUM_ENDPOINT__ / __ZCODE_TELEMETRY_REPORT_ENDPOINT__ / __ZCODE_AUTO_UPDATE_ENABLED__
        ▼
@zcode/shared env constants ── runtime code reads only these constants
```

- Environments with no injected define (tests, other bundles) get the off value; vitest injects a fixed event
  reporting endpoint so the reporting chain can be verified.
- Auto update is decided at Desktop Main startup: `ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED`.
- The Agent's OTLP telemetry keeps the existing mechanism, injected by the packaging environment's
  `ZCODE_PACKAGED_AGENT_OTEL_*`, and is out of scope here.

## Acceptance

1. With a private default config in the internal repo, the build result matches the pre-change one: ARMS, event
   reporting and auto update are all enabled with unchanged addresses.
2. With no private default config and no environment variables, all three are off.
3. Environment variables take priority over the private default config, and an explicit empty string turns off a
   single capability.
4. Typecheck, lint and the related unit tests pass.
