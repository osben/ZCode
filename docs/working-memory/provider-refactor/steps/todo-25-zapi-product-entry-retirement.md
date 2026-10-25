# Todo 25: ZAPI Product Entry and Exclusive Compatibility Retirement

> Status: Completed
>
> Date: 2026-08-27
>
> Prerequisite: Todo 21's ZCode Built-in Config/Registry authority chain; general Provider, Model, Account Family and
> remote workspace model selection semantics are unchanged.

## 1. Product Decision

`builtin:zapi` is no longer a Provider in ZCode products. Settings, model selection, runtime, Telemetry, current
shared types, current docs and tests no longer express ZAPI as an available entry, and Renderer no longer
statically creates a placeholder Provider when the target Host Registry lacks it.

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

- ZAPI removed from `BUILTIN_MODEL_PROVIDER_IDS` and `BuiltinModelProviderId`.
- Settings static ZAPI Preset, empty state, intranet visibility Hook, exclusive icon/name/URL and model selection
  special cases removed.
- ZAPI-only internal gate, Runtime Override, Vite injection and tests removed.
- ZAPI Telemetry tags, Composer family special cases and other runtime hardcoding removed.
- Desktop and CLI Legacy Provider importers discard historical `builtin:zapi` directly (no migration to a Personal
  Provider or Environment Configured Default); the old ZAPI Anthropic Endpoint, model format and Reasoning
  normalization specials are removed.
- Current Design, settings docs and product docs drop the ZAPI entry; Changelog, historical logs and archived plans
  stay as historical evidence.
- Tests that used ZAPI as a Provider ID use neutral test IDs.

General `SystemService.probeIntranet`, the intranet dependency download URL and `INTRANET_MACHINE_HOST` are not ZAPI
and stay.

## 3. Compatibility Boundaries

- No ZAPI alias, hidden entry, Feature Flag or re-enable path.
- Bundled Config has no ZAPI; no tombstone Provider is added.
- A Remote/Active/LKG Release containing `builtin:zapi` is treated as an incompatible whole Release and falls back to
  other compatible candidates (Release decoding rejects the retired ID).
- ZAPI in old physical configs is ignored at the one-time importer boundary (Desktop Legacy Store Reader and CLI
  importer keep only a private retired-ID list and discard ZAPI Provider and default selection before any
  normalization); other Providers migrate as-is.
- The remote ZCode Built-in Release should stop distributing ZAPI; clients never create ghost entries for it.

## 4. Acceptance

- Current source, official config and non-historical docs contain no `builtin:zapi`/`ZAPI` product entry.
- `isBuiltinModelProviderId("builtin:zapi")` returns `false`.
- Settings Preset list has no ZAPI.
- A Legacy Store with ZAPI plus a normal Provider imports only the normal Provider.
- Desktop, Web and Remote Settings consume the target Host Registry and do no ZAPI intranet probing.
- Directed unit tests, `pnpm typecheck` and `pnpm lint` pass.

## 5. Verification Record

Bootstrap directed tests 39/39 and ZAPI Legacy remote authority cases passed; Todo 24's CLI
Provider/Adapter/Bootstrap regression 228/228 passed; root `pnpm lint` 0 errors (34 pre-existing warnings); root
`pnpm typecheck` passed. Root full unit tests were blocked only by 2 unrelated Windows ZIP cases (host missing the
system `zip`; 17/17 passed after isolating a compatible command). Root `pnpm fmt:check` is still blocked by
pre-existing repository binary files and Electron upstream example HTML parse errors; changed files passed the
directed format check.
