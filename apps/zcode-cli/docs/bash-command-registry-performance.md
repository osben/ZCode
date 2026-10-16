# Bash registry lazy materialization measurements

Measured on 2026-10-16, macOS arm64, Node 26.11.1. Baseline:
`origin/integration` at `9017ed277eb7f6c593b969ad21fb6973aeed462a`.

The generator is `scripts/generate-bash-command-registry.mjs`. Its runtime consumers
are `core/src/tool/handlers/bash-command-permission-policy.ts` (root tuple lookup)
and `core/src/tool/handlers/tool-perf.ts` (public executable membership). The latter
is also imported by Edit/Write and the common tool executor, so eager construction
is paid even without a Bash permission lookup.

## Decision and threshold

The threshold was set before profiling: at least 5% **and** 10 ms lower median
fresh-process CLI startup, with no more than 20 ms higher p95 first Bash latency.
Both final build modes pass. Keep the existing synchronous record API and lazily
parse/cache individual root tuples; do not defer parsing the entire registry to
the first Bash call.

The initial exploratory build omitted the official Zod deduplication plugin. Its
normal CLI improvement was only 3.3%, while minified startup improved 6.1%. Those
runs motivated the production-equivalent measurements below; they are not the
final acceptance evidence.

## Method

The profiler builds both variants from the same current source and dependency
outputs. Only the generated registry module is substituted with baseline Git
content versus the current generated file. It uses the CLI's aliases, externals,
Node 22 target, Zod deduplication plugin, and matching minify/keepNames settings.

Each mode has three warmup pairs and 40 measured pairs. Baseline/candidate order
alternates. Every sample uses a new Node process; the OS file cache remains warm.
No compile cache was configured. Other verification commands were kept out of the
measurement window. Results include all samples, median, nearest-rank p95 and the
predefined gate in `results.json`.

Startup is wall time through `zcode.cjs --version`, including process launch,
bundle/module initialization and exit. It is not app-server readiness or TUI
first paint. The Bash harness imports the real handler and `NodeExecutionAdapter`,
then times permission policy creation and the first `git --version` execution,
including the adapter's first shell initialization. It verifies successful output.
It excludes a model request, user approval wait, and protocol transport.

The normal run uses the default shell. The minified run selects a small shell
wrapper that invokes `/bin/bash --noprofile --norc`; the real execution adapter and
shell snapshot lifecycle remain active, while personal shell configuration is
excluded. Shell startup noise should not be attributed to registry parsing.

## Results

All latencies are milliseconds. Heap is decimal MB, without forcing GC, from the
Bash harness immediately after module initialization. It is not total process RSS.

| Measurement                       | Normal baseline | Normal lazy | Minified baseline | Minified lazy |
| --------------------------------- | --------------: | ----------: | ----------------: | ------------: |
| CLI startup median                |          377.97 |      336.28 |            412.44 |        386.87 |
| CLI startup p95                   |          432.92 |      368.05 |            449.06 |        431.14 |
| First policy median               |            1.05 |        1.54 |              0.94 |          1.50 |
| First policy p95                  |            1.69 |        1.68 |              1.04 |          1.75 |
| First Bash median                 |          507.55 |      497.82 |             24.11 |         24.75 |
| First Bash p95                    |          644.98 |      543.62 |             26.77 |         28.57 |
| Heap before first Bash, median MB |           57.55 |       39.26 |             64.23 |         44.78 |

Normal startup saves **41.70 ms / 11.03%**. Minified startup saves
**25.57 ms / 6.20%**, with **1.80 ms** higher first-Bash p95. The approximate
18–19 MB heap reduction is additional evidence, not a replacement for the latency
gate. Do not interpret the normal shell's 101 ms lower p95 as a registry speedup.
Absolute results across the two build modes came from separate runs and should not
be used to compare minification itself.

The generated TypeScript grows from 1,907,004 to 2,125,353 bytes, still below the
3 MiB limit. The measured minified CLI bundle grows by 1,629 bytes (15,214,991 to
15,216,620); the normal bundle shrinks by 213,999 bytes. No runtime dependencies or
file reads are added.

## Correctness evidence

The spec and regression tests preceded the implementation. On the eager baseline,
the two laziness tests failed and the content/permission parity tests passed.

- All 707 root keys and every tuple/alias/option/argument flag/child retain SHA-256
  `beed22c68890d35d502516e8854be9cfe486a109b199be79868aae2e002058eb`.
- 46,296 static command/alias paths preserve suggestions and allow/ask/deny
  evaluation with digest
  `7cc1d6d66044159faad23a5906cf7272790d7bdc6e8f95c7907394ff5c7a29dc`.
- Membership and telemetry leave roots unmaterialized; one lookup caches one root
  and leaves unrelated roots lazy. Repeated lookup preserves object identity.
- Generator output is deterministic, `--check` succeeds, and generated standalone
  output preserves the same full-content digest.
- Existing compound/unsafe/exact/readonly/wrapper and telemetry privacy tests remain
  part of the focused verification. The bundle gate still rejects runtime Fig
  dependencies and recognizes the new embedded representation.

## Reproduce

Run from the repository root with the pinned Node and pnpm, after installing the
workspace lockfile dependencies:

```sh
pnpm exec turbo --skip-infer --cwd apps/zcode-cli run build --filter=@zcode/cli...
node apps/zcode-cli/scripts/profile-bash-command-registry.mjs \
  --baseline 9017ed277eb7f6c593b969ad21fb6973aeed462a \
  --output /tmp/zcode-registry-normal
node apps/zcode-cli/scripts/profile-bash-command-registry.mjs \
  --baseline 9017ed277eb7f6c593b969ad21fb6973aeed462a \
  --minify --controlled-shell --output /tmp/zcode-registry-minified
```

The profiler substitutes only the registry; it does not mutate the checkout or
user settings/databases. It retains bundles and raw measurements in the output
directory for inspection. The controlled shell requires a POSIX host with Bash;
Windows runtime performance and full desktop/SEA startup were not measured.
