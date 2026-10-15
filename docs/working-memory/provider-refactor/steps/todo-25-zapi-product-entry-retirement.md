# Todo 25: ZAPI Product Entry and Exclusive Compatibility Retirement

> Status: Completed
>
> Date: 2026-08-27
>
> Prerequisite: Based on Todo 21's completed ZCode Built-in Config/Registry authority chain; does not change general Provider, Model,
> Account Family, or remote workspace model selection semantics.

## 1. Product Decision

`builtin:zapi` is no longer a Provider in ZCode products. Settings page, model selection, runtime, Telemetry, current shared types, current documents, and tests
must no longer continue to express ZAPI as an available entry, nor statically create placeholder Providers from Renderer when the target Host Registry lacks it.

The fact chain after deletion is:

```text
ZCode Built-in Release / Personal Config / Account Overlay
                       |
                       v
              Target Host Registry
                       |
                       v
            Settings / Model Selection

Renderer no longer maintains builtin:zapi identity or intranet visibility gate.
```

## 2. Deletion Scope

- Delete ZAPI from current `BUILTIN_MODEL_PROVIDER_IDS` and `BuiltinModelProviderId`;
- Delete settings page static ZAPI Preset, empty state, intranet visibility Hook, exclusive icon/name/URL, and model selection display special cases;
- Delete internal-only gate, Runtime Override, Vite injection, and corresponding tests serving only ZAPI;
- Delete ZAPI Telemetry tags, Composer family special cases, and other runtime hardcoding;
- Desktop and CLI Legacy Provider importer discards historical `builtin:zapi` directly, does not migrate it to Personal Provider
  or Environment Configured Default; accordingly delete old ZAPI Anthropic Endpoint, model format, and Reasoning normalization specials;
- Current Design, settings documentation, and product documents delete ZAPI entry description; Changelog, historical implementation logs, and archived plans continue as historical evidence;
- Tests using ZAPI as any Provider ID use neutral test IDs, avoiding tests continuing to imply product support.

General `SystemService.probeIntranet`, intranet dependency download URL, and `INTRANET_MACHINE_HOST` are not ZAPI, continue retained.

## 3. Compatibility Boundaries

- No ZAPI alias, hidden entry, Feature Flag, or re-enable path provided;
- Bundled Config currently has no ZAPI, no new tombstone Provider added;
- Remote/Active/LKG Release containing `builtin:zapi` treated as incompatible entire Release, falling back to other compatible candidates;
- ZAPI in old physical configs ignored at one-time importer boundary; other Providers migrated as-is;
- Remote ZCode Built-in Release should stop distributing ZAPI. Clients no longer create ghost entries for missing ZAPI.

## 4. Acceptance

- Current source code, official config, and non-historical documents no longer contain `builtin:zapi`/`ZAPI` product entry;
- `isBuiltinModelProviderId("builtin:zapi")` returns `false`;
- Settings Preset list does not contain ZAPI;
- Legacy Store containing both ZAPI and normal Provider when imported, only normal Provider is imported;
- Desktop, Web, and Remote Settings all consume target Host Registry, do not perform ZAPI intranet probing;
- Directed unit tests, `pnpm typecheck`, and `pnpm lint` pass.

## 5. Implementation Results

- Current Built-in identity, Settings Preset, model selection display, Telemetry, and Composer ZAPI deleted;
- ZAPI-exclusive internal-only gate, Renderer Hook, Runtime Override, and Vite injection deleted;
- ZCode Built-in Release decoding rejects Remote, Active, or LKG candidates containing retired ID, preventing remote old configs republishing ZAPI;
- Desktop Legacy Store Reader and CLI importer retain only private retired IDs, and directly discard old ZAPI
  Provider and default selection before any normalization;
- Current Provider, intranet probing, settings page, and model selection documents synchronized, historical logs and Changelog unchanged;
- Bootstrap directed tests 39/39 and ZAPI Legacy remote authority cases passed; Todo 24 consolidated CLI
  Provider/Adapter/Bootstrap regression 228/228 passed;
- Root `pnpm lint` is 0 error (34 pre-existing warnings), root `pnpm typecheck` passed;
- Root full unit tests blocked only by 2 unrelated Windows ZIP cases due to host missing system `zip`; 17/17 passed after isolating compatible command;
- This round's modified files passed directed format check; root `pnpm fmt:check` still blocked by repository pre-existing binary files and Electron upstream example HTML parse errors.
