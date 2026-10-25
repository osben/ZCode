# Editor Detection: Toolbox Install Locations

## Goal

"Open in Editor" must detect IDEs installed by JetBrains Toolbox and Android Studio, not only apps placed directly in the system-wide install roots.

## Behavior

### macOS

- Every JetBrains product definition (IntelliJ IDEA / IDEA CE, WebStorm, PyCharm, GoLand, PhpStorm, Rider, CLion, RubyMine, DataGrip) and Android Studio declares user-level app bundle candidates in addition to `/Applications`:
  - `~/Applications/<Product>.app` — JetBrains Toolbox 3.x default install location.
  - `~/Applications/JetBrains Toolbox/<Product>.app` — Toolbox custom install subfolder.
- Detection order stays `appPath` first, then `appPathCandidates`; the first path that exists wins. Opening keeps the existing behavior (`command` CLI first, then `open -a <resolved app path>`), so Toolbox-installed IDEs open without new launch mechanics.
- Android Studio is a first-class editor definition (`android-studio`) on macOS and Windows.

### Windows

- JetBrains detection keeps scanning the standalone-installer layout (`<ProgramFiles>\JetBrains\<Product>\bin\<exe>` and the local-programs equivalent) and additionally scans the Toolbox layout `%LOCALAPPDATA%\JetBrains\Toolbox\apps\<app-code>\ch-*\*\bin\<exe>` (bounded scan: app-code directory, channel directory, one version level).
- Toolbox app codes map per product (for example `idea` → `IDEA-U`/`IDEA-C`, `pycharm` → `PyCharm-P`/`PyCharm-C`; single-word products keep their names).
- The JetBrains list on Windows is extended with PhpStorm, Rider, RubyMine, and DataGrip to match the macOS list.
- Android Studio on Windows checks `<ProgramFiles>\Android\Android Studio\bin\studio64.exe`.
- The Windows Explorer entry uses the English display name "File Explorer" instead of a hardcoded localized string; editor names are product names and are not localized per-app-locale.

## Out of scope

- Linux editor definitions and line/column opening (tracked as separable follow-ups in ZCO-12).
- Editor id changes: existing ids stay stable because UI/settings reference them; all additions are new ids or new candidates.

## Compatibility

- Runtime-only detection with the existing in-memory cache (`cachedEditors`); no persisted state, no wire/protocol changes.
