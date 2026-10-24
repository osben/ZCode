# Computer Use producer detection

## Rule

The real Computer Use implementation comes from the workspace package `@zcode/zcode-cua` (the producer). The
open-source export replaces it with a placeholder `packages/zcode-cua` that declares
`zcodeCuaPlaceholder: true` in `package.json`, with every capability fail-closed.

The placeholder keeps the public `build` and `tsconfig.json` entries, and the build checks only the bundled type
declarations. The log callback's traceId and parameter types match the real producer, so public callers need
not branch on distribution. The `vitest.config.ts` referenced by root unit tests must also exist and runs the
placeholder execution entry and the broker unavailable-contract tests.

Steps in development, build and packaging that serve only the real Computer Use must first detect the real
producer and are skipped otherwise; an entry of the open-source tree must not fail for lack of private
artifacts:

| Step | Location |
| --- | --- |
| Dev launch builds the macOS Helper and injects Helper environment variables | `scripts/dev-desktop-env.mjs` |
| Dev-time staging of the Computer Use plugin's native dependency (Sharp) | `scripts/stage-dev-cua-plugin-runtime.mjs` |
| Windows runtime resource preparation `prepare:windows-cua-helper` | `packages/desktop/scripts/prepare-runtime-assets.mjs` |
| Packaging bundles macOS Helper and Windows Helper resources, and verifies and finalizes the packaged Helper | `packages/desktop/electron-builder.config.js` |

Sharp staging and verification still depend on "whether the producer declares a Sharp dependency"
(`isSharpRequiredByComputerUse`), consistent with this detection: the real producer declares Sharp, the
placeholder does not.

## Owner and interface

- Sole decision: `readComputerUseProducer` / `isRealComputerUseProducerInstalled` in
  `packages/desktop/scripts/computer-use-producer.mjs`. It looks upward from the desktop package directory for
  the nearest installed `@zcode/zcode-cua` and reads the manifest's `zcodeCuaPlaceholder` field.
- Build config evaluates synchronously; the decision is a single small synchronous file read.

## Acceptance

1. Closed source (real producer): the steps above behave unchanged.
2. Placeholder: the `pnpm dev:desktop` prepare script loads, dev-time plugin runtime staging returns empty,
   Windows prepares no Helper, and packaging neither bundles nor verifies a Helper.
3. Unit test: `packages/desktop/test/placeholderProducerDetection.test.ts` covers real, placeholder and
   not-installed cases and the staging skip.
