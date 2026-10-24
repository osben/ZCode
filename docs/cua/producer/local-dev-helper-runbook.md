# Local Computer Use Helper (dev build) runbook

This note records the key facts for dev Helper builds. The dev Helper build scripts, SEA packaging and TCC
persistence flow live in the z-code-toolset repo; the full flow is in its
`docs/refactor-port-specs/DEV-HELPER-TCC-RUNBOOK.md` and `docs/cua-permission-broker/`. This file lists only
cross-repo facts that affect evaluation.

## Stable TCC grant (one-time setup, no re-grant per rebuild)

**Problem:** the dev Helper's CDHash changes on every rebuild, macOS treats it as a new app and asks again for
Accessibility + Screen Recording, so development iteration needs manual re-authorization every round.

**Solution** (z-code `scripts/ensure-cua-helper-dev-identity.mjs`): create a self-signed certificate
`zcode-cua-helper-dev` once in the login keychain; all dev Helpers are signed with it, so the designated
requirement anchors on the certificate public key (stable) rather than the CDHash, and **the TCC grant
persists across rebuilds**.

**Standard flow** (new machine / first time):

```bash
# Must run in a local GUI terminal (Terminal/ghostty); an SSH session is refused by macOS
# ("User interaction is not allowed": keychain writes need a GUI audit session)
cd <z-code repo> && node scripts/ensure-cua-helper-dev-identity.mjs
# Click "Always Trust" in the trust dialog. After that, rebuilds never prompt for TCC again.
```

**Collaboration flow for SSH/agent sessions:**

1. Any session (including SSH) runs `node scripts/ensure-cua-helper-dev-identity.mjs` once. It generates the
   key and **persists** it to `~/.zcode/cua-helper-dev-identity/`, then the import fails with exact guidance
   (`import_needs_gui_session`).
2. The user runs `node scripts/ensure-cua-helper-dev-identity.mjs --reimport` in a **local GUI terminal**; it
   reuses the key persisted in step 1 (not regenerated) and completes import + trust.
3. After that `pnpm build:cua-helper` signs with the stable identity automatically; build output no longer
   shows the adhoc warning.

**Safeguards:**

- The build script prints a conspicuous yellow warning when it falls back to adhoc signing (TCC consequence +
  the one-time fix command); tests can silence it with `ZCODE_CUA_HELPER_QUIET_ADHOC=1`.
- `ZCODE_CUA_ADDON_PATH=<producer>/build/Release/ax_native.node` lets a producer worktree's freshly built addon
  go straight into the helper package. Otherwise the build silently uses the **old addon** in the consumer
  `node_modules` (compiled at the pinned commit), producer native fixes never enter the package, and a TCC
  grant round is wasted before noticing.

## Native module: sharp is packaged into the dev Helper

The dev Helper stages `sharp`'s native prebuild into `ZCode Computer Use.app/Contents/Resources/node_modules/`
(mirroring the product-side D-018). `require('sharp')` returns a function; the functional RGBA -> resize ->
JPEG pipeline is verified on a real machine.

- Fix script: `scripts/build-cua-helper-app.mjs` (z-code-toolset repo).
- Product-side D-018 (commit `f811c910fd`, `fix(desktop): package sharp into ZCode.app for product CUA
  server`) packaged sharp into the product Helper; the same staging logic was added to the dev Helper build
  script to remove the dev/product difference on sharp.
