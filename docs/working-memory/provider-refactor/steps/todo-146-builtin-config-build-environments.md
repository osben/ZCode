# Todo146: Package Built-in Provider config per product environment

Status: implemented; build verification and review done.

> Later decision: Todo147 makes the production file the single edit source and derives the test-account
> URL and site rules by script. "Two files initially identical" below records the state when this Todo
> finished and no longer requires independent maintenance.

## Decided scope

- The production config stays `config/provider/zcode-builtin.json`; a new `zcode-builtin.test.json` has initially identical content and revision, and may be maintained independently afterwards.
- Chosen at build time by `ZCODE_ENV`; never inferred from branch or `NODE_ENV=production`.
- Desktop, CLI, SEA, HTTP Server, remote Server and Server CLI share one build selection and validation entry.
- The output resource path and runtime Schema are unchanged; no Overlay, no personal-config migration, no online config publish.
- Reusing old CLI JS must also refresh the config; Turbo cache records the environment and config inputs. The remote tar keeps reusing the existing content hash; no duplicate cache is built.

Detailed contract: [dual-environment packaging](../../../builtin-provider-config-build-environments.md).

## Verification (2026-09-14)

- Different environments, and content changes within one environment, reach the final config resource / embedded artifact; missing, corrupt JSON or Schema errors fail the build without silently using the other file; reused JS, SEA resource, Desktop and Server entries are covered; dev and packaged paths are correct; both real configs decode fully.
- 13 new build-contract tests (temporary Release with different content, environment selection, missing/corrupt, same-environment update, refresh after reused JS, real CLI build, SEA resource, execution of the tsup config after it is itself bundled), wrapped as Vitest cases; 11 related Vitest files / 103 cases pass; typecheck, format and architecture checks pass; lint 0 errors / 42 existing warnings.
- CLI build / SEA existing tests: 50 pass, 1 pre-existing failure (the SEA/TUI extraction closure lacks `@zcode/shared/src/index.ts`), reproduced on a clean `hotfix/3.12.2` baseline and not widened here.
- Real builds passed: CLI desktop-agent, Desktop main/host/preload/scheduler, HTTP Server, remote Server, Server CLI. The final CLI sidecar JSON is byte-identical to the selected source; the three Server final JS files embed strings identical to the selected JSON. Turbo dry-run shows both configs and the shared tool in inputs with different hashes for test/production; the cache declaration widens only the two CLI bundling tasks.
- Real-run finding: tsup inlined the config dependency and relocated `import.meta.dirname`; fixed by dynamically loading the shared build tool plus a real config-loader regression (no reliance on read-only path inference).
- Both configs are revision 26 with byte SHA-256 `9aae91bac60f689edf8265806aba2317f1eac12b5793f32be14bdac462651e2d`.
- Review: runtime environment injection, online-update priority, user data and continuous/replayable message chains are unchanged. Not run: full signed macOS/Windows installers, full SEA executable, real-machine install acceptance. No UI change, no new desktop E2E. Not pushed; no remote config published.
