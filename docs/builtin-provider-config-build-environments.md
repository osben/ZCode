# Built-in provider config two-environment packaging

Day-to-day template and model maintenance lives in the
[maintenance entry](./builtin-provider-maintenance/README.md); this document keeps the
build and environment-selection contract.

## Ownership and boundaries

The build tooling alone owns config selection and reads the existing
`ZCODE_ENV=test|production`. An explicit environment variable wins; when unset, the
repository's existing .env files are read, then default to test. `NODE_ENV` only
selects which set of .env files is read; it does not decide the product environment.
An invalid non-empty ZCODE_ENV is an error.

| Product environment | Repository source file                  |
| ------------------- | --------------------------------------- |
| production          | config/provider/zcode-builtin.json      |
| test                | config/provider/zcode-builtin.test.json |

Both are complete Releases. The production file is the only editing source; the test
file is generated and committed by `pnpm provider:config:sync-test`, and its revision
follows the production file. `pnpm provider:config:check-test` only checks whether the
generated result is stale and writes nothing; it is covered by unit tests. The
Release Schema, personal Overlay, Registry, and account/model selection are
unchanged.

## Test config generation rules (Todo147)

Against `staging_backup@790884b1ce`, only these `zhipu-account` provider model URLs
are rewritten:

| Production Base URL                                        | Test Base URL                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| https://api.z.ai/api/anthropic                             | https://api.z.ai/api/anthropic                             |
| https://open.bigmodel.cn/api/anthropic                     | https://open.bigmodel.cn/api/anthropic                     |
| https://zcode.z.ai/api/v1/zcode-plan/anthropic             | https://zcode.z.ai/api/v1/zcode-plan/anthropic             |
| https://zcode.z.ai/api/v1/off-peak/anthropic               | https://zcode.z.ai/api/v1/off-peak/anthropic               |
| https://zcode.z.ai/api/v1/highspeed/anthropic              | https://zcode.z.ai/api/v1/highspeed/anthropic              |

- Regenerate from the full production config every time; never patch the old test
  config incrementally and never maintain a second copy of model capabilities.
- Manual templates, third-party URLs, key-management links, and other fields are
  preserved as-is; an unknown account URL fails loudly and requires adding a mapping
  — never silently request production.
- For site rules that hit the production URLs above, keep the original rule and
  generate the test-URL rule after it. One rule describes one site; model matching,
  API type, capabilities, Map, and relative order are all inherited. Production rules
  are kept because the manual API templates in the test package still point at the
  production official entry.
- Write the generated file only after full Release validation; no network, no
  user-data migration, no online publishing.
- Builds read only the selected file and never implicitly rewrite source files
  during parallel builds; sync before build, reusing the Todo146 cache inputs.

```text
edit production JSON -> sync script (account URL mapping + derived site rules) -> test JSON
                                | validate the generated result
                                v
                   existing two-environment packaging flow
```

Signing admission additionally adds the exact hostnames `api.z.ai` and `zcode.z.ai`
to the existing adapter; `bigmodel.cn` is already covered by `*.bigmodel.cn`. Do not
widen to all of `*.z.ai`, and do not change other consumers of the shared Family
classification utility. This is independent of the product environment switch and
judges only by actual URL. The account Start/Off-Peak signing exception takes
precedence over the domain; personal/team and explicit plan keys keep their existing
entry.

```text
ZCODE_ENV + the matching complete JSON
             |
             v
shared build entry: select file, full Release decode validation
             |
       +-----+--------------------+
       |                          |
       v                          v
Desktop / CLI / SEA assets   HTTP / Remote / Server CLI embedded constants
       |                          |
       +------------+-------------+
                    v
        existing Built-in Source / Registry
```

Desktop resources remain `resources/config/provider/zcode-builtin.json`; the CLI uses
`dist/provider/zcode-builtin.json`; the SEA key remains
`zcode-provider/zcode-builtin.json`. Server keeps compiling the JSON into constants.
Dev-mode Desktop locates the repository source file through the same compiled
environment. Explicit config path injection keeps its priority.

Read/parse failure terminates the build; cross-environment fallback is forbidden.
Reuse the existing Release decoder; maintain no second schema. Build tooling only
reads local files and never downloads config over the network.

When loading the Release decoder cross-platform, convert the filesystem path to a
`file:` URL before handing it to `tsImport`, so a Windows drive letter is not parsed
as a protocol by the ESM loader. Both environments share this entry point; config
selection, validation, and the no-cross-environment-fallback policy are unchanged.

## Cache and timing

- Regular CLI, Desktop, and Server builds keep the existing flow; no new cache layer.
- bootstrap rebuilds the Agent JS every time, and the same CLI build validates and
  refreshes the config resources beside it, so a Source Server archive cannot carry
  a stale Agent.
- Turbo's CLI build and build:desktop-agent include ZCODE_ENV, the relevant .env
  files, both configs, and the shared build tooling.
- Desktop E2E build fingerprints include the shared tooling and config inputs;
  existing environment fingerprints keep being reused.
- Remote servers already embed the config in JS; the existing source hash / artifact
  hash naturally triggers repackaging when the config changes.
- Never select the environment by overwriting repository source files; parallel
  builds in different environments must use separate worktrees/output directories —
  no new concurrency guarantee is added for writes to the same dist.

Online config publishing, revision/LKG selection, and endpoint isolation are
unchanged: this contract only decides the initial in-package config. The desktop
continuous and mobile shared-host/replayable links have no state, protocol, or
execution-authority changes.

## Verification

Use temporary Releases with different content to distinguish environments, covering
missing/bad JSON/bad schema, environment precedence, rebuilding and refreshing the
config when JS already exists, same-environment content updates, SEA resources, and
the final embedded artifacts. Decode both real configs separately. "The two current
files are identical, so tests pass" does not replace environment-selection
assertions; real model requests are not required.

The shared build entry tests and the test-environment config sync tests are
maintained in separate files: `builtin-provider-build.test.ts` runs only the shared
build contract; `builtin-provider-test-config-sync.test.ts` runs Node tests of the
internal sync script. The latter is excluded together with the sync script and its
script tests; the shared build test is kept as-is in the open-source export — no
patching away parameterized cases, and no skip-on-missing-file in place of
closed-source verification.
