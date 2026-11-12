# cli-memory-diagnostics

Node CLI heap allocation profile recorder, reconstructed from the 3.18.1 binary (`specs/upstream-backport-3.18.1.md`). Format and limits are in `docs/monitoring/memory-diagnostics-log.md`.

Invariants:

- Always on for the protocol agent and only while its resource sampler runs; wired once in `zcode-protocol-entrypoint.ts` through `attachCliMemoryDiagnostics`.
- Shared-data names match the original 3.18.1 app byte for byte: directory `~/.zcode/cli/memory-diagnostics`, file names `memory-<pid>-<uuid>.jsonl`, format `zcode-cli-memory-v1`.
- Best effort: profiler, read or write failures move the recorder to `error` / `budget-exceeded` and never throw into the agent.
- Records hold numbers, low-cardinality enums, bundle function names with line/column, pid, instance id and bundle sha256; never paths outside the bundle, prompts or user content.
