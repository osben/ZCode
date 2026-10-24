# Local Evaluation Computer Use Helper (Dev Build) Runbook

Key facts about dev Helper builds. The dev Helper build script (`scripts/build-cua-helper-app.mjs`) and the stable signing identity tool (`scripts/ensure-cua-helper-dev-identity.mjs`) live in this repository (z-code); the producer (zcode-cua) repository's `docs/cua-permission-broker/` has additional evaluation-side notes.

## Stable TCC authorization (one-time setup)

Problem: every dev Helper rebuild changes the CDHash, macOS treats it as a new app and requires re-granting Accessibility + Screen Recording, which slows iteration.

Solution (`scripts/ensure-cua-helper-dev-identity.mjs`): create a self-signed certificate `zcode-cua-helper-dev` once and store it in the login keychain. All dev Helpers are then signed with it, so the designated requirement anchors the certificate public key (stable) instead of the CDHash, and TCC authorization persists across rebuilds.

Standard procedure (new machine / first time):

```bash
# Must run in a local GUI terminal (Terminal/ghostty); SSH sessions are rejected by macOS
# ("User interaction is not allowed": keychain writes need a GUI audit session)
cd <z-code repo> && node scripts/ensure-cua-helper-dev-identity.mjs
# Click "Always Trust" when the trust dialog appears. Rebuilds then never prompt for TCC authorization again.
```

SSH/agent collaboration procedure (2026-08-16):

1. Run `node scripts/ensure-cua-helper-dev-identity.mjs` once in any session (including SSH). It generates and persists the key to `~/.zcode/cua-helper-dev-identity/`, then fails the import and prints exact instructions (`import_needs_gui_session`).
2. The user runs `node scripts/ensure-cua-helper-dev-identity.mjs --reimport` in a local GUI terminal. It reuses the key persisted in step 1 (does not regenerate) and completes import + trust.
3. Afterwards `pnpm build:cua-helper:dev` (= `build-cua-helper-app.mjs --allow-unsigned-launcher-local-dev`) signs automatically with the stable identity; build output shows no adhoc warnings. Bare `pnpm build:cua-helper` without the dev flag follows the release artifact path (adhoc temporary packaging, later Developer ID re-signing) and does not use the dev identity.

Protections:

- The build script defaults to rejecting adhoc dev builds when signing with the stable dev identity fails (it prompts for the one-time fix command). When an adhoc build is explicitly needed, set `ZCODE_CUA_HELPER_ALLOW_ADHOC=1` (the script prints a warning that TCC authorization will not be preserved).
- `ZCODE_CUA_ADDON_PATH=<producer>/build/Release/ax_native.node` lets a freshly built producer worktree addon enter the helper package directly. Otherwise the build silently uses the consumer's old addon (compiled at the pinned commit), the producer native fix never enters the package, and a full TCC authorization round is wasted (actual pitfall, 2026-08-16).

## Native module: sharp in the dev Helper (wave-10)

The dev Helper stores the `sharp` native prebuild in `ZCode Computer Use Dev.app/Contents/Resources/node_modules/` (mirroring the product-side D-018 approach; D-018 is commit `f811c910fd`, `fix(desktop): package sharp into ZCode.app for product CUA server`). `require('sharp')` returns a function; the RGBA->resize->JPEG pipeline was verified on real hardware in wave-10. Fix script: `scripts/build-cua-helper-app.mjs`. The earlier symptom was `require('sharp')` failing inside the dev Helper so the screenshot backend could not resize/encode.
