# Linux Arch pacman package

## Goal

Build an additional native Arch Linux package `.pkg.tar.zst` for Linux x64/arm64, reusing the existing Electron
Builder app content; AppImage remains the main Linux auto-update artifact, and deb/rpm are unchanged.

## Boundary

- This phase does not publish PKGBUILD/AUR source recipes; `.pkg.tar.zst` is produced directly by Electron
  Builder.
- App runtime, protocol, Agent, remote control and the auto-update protocol are unchanged.
- The pacman package is a download/install distribution artifact and is not the primary update artifact of
  `latest.yml`.

## Build and release chain

```text
Linux x64/arm64 CI
        |
        v
electron-builder
  |       |       |       |
AppImage deb     rpm     pacman (.pkg.tar.zst)
  |       |       |       |
  +-------+-------+-------+--> artifact collect -> upload -> release validation
        |
        +--> latest.yml primary path remains AppImage
```

## Package contract

- The file name follows the existing naming: `ZCode-<version>-linux-<arch>.pkg.tar.zst`.
- The package name uses the same flavor-isolated name as deb/rpm, so Preview/Production do not overwrite each
  other.
- pacman dependencies are generated from the configured list of Arch official-repository runtime dependencies
  (gtk3, nss, libxss, libxtst, libnotify, alsa-lib, mesa, xdg-utils); install, launch and uninstall smoke tests
  are planned on Arch x64/arm64.
- `.pkg.tar.zst` enters the CI artifact manifest, OSS upload and release metadata but does not replace the
  AppImage update path.

## Client auto-update contract (revised 2026-09-16)

ZCT-2100231841920471040: when 3.12.1 in the Ubuntu deb install form downloaded 3.12.2, the old filter deleted
the deb and left only the AppImage; DebUpdater could not find the file and reading `fileInfo.info` threw. The
old convention "Linux supports auto update only for AppImage" was wrong and is replaced.

- macOS, Windows and every Linux install form follow electron-updater's download, verification and install flow;
  Linux no longer deletes deb/rpm/pacman uniformly.
- The current updater instance is the single source of truth for the install type; ManifestUpdateProvider only
  selects the same-type artifact for the Linux updater, reads no package-type elsewhere and keeps no second
  platform state. AppImageUpdater maps to `.AppImage`, DebUpdater to `.deb`, RpmUpdater to `.rpm`,
  PacmanUpdater to `.pkg.tar.zst` (`.pacman` accepted for compatibility).
- When the manifest lacks the current install type, fail explicitly at the parsing boundary; the updater's
  fallback must not pick another format by mistake. A missing package is an incomplete release, not "this install
  method does not support updates".
- URL suffixes are judged on the pathname, supporting absolute/relative addresses, query parameters and case;
  the real download URL and checksum are kept.
- PacmanUpdater still builds the cache path by the old `.pacman` suffix, and the `info.url` of
  `.pkg.tar.zst` uses the actual file name so a full URL is not concatenated into the cache path; the network
  download URL is unchanged.
- macOS/Windows keep the original manifest parsing semantics, the downloader picks zip/exe; update channels,
  download timing, permissions, install commands, UI and the mobile remote link are unchanged.

```text
server full manifest → current updater instance decides install type → same-type file → download/verify → original platform installer
                                             └─ no same-type package: explicit failure, no cross-format fallback
```

Acceptance: tests must run the Linux install-type matrix on any dev machine, covering mixed manifests,
single-type manifests, missing types, absolute/relative URLs, query, checksums and the Pacman cache path;
macOS/Windows original parsing behavior regression. Live logs and failing tests precede the fix; asserting only
the filter itself is forbidden. A real elevated install still needs a per-system distribution-package smoke
verification.

## Risks and acceptance

- Artifact collection, shared-directory cleanup, OSS globs and release validation must recognize the compound
  suffix `.pkg.tar.zst`.
- Source code, source maps, keys or CI credentials must not enter the package; the existing app.asar trimming
  strategy is kept.
- Verify the pacman package's architecture, dependencies, desktop entry, `zcode://` protocol registration, and
  package identity when coexisting with deb/rpm.
