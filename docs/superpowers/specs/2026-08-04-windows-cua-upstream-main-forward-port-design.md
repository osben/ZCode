# Windows CUA Forward Port onto Upstream Main Design

> Date: 2026-08-04
>
> Status: confirmed
>
> Related repositories: `C:\Users\dev\zcode-cua`, `C:\Users\dev\z-code`

## 1. Goal

Take the upstream-merged implementation in the latest `zcode-cua` `origin/main` as the only baseline, and
forward-port the verified Windows UIA, WGC, pointer, clipboard, AUMID and Helper runtime capabilities of the
Windows port branch onto it. Then let the current `z-code` branch consume the new producer commit through an
explicit local producer path, restoring a Windows CUA product chain that can be generated, verified, staged and
packaged from a clean consumer tree. The user asked for no push this round, so the remote Git SHA pin and a
clean install on any machine close only after the producer commit is fetchable from the remote; this round must
not commit an unfetchable SHA or a `file:` local path.

This phase solves only the P0 producer/consumer loop. The Windows settings page, top operation indicator
animation, Esc interruption, user-input invalidation detection, PiP and the UIA-only background mode are
separate later milestones.

## 2. Confirmed repository and history boundaries

- `z-code` keeps changing on the current `feat/cua-helper-app` branch; no new feature branch.
- The `zcode-cua` working baseline is the latest `origin/main`; local `main` is aligned to it and produces the
  new commit directly.
- The Windows port branch `codex/windows-cua-pointer-foundation` stays as the migration source and a safety
  backup.
- The Windows commits forked from the common baseline are squashed into one new commit on top of the latest
  `main`.
- No existing upstream commit is rewritten, rebased or overwritten.
- Both repositories only create local commits, no push.

```text
zcode-cua

common baseline f285ccd8
      |\
      | +-- later upstream work -----------------> latest origin/main
      |
      `---- Windows port, 49 commits ------------> migration source branch

target:

latest origin/main
      |
      `---- one new Windows forward-port commit

z-code

current feat/cua-helper-app
      |
      `---- consume the producer commit above and fix the staging/package contract
```

## 3. Rejected approaches

- **3.1 Rebase the 49 Windows port commits one by one.** Later upstream changes and the Windows branch both
  touch the broker, input cleanup, observation state, native adapter and generated artifacts. Per-commit
  rebase would resolve the same semantic conflict repeatedly and could restore old implementations over later
  upstream security fixes.
- **3.2 Roll the dependency back to `0.3.28`.** It would lose upstream security, incremental-state, PiP and
  product Helper fixes in `0.4.x` and `0.5.x`, and violate "upstream changes prevail".
- **3.3 Only change the version constant in z-code.** The current `0.5.2` producer does not publish
  `dist/windows-helper.js` and lacks the full Windows WGC, pointer and clipboard ABIs; loosening consumer
  checks would disguise missing capabilities as usable product resources.

## 4. Producer design: zcode-cua

### 4.1 Migration principles

The migration re-implements by capability boundary and does not overwrite files mechanically:

1. First write failing tests of the current semantics on the latest `main`.
2. Read the verified Windows behavior and Win32/WGC implementation from the Windows port branch.
3. Wire the behavior into upstream's current broker, incremental state, input cleanup and native loader.
4. On any conflict, upstream's current implementation prevails and only the Windows branch is added.
5. Regenerate `dist/`; do not copy old-branch generated artifacts.

### 4.2 Producer-owned runtime contract

The producer declares the Windows Helper entry and required artifacts in the root `package.json`, with this
machine-readable field:

```json
{
  "zcodeCuaRuntime": {
    "schema": 1,
    "windows": {
      "entry": "dist/windows-helper.js",
      "nativeAddon": "build/Release/ax_native.node"
    }
  }
}
```

Constraints:

- `schema` must equal exactly `1`; an unknown schema fails closed.
- Paths must be `/`-separated canonical relative paths with no `.`/`..`, no absolute paths and no symlink
  escape.
- The package name must still be `@zcode/zcode-cua`.
- The package version is provenance read from the actual producer package, not hard-coded again in the
  consumer.
- The producer commit is still pinned by the full Git SHA in `pnpm-workspace.yaml`; the runtime contract
  cannot replace the Git pin.
- `pnpm build` must generate the Helper entry; `pnpm pack --dry-run` must include the entry, the native build
  source and the JS dependencies the runtime needs.

### 4.3 Windows capabilities

Forward-port these capabilities verified on the old Windows branch:

- UIA apps, windows, element tree and semantic actions;
- canonical executable identity of ordinary Win32 apps;
- AUMID activation and unique HWND/PID resolution for packaged apps;
- WGC display/window capture and the mapping of screenshot bounds to `state_image`;
- move, scroll, drag and mouse down/up in virtual desktop coordinates;
- native async `CF_UNICODETEXT` clipboard read/write;
- Windows Helper entry, named pipe, parent PID, ready/health and termination cleanup;
- package artifacts, focused unit tests and an optional live smoke.

The 30-tool canonical surface is unchanged and no Windows-only MCP tool is added.

### 4.4 Upstream semantics that must be preserved

- incremental/full observation and `state_id` ownership;
- window-bound state isolation and live element re-resolution;
- read/action delivery-state, with no replay of a `possibly_sent` action;
- bounded warmup, refresh marker and cancellation semantics;
- the input hold registry and owned-input cleanup after stop/cancel;
- macOS AX, ScreenCaptureKit, PID-targeted input, PiP and signed Helper behavior;
- Linux AT-SPI behavior;
- the flat canonical 30-tool surface.

## 5. Consumer design: z-code

### 5.1 Staging

`packages/desktop/scripts/windows-cua-helper-assets.mjs` reads the entry and native addon from the pinned Git
dependency's `package.json.zcodeCuaRuntime.windows` and no longer maintains an independent
`0.3.28`/`dist/windows-helper.js` truth.

Staging still handles:

- package name, schema, canonical path and supported architecture validation;
- Electron runtime, native PE machine and file type validation;
- a SHA-256 inventory;
- atomic publish after building in a temp directory;
- rejecting links, out-of-bounds paths, missing files and source-file change races.

The generated `runtime-manifest.json` keeps the actual package version, entry, native addon, Electron version,
target triplet and all file digests.

### 5.2 Runtime resolver

`windowsCuaDevRuntime.ts` validates the development directory and product resources with the same producer
contract/manifest schema. The product runtime trusts only the app `resources/tools/cua-helper`;
`ZCODE_CUA_DEV_ROOT` is only an explicit local development override, with no scan of neighboring directories
and no download of resources.

### 5.3 Clean checkout

`prepare-runtime-assets.mjs` must include Windows CUA staging in the Windows local and official build resource
preparation flow and must not depend on historical `bundled-tools` files ignored by `.gitignore`.

```text
pnpm install (pinned producer SHA)
        |
        v
read producer runtime contract
        |
        +-- build/source artifacts missing --> fail closed
        |
        v
verify native / Electron / target arch
        |
        v
generate a staged runtime with digests
        |
        v
electron-builder -> resources/tools/cua-helper
        |
        v
desktop local Host starts the Windows Helper on demand
```

## 6. Lifecycle and mode boundary

```text
desktop-local + win32 + official plugin enabled
        |
        v
Host resolves verified packaged runtime
        |
        v
spawn Electron Node child
  argv: entry / socket / parent-pid
  env : bearer token (never in argv/logs)
        |
        v
ready + health exact PID evidence
        |
        v
Agent receives broker credentials
        |
        v
30-tool continuous local CUA

SSH / WSL / Docker / remote workspace / mobile /remote
        |
        `--> no install, no staging, no separate Windows Helper started
```

This phase does not change desktop `continuous` or web remote `replayable` semantics and adds no remote
runtime, snapshot, queue or owner command.

## 7. Error semantics

| Scenario                                                           | Behavior                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| producer contract missing or schema unsupported                    | build/staging fails closed                                |
| entry/native addon missing                                         | build/staging fails closed                                |
| staged digest, PE arch or Electron mismatch                        | the runtime resolver refuses to start                     |
| WGC unsupported, locked screen, high integrity or minimized window | explicit unavailable, no blank success                    |
| AUMID/exe identity cannot be resolved uniquely                     | rejected before the action, no PID guessing               |
| raw input target is not the unique foreground PID                  | rejected before the action, no auto-activation, no replay |
| clipboard not on the interactive desktop or occupancy timeout      | bounded failure, no PowerShell fallback                   |
| Helper stop/parent exit                                            | stop admission, release owned input, close pipe           |

## 8. Test strategy

Strict RED -> GREEN -> REFACTOR.

### 8.1 zcode-cua

First add failing tests on the latest main for: the package contract and the `windows-helper` export/artifact;
current-main broker + Windows Helper entry; WGC window/display capability and fail-closed state; pointer
foreground PID gate, virtual desktop and cleanup; clipboard capability, bounded retry and exact Unicode
round-trip; AUMID activation, unique HWND/PID and Win32 executable identity; regressions of upstream
incremental state, cancellation, delivery-state and input cleanup. Minimum gates: `pnpm typecheck`,
`pnpm lint`, `pnpm test`, `pnpm rebuild:native`, `pnpm build`, `pnpm pack --dry-run`. The Windows live smoke
(WGC, pointer, clipboard, 30-tool surface) runs after these gates and cannot replace unit/integration tests.

### 8.2 z-code

Change tests first to expect the producer-owned contract and clean staging: `windows-cua-helper-assets.test.ts`
(actual package version/contract, paths, digests), `windowsCuaDevRuntime.test.ts` (manifest and producer
contract, no longer pinned to `0.3.28`), `runtime-asset-scripts.test.ts` (Windows preparation calls CUA
staging), product Helper integration (real child, named pipe, ready/health, clean stop), provenance/version
coherence (both dependency aliases pinned to the same full commit). Minimum gates:
`pnpm exec vitest run packages/desktop/test/windows-cua-helper-assets.test.ts`,
`pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts`,
`pnpm exec vitest run packages/services/test/windowsCuaDevHelperHost.test.ts`,
`pnpm --filter @zcode/zcode-cua-plugin test`, `pnpm typecheck`, `pnpm lint`. Before completion also run
resource preparation and a package smoke from a temp directory with no historical `bundled-tools`.

## 9. Impact Brief

| Field                   | Conclusion                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| Capability              | Computer Use / desktop-local CUA                                  |
| Change layer            | validation, commit-effect, persistence/build artifact             |
| Operating mode          | planning                                                          |
| Main entries            | desktop local Host, official CUA plugin, Windows packaged runtime |
| Explicitly not involved | settings UI, conversation stream, mobile replay, remote runtime   |

### 9.1 Surface/owner

| Scenario                  | Entry                                 | Authority                                    | Commit/side effect          | Mode boundary           |
| ------------------------- | ------------------------------------- | -------------------------------------------- | --------------------------- | ----------------------- |
| Windows desktop local CUA | official plugin + Host                | pinned producer contract + packaged manifest | start a local Helper child  | desktop-continuous only |
| macOS desktop local CUA   | Computer Use settings + signed Helper | signed Helper/TCC                            | install or start Helper.app | unchanged               |
| mobile remote             | `/remote` shared-host attachment      | existing desktop Host                        | pass-through/attach only    | creates no Helper       |

## 10. Case pruning and acceptance

| ID      | Setup                                      | Action                 | Assertions                                                | Status                         |
| ------- | ------------------------------------------ | ---------------------- | --------------------------------------------------------- | ------------------------------ |
| WCFR-01 | clean zcode-cua latest main                | build/package          | contract, entry and native source are all in pack         | accepted                       |
| WCFR-02 | clean z-code checkout + fixed producer SHA | prepare runtime        | no dependence on ignored files, digest manifest generated | accepted                       |
| WCFR-03 | packaged Windows local desktop             | enable official plugin | Helper ready, 30 tools callable, no orphans on exit       | accepted                       |
| WCFR-04 | occluded non-minimized test window         | capture                | WGC returns a non-empty image bound to the HWND           | accepted                       |
| WCFR-05 | minimized/locked/high-IL target            | capture/action         | fail closed, no fake success                              | accepted                       |
| WCFR-06 | foreground target changes before raw input | dispatch               | action rejected and no input sent                         | accepted                       |
| WCFR-07 | Unicode clipboard marker                   | write/read/restore     | exact read-back and original value restored               | accepted                       |
| WCFR-08 | packaged Calculator AUMID                  | open/observe           | unique HWND/PID, later state bound to the same app        | accepted                       |
| WCFR-09 | macOS/Linux build/tests                    | regression             | existing behavior and 30-tool surface unchanged           | accepted                       |
| WCFR-10 | mobile/remote workspace                    | initialize             | no staging or separate Helper started                     | pruned: architecture invariant |

## 11. Commit strategy

- `zcode-cua/main`: one `feat(windows): forward-port CUA runtime onto current main` commit.
- `z-code/feat/cua-helper-app`: the design spec commit and later implementation commits are separate;
  implementation uses Conventional Commits.
- No push, no MR, no tag.

## 12. Definition of done

The Windows settings page milestone starts only when all of these hold:

1. `zcode-cua` latest main + the single Windows forward-port commit passes all required gates.
2. The new producer commit can be consumed by `z-code` through an explicit local producer path.
3. A clean consumer tree generates Windows runtime assets without depending on historical ignored files.
4. The packaged runtime resolver can verify and start the real Helper.
5. WGC, pointer, clipboard, AUMID and 30-tool focused/live evidence are all kept.
6. macOS/Linux and desktop/mobile/remote invariants have no regression.
7. Both repositories have local commits and nothing is pushed.
8. The remote Git SHA pin, the lockfile update and a clean install on any machine are explicitly left until
   after the producer commit is pushed, and must not be faked as passed this round.
