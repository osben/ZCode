# Desktop E2E Runtime Paths Design

## Background

Some Desktop conversation E2E specs, provider replay fixtures and case manifests wrote runtime files to
`/tmp`. On macOS, Node.js and POSIX Bash resolve it to the same directory. On Windows, Node.js resolves
`/tmp` to the current drive root while Git Bash maps it to the Windows user temp directory, so a
cross-process barrier could diverge: the spec created a release file the child Bash never saw.

BG25's product timing was correct. The failure happened before the child Bash tool result, so the child never
received the later coordinator question and the parent never consumed the model-only reply. The fix unifies
the E2E file coordinate system; it does not change the coordinator, the runtime command queue or background
notification semantics.

## Path contract

`.e2e-home` stays the isolated HOME of the whole test process. Case temp files live under the Agent's actual
execution workspace `ZCodeProject`, in `.zcode-e2e/<case>`. Runtime logs confirmed the child's
`workingDirectory` points there, not at the conversation backing workspace:

```text
.e2e-home/
└── ZCodeProject/                    Agent workspace cwd
    └── .zcode-e2e/
        ├── shared/
        └── <case>/                  case-owned runtime files
```

One file has two representations by consumer:

```text
Node/spec/tool input: <native-or-portable absolute workspace>/.zcode-e2e/<case>/file
Bash command:         .zcode-e2e/<case>/file
```

- Node file APIs use native absolute paths.
- Provider tool input (Read/Write/Edit/Glob/Grep and similar) uses forward-slash-normalized absolute paths.
  Windows file APIs accept `C:/...`, so fixtures need no JSON backslash escaping.
- Bash starts in the workspace cwd and uses platform-independent POSIX relative paths, avoiding Windows
  drive, Git Bash mount and TEMP-with-spaces conversions.
- Each case cleans its own directory; shared read-only inputs go in `.zcode-e2e/shared`.

## Replay fixture variables

The replay server takes static `fixtureVariables` and recursively replaces all strings after fixture load and
before request matching. Path fixtures use `{{e2eRuntimeRoot}}`, computed by WDIO from the current
`E2E_HOME_DIR`.

Replacement covers matcher, prompt, tool input, raw SSE body, chunks and events. The existing per-request
`{{latestAgentId}}` stays a dynamic response variable and is not mixed with static path variables.

The replay/capture server and the WDIO worker share artifacts across processes. A writer must write a complete
temp JSON first and then rename it over the target, so a reader never sees a half-written JSON.

```text
fixture JSON
  -> parse
  -> apply static fixtureVariables
  -> request matcher
  -> apply request-derived latestAgentId
  -> replay response
```

## Migration scope

Remove bare `/tmp` from the `packages/desktop/test/e2e` runtime directory:

- formal and manual-review/pending conversation specs;
- case-local and legacy DeepSeek replay fixtures;
- case manifests;
- E2E test data such as the bots harness and unregistered-tool snapshots.

The migration does not change case IDs, setup/action/assert, provider request classification or timing
policy. Unit tests that create real temp directories with `tmpdir()`, and parser samples that never enter the
E2E runtime filesystem, are outside this contract.

## Regression protection and verification

- A replay server unit test first proves static variables take part in matching and reach tool input and raw
  response.
- A path-contract unit test scans `packages/desktop/test/e2e` and forbids committing bare `/tmp` again.
- The fixture checker validates the manifest/provider contract of affected cases.
- Targeted replays cover real file consumers: BG25, BG21, permission, tool-cross-product and others.
- Before finishing: `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck` and `pnpm lint`.

## Non-goals

- No change to desktop continuous, web remote replayable, snapshot, owner/lease or workspace identity
  semantics.
- No new Agent runtime, protocol field or main/relay state.
- No promise to run POSIX Bash fixtures under CMD; Windows Desktop E2E keeps using the existing Git Bash
  resolver.
