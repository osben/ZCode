# Ripgrep WASM Packaging

## Background

`Grep` is one of the most commonly used exploration tools in NL->Code. The earlier Node adapter implemented content search with TypeScript file traversal and regex matching; it met the basic contract, but performance on large repositories and the glob/type and multiline/context behavior easily drifted from mature ripgrep.

From v2, the Node adapter of `FileSystemPort.searchText` uses the ripgrep WASM shipped with the npm package by default. This way the ordinary Node CLI, the SEA single-file package and cross-platform releases do not depend on a preinstalled native `rg` command.

## Goals

- `Grep` defaults to the bundled ripgrep WASM, with semantics aligned to ripgrep.
- Core still depends only on `FileSystemPort.searchText` and does not know ripgrep exists.
- No new `ZCODE_` environment variable; search capability is decided by the adapter and the release artifact.
- Both the ordinary npm package and the SEA package include the ripgrep WASM runtime code.
- A JS fallback is kept when WASM is unavailable, so the tool can degrade.

## Non-goals

- Do not call the user's system `rg` through a shell.
- Do not require users to install the native Rust ripgrep command.
- Do not introduce `fs`, `child_process` or WASI details into core/tool handlers.
- Do not pour large search results directly into model context; `head_limit` and the result budget still constrain it.

## Dependencies and boundaries

The Node adapter depends on `ripgrep@0.3.1`. This package exports the WASM ripgrep API as ESM, with the WASM bytecode embedded in the package and no platform-native binary.

Dependency boundaries:

- `@zcode/adapters` imports and calls the WASM ripgrep.
- `@zcode/contracts` only defines the `FileSystemPort.searchText` input/output and error contract.
- `@zcode/core` only calls the port and does not depend on ripgrep arguments, WASI, package paths or packaging details.

## Search argument mapping

| `FileSystemSearchTextRequest`                | ripgrep WASM arguments                                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern`                                    | `-e <pattern>`, so a pattern beginning with `-` is not parsed as a flag.                                                                                                                                          |
| `path`                                       | Search target under the WASI preopen root.                                                                                                                                                                        |
| `glob`                                       | `--glob <glob>`.                                                                                                                                                                                                  |
| `type`                                       | The adapter converts it to a ripgrep `--glob` extension filter and re-validates with `matchesFileType` after parsing results, so differences in ripgrep's built-in type aliases do not affect the contract.       |
| `ignoreCase`                                 | `-i`.                                                                                                                                                                                                             |
| `multiline`                                  | `--multiline --multiline-dotall`.                                                                                                                                                                                 |
| `outputMode: "content"`                      | `--json`, parse match/context events.                                                                                                                                                                             |
| `outputMode: "files_with_matches"`           | `--count`, then derive the file list and match count from non-zero counts.                                                                                                                                        |
| `outputMode: "count"`                        | `--count`.                                                                                                                                                                                                        |
| `beforeContext` / `afterContext` / `context` | `-B` / `-A` / `-C`.                                                                                                                                                                                               |
| VCS directories                              | The adapter appends globs excluding `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`.                                                                                                                                  |

`headLimit` and `offset` are still applied on the adapter side, keeping truncation semantics consistent across the three output modes.

## Packaging

The ordinary packaging path must let the bundler resolve `ripgrep` and its internal WASM ESM module. Build verification should cover the `packages/cli` bundle.

The SEA packaging path must keep building the single-file package from the standard Node CLI artifact. Because ripgrep WASM is embedded as a JavaScript module, SEA needs no extra platform-native binary copy; if the dependency is later changed to an external `.wasm` file, this spec must first be updated to specify asset copying, runtime location and cross-platform tests.

## Error behavior

- ripgrep exit code `1` means no match: return an empty result, not an error.
- A ripgrep regex parse error maps to `invalid_pattern`.
- ripgrep path, permission or WASI I/O errors map to `not_found`, `permission_denied` or `io_error`.
- When WASM initialization, loading or the runtime is unsupported, the adapter may degrade to the JS fallback; if the fallback also fails, classify by the original error.
- The cancel signal is checked at least before and after the search; the JS fallback must also check between traversal and file reads.

## Test coverage

- Adapter unit tests cover `content`, `files_with_matches`, `count`.
- Cover a pattern beginning with `-`, proving the implementation uses `-e`.
- Cover `glob`, `type`, `ignoreCase`, `context`, `multiline`.
- Cover the mapping of ripgrep invalid regex to `invalid_pattern`.
- Cover that the ordinary CLI bundle builds; the SEA script tests keep verifying build arguments and asset behavior.
