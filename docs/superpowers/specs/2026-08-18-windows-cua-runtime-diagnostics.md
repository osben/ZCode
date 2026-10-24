# Windows CUA Runtime Diagnostics and the "Stale Install" Trap

Date: 2026-08-18
Status: landed
Related: `docs/cua/windows-product-runtime.md` (the release contract itself)

## 1. Origin and conclusion

The initial reading of this task was "the producer pinned at 72a8487d deleted the Windows host layer". **That
reading was wrong.** The correct conclusion:

> `node_modules/@zcode/zcode-cua` was stuck at a commit older than the pin; the repository source itself was
> fine. After reinstalling from the lockfile, the unchanged source has zero `tsc` errors and
> `prepare:windows-cua-helper` packages normally.

This is recorded because the trap will recur: `@zcode/zcode-cua` is a git dependency and **changing the pin
does not reinstall it automatically**.

## 2. How the misjudgment happened

The audit read `node_modules/@zcode/zcode-cua` as "what the pin points to". The two did not match:

```
pnpm-workspace.yaml  catalog: ...zcode-cua.git#72a8487d   <- declared
pnpm-lock.yaml       resolution: {commit: 72a8487d}       <- locked (consistent)
node_modules/...     <- actually installed: an older commit from 8/10 (inconsistent)
```

The same symbols therefore gave opposite conclusions in the two places:

| Fact | node_modules (old) | producer main@72a8487d (true) |
|---|---|---|
| `package.json.zcodeCuaRuntime` | absent | **present** |
| `dist/windows-helper.js` | absent | **present (checked in)** |
| `WINDOWS_DEV_CONTROL_PROTOCOL` | no export | **present** (`windowsDevHelperMain.ts:17`) |
| controller port in `ports.ts` | absent | **present** (`CuaController*` + take/stop) |

All 8 TS errors came from this, not from a producer regression. Changes built on the wrong premise were fully
reverted by `b99a74dbdf` (the wrongly deleted controller port and the single-source protocol constant import
were restored).

### How to tell (do this first next time)

```sh
# Is the install consistent with the pin: the files field, version or a key artifact is enough to disprove
node -e "console.log(JSON.stringify(require('./node_modules/@zcode/zcode-cua/package.json').zcodeCuaRuntime))"
ls node_modules/@zcode/zcode-cua/dist/windows-helper.js
```

If anything differs from the producer repo at the same SHA, run `pnpm install --frozen-lockfile` first and
**do not** delete interfaces in the consumer to accommodate it. CI installs cleanly from the lockfile every
time, so this illusion appears only locally; changing the repo for it bakes a local environment problem into
code.

## 3. The improvements kept

Both are independent of the misjudgment: they are diagnosability gaps in their own right.

### 3.1 Runtime resolution failure is logged

`resolveWindowsCuaRuntime` has 13 stable failure reasons (`missing-native-addon` /
`artifact-integrity-mismatch` / `incompatible-runtime-manifest` ...). Previously `createWindowsCuaHelperHost`
passed all of them to the caller unchanged and swallowed them: the user saw only "not loaded" in settings.

```
start() ──▶ getHost ──▶ resolveRuntime() ──✗ reject
                             │                 │
                             │                 └─▶ logger.error(reason, artifact, …)  <- new
                             ▼
                        (rejection cached)
start() again ──▶ reuses the same promise ──▶ no duplicate log
```

- The `catch` wraps only `resolveRuntime()` itself. An `assertActive` throw in the later `then` is a `stop()`
  race, not a resolution failure, and mixing it into the same log would mislead.
- The payload is only `reason / artifact / errorName / message`. Resolution happens before the token is minted
  and before the named pipe exists, so the payload cannot contain secrets; a test pins this ordering as a
  regression assertion.
- `createWindowsCuaHelperHost` is therefore exported (so tests can inject a logger and a stub host).

### 3.2 Build-time contract errors identify themselves

`readProducerRuntimeContract` used to pack eleven conditions into one `if` and threw only
`invalid zcodeCuaRuntime Windows artifact path contract`. It is now split into per-condition checks, and the
error carries **package@version, source directory and the specific unmet item** (`zcodeCuaRuntime` missing /
wrong `schema` / illegal path).

The incident proves the value: had the error said "`@zcode/zcode-cua@0.5.2` at `<path>`: `zcodeCuaRuntime is
missing`", the stale install would have surfaced immediately instead of being misread as a producer
regression.

### 3.3 Standard dev start supplies the Windows runtime root

`scripts/dev-desktop-env.mjs` always injected `ZCODE_CUA_BUNDLED_HELPER_APP_PATH` for macOS (binding the
Helper.app built from this checkout) and nothing for Windows. The host then fell into the product branch and
read `process.resourcesPath`; in dev that is `node_modules/electron/dist/resources`, which holds only
`default_app.asar`:

```
                     ┌ macOS: ZCODE_CUA_BUNDLED_HELPER_APP_PATH → Helper.app in the checkout  OK
pnpm dev:desktop ────┤
                     └ Windows: no injection → resourcesPath = electron/dist/resources
                                        → no tools/cua-helper → invalid-runtime-manifest  FAIL
```

Windows computer use was therefore always unavailable in a standard dev start unless the developer remembered
to set `ZCODE_CUA_DEV_ROOT` (written in `docs/cua/windows-source-development.md`, a source-development manual
not everyone running dev reads).

The new `scripts/dev-desktop-cua-env.mjs` defaults `ZCODE_CUA_DEV_ROOT` to
`<repo>/node_modules/@zcode/zcode-cua`, the version the catalog pin points to and the same source as product
staging. Boundaries:

- An explicit developer value is **always** respected (pointing at one's own producer checkout is unchanged);
  pure whitespace counts as unset, consistent with the runtime side.
- Only the dev launch script's default is added; the runtime side's existing boundary stays ("only
  `ZCODE_CUA_DEV_ROOT`, no search of neighboring directories, no fallback to installed package resources").
- It relies on the repo `.npmrc` `node-linker=hoisted` so the path is a physical directory. With an isolated
  linker it is a symlink and resolution fails closed as `development-root-not-found`, with the reason logged
  by 3.1.

## 4. Reviewed and confirmed "not a gap"

- **The orphan reaper runs only on darwin**: correct. Windows child processes have a `--parent-pid` watchdog
  fallback and need no boot-time sweep.
- **The installer is darwin-only**: correct. Windows uses `resources/tools/cua-helper` inside the installer
  package and has no download source.
- **The Windows settings surface has only the switch**: locked by
  `2026-08-17-cua-settings-surface-minimization.md`. Surfacing the runtime reason end-to-end in the UI would
  overturn that spec, needs separate review, and was not done here.
