# Desktop dev runtime directory

## Rule and owner

- The macOS dev launch script `packages/desktop/scripts/dev.mjs` designates `.zcode-runtime/desktop-dev` under
  the repo root as the Electron dev copy directory.
- `prepareDevElectronAppBundle` receives the directory through the existing `runtimeRoot` parameter and is
  responsible for creating, verifying and reusing `<Electron version>-<arch>/ZCode Dev.app`.
- The copy keeps the existing app identity and `zcode` protocol declaration; Windows, Linux and packaged-build
  launch logic are unchanged.
- `.zcode-runtime/` is a rebuildable local artifact and must be ignored by `.gitignore`.

## Switch and failure boundary

The launch script uses only the new directory and does not migrate or delete the old cache automatically. When
the new directory does not exist, the existing prepare function creates the copy; creation failure keeps the
existing error propagation and does not fall back to the old directory.

## Acceptance

1. The directory passed by the launch script matches the one in `.gitignore`.
2. The path is still isolated by Electron version and architecture, and the prepare function's cache reuse and
   protocol declaration logic are unchanged.
3. Script syntax check, typecheck, lint and architecture check pass.
