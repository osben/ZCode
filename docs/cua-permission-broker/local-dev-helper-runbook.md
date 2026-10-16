# Local Evaluation Computer Use Helper (Dev Build) — Runbook

> This note documents key facts about dev Helper builds. The dev Helper build script
> (`scripts/build-cua-helper-app.mjs`) and the stable signing identity tool
> (`scripts/ensure-cua-helper-dev-identity.mjs`) are both in this repository (z-code);
> the producer (zcode-cua) repository's `docs/cua-permission-broker/` directory has additional evaluation-side notes.

## Stable TCC Authorization (One-Time Setup, Eliminate Per-Rebuild Re-Authorization)

**Problem**: After every dev Helper rebuild, the CDHash changes, and macOS treats it as a new app, requiring re-granting
Accessibility + Screen Recording — manual authorization per round during development iterations severely slows speed.

**Solution** (z-code repo `scripts/ensure-cua-helper-dev-identity.mjs`): Create a self-signed certificate `zcode-cua-helper-dev` once and store it in the login keychain; from then on, all dev Helpers are signed with it → the designated requirement anchors the certificate public key (stable) rather than the CDHash → **TCC authorization persists across rebuilds**.

**Standard procedure** (new machine / first time):

```bash
# ⚠️ Must run in a local GUI terminal (Terminal/ghostty), SSH sessions will be rejected by macOS
#    ("User interaction is not allowed" — keychain write operations require a GUI audit session)
cd <z-code repo> && node scripts/ensure-cua-helper-dev-identity.mjs
# Click "Always Trust" when the trust dialog appears. After this, rebuilds will never prompt for TCC authorization again.
```

**Collaboration procedure for SSH/agent sessions** (solidified 2026-08-16):

1. Run `node scripts/ensure-cua-helper-dev-identity.mjs` once in any session (including SSH) —
   it generates and persists the key to `~/.zcode/cua-helper-dev-identity/`, then fails the import and provides exact instructions (`import_needs_gui_session`).
2. The user runs `node scripts/ensure-cua-helper-dev-identity.mjs --reimport` in a **local GUI terminal** — reuses the same key persisted in step 1 (does not regenerate), completing import + trust.
3. After that, `pnpm build:cua-helper:dev` (= `build-cua-helper-app.mjs --allow-unsigned-launcher-local-dev`) automatically signs with the stable identity; build outputs no longer show adhoc warnings. Note: bare `pnpm build:cua-helper` without the dev flag follows the release artifact path (adhoc temporary packaging, subsequent Developer ID re-signing), and does not use the dev identity.

**Protections** (solidified in parallel):

- The build script defaults to **rejecting** adhoc dev builds when signing with the stable dev identity fails (prompting to
  use the one-time fix command); when an adhoc build is explicitly needed, set `ZCODE_CUA_HELPER_ALLOW_ADHOC=1`
  (the script simultaneously prints a warning that TCC authorization will not be preserved).
- `ZCODE_CUA_ADDON_PATH=<producer>/build/Release/ax_native.node` allows the freshly-built producer
  worktree addon to enter the helper package directly — otherwise the build silently uses the consumer's **old addon** (compiled at the pinned commit), and the producer native fix never enters the package, wasting a full round of TCC authorization to discover (actual pitfall on 2026-08-16).

## Native Module:sharp Correctly Included in Dev Helper (wave-10)

The dev Helper now stores the `sharp` native prebuild in
`ZCode Computer Use Dev.app/Contents/Resources/node_modules/` (mirroring the product-side D-018 approach).
`require('sharp')` returns a function; the RGBA→resize→JPEG functional pipeline has been verified on actual hardware.

- Fix script: `scripts/build-cua-helper-app.mjs` (z-code-toolset repo).
- Previous symptom: `require('sharp')` fails inside the dev Helper, the screenshot backend cannot run resize / encoding.
- Verification standard: wave-10 actual hardware testing, the RGBA→resize→JPEG functional pipeline passes.

> Historical background: The product-side D-018 (commit `f811c910fd`, `fix(desktop): package sharp into ZCode.app for product CUA server`) has packaged sharp into the product Helper; wave-10 adds the same storage logic to the dev Helper build script, eliminating the dev/product difference with sharp.
