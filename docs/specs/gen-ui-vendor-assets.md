# Gen UI vendor assets

## Behavior

Gen UI vendored files are a fixed snapshot: their bytes stay unchanged on checkout on any supported OS. The SHA-256 of each file is checked against `assets/vendor/manifest.json` before copying into runtime assets. Git must not convert line endings in this directory.

## Acceptance

- A Windows checkout preserves the original bytes of `assets/vendor/` files.
- The hash check in `packages/desktop/scripts/gen-ui-runtime-assets.mjs` passes for the vendored files without changing the manifest.
