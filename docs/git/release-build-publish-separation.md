# Release Build and Release Metadata Separation

## Purpose

Installer package, signing, notarization, blockmap and Electron Builder generated `latest.yml` are completed at build stage. Release notes are directly edited by infra through API in shared directory update manifest; z-code CI manual confirmation only decides whether to continue upload/release, no longer reads repository changelog or rewrites update manifest.

## Current CI Sequence

```text
pnpm release (default release-it)
   version + CHANGELOG.md + release commit/tag/push
   |
   v
commit/tag
   |
   +--> build:macos/windows/linux
   |      installer + blockmap + basic latest.yml
   |      candidate artifacts in shared directory keep releaseNotes uninjected
   |
   v
release:approve <--- infra completes log editing then manual release
          |
          v
release:validate
   validate six platform update YAML, logs, installer summaries and remote components
          |
          v
release:upload:* (RELEASE_ARTIFACT_MODE=publish)
          |
          v
CDN preload -> gray publish -> stable publish
```

Before `release:approve`, formal OSS upload or release API is not called. Installer packages are saved in CI runner shared directory; after approve release, validate is executed first, and after validation passes, upload job reads shared directory content.

## release-it Boundary

`pnpm release` only runs default release capability in `.release-it.mjs` and `@release-it/conventional-changelog`: update version, maintain root `CHANGELOG.md`, create release commit/tag and push. Repository no longer mounts AI rewriting, Feishu review or local `changelogs/vX.Y.Z*.md` generation plugins for release-it; CI release chain no longer consumes root `CHANGELOG.md`.

Log editing is done by infra and directly written into `latest.yml` in runner shared directory. After all builds completed and infra completes log editing, release owner passes `release:approve` manual gate; subsequently `release:validate` automatically uniformly checks versions on six platforms, non-empty logs, update YAML references, file sizes and summaries, and requires remote manifest to precisely contain `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` four platforms and internal `platformArch` consistent with filename. Only after integrity check passes, each platform upload job reads latest content from shared directory and uploads.

`build:remote:assets` only cleans old `manifest-*.json` and `components/` in shared release root directory before collecting current version each time, does not touch `macos-*`, `windows-*`, `linux-*` directories written by parallel platform builds. Thus same version retry will not mix last remote manifest or components into current candidate set.

## Key Files

- `scripts/ci-collect-artifacts.mjs`: only collects and corrects basic artifacts, no longer injects release notes.
- `scripts/validate-release-artifacts.mjs`: after approve release, before upload validates integrity of six platforms and remote assets.
- `scripts/upload-oss.sh`: formal upload uses `RELEASE_ARTIFACT_MODE=publish`, reads manifest edited by infra from shared directory; fails closed when top-level `releaseNotes: |-` is missing.
- `.gitlab/ci/50-release.yml`: `release:approve` confirms infra log is ready, then `release:validate` provides unified integrity gate, each platform upload job depends on validate.

## Failures and Retries

- Infra has not yet written log into `latest.yml` in shared directory: do not click approve; if released prematurely, validate stage rejects release.
- Version, referenced files, size, sha512, remote manifest four-platform set or remote component any inconsistency: validate stage rejects release.
- Single platform upload failure: no need to rebuild; retry corresponding upload job from same shared candidate directory.
