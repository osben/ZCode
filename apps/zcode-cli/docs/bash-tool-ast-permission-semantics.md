# Bash Tool AST Permission Semantics

## Background

The Bash tool's permission, read-only and concurrency-safety checks must not treat dynamic shell
constructs as plain read-only commands. The typical risk is `ls $(touch out.txt)`: the model
appears to call `ls`, but the shell first executes the `touch` inside the command substitution.

The Bash permission chain therefore parses the Bash AST to recognize command substitution,
process substitution, subshells, pipelines and redirects; complex or unsafely-normalizable
commands fall back to the conservative path and are never auto-allowed as simple read-only
commands.

## Parser choice

- `bash-parser`: the latest npm release is still `0.5.0`, published early, with insufficient
  maintenance activity and modern Bash coverage.
- `tree-sitter` + `tree-sitter-bash`: complete AST node coverage, but the Node bindings are a
  native package; they would add build/prebuild risk to the CLI build and cross-platform install
  chain.
- `web-tree-sitter`: already an indirect TUI dependency, but it is a WASM/web binding without its
  own Bash grammar; putting async WASM init into the core permission path adds runtime complexity.
- `unbash`: a maintained pure-TypeScript Bash AST parser with zero dependencies and a synchronous
  API; its AST structurally distinguishes command/process substitution, redirect, assignment,
  pipeline, and/or and compound shell nodes. Chosen as the parser foundation for Bash permission
  semantics.

## Semantic boundaries

- Permission decisions parse the AST first, then extract a safe top-level simple-command argv.
- On command substitution, process substitution, subshell, function, loop, condition, case,
  here-doc, parse errors or unknown dynamic constructs, the permission matcher falls back open
  and read-only / concurrency-safe return `false`.
- Simple read-only auto-allow no longer keys on the command name alone; it uses a data-driven
  policy: extract the simple-command argv via the AST, then validate argv against per-command
  `safeFlags`. Read-only arguments such as `tree -a`, `tree -L 2` can auto-allow; `tree -o out.txt`
  writes an output file, is not in the safe flags, and must return to the normal approval path.
- Display classification still recognizes top-level `cat`, `rg`, `find`, `ls > out.txt` and
  similar read/search/list commands, but it only serves UI/summary and never grants safety; write
  semantics such as `sed -i*` or `find -exec/-delete` must override the display classification.

## Read-only policy structure

Bash read-only decisions are a multi-layer policy table plus executor, not a single allowlist:

- Main-command safe flag policy: per-command allowed flags and argument types, covering `tree`,
  `sed`, `sort`, `file`, `ps`, `date`, `fd`, `test` and others.
- Command-family subtables merged into the main table: git subcommands, `rg`, `pyright`,
  `docker logs/inspect` and other families maintain their own safe flags.
- Fallback allowlist and glob branches: only allowed when command structure, arguments and dynamic
  traits are all safe.
- Write/execute option deny table: rejects options like `find -delete/-exec/...` that write or
  execute.
- Wider permission semantics — path targets, read/write types, redirects and git internal paths —
  are handled by a separate layer.

ZCode currently implements the core subset needed for Bash read-only auto-allow: AST safety
checks, simple-command restrictions, per-command `safeFlags`, argument type validation, short
flag combinations, `--flag=value`, `--` handling, and `find`/`sed` write-semantics rejection.
Extending to other commands must only change the policy table, never add command-name special
cases to the executor.

## Project-level command prefix permissions

The command prefix registry and the readonly policy above are two independent layers: the
registry only decides which action scope to suggest saving when the user picks "always allow in
this project"; the policy only decides whether one invocation needs no approval. No prefix
registry hit may promote a command to readonly.

The prefix resolver reuses the same `unbash` AST. A safe simple invocation may skip known global
options/values via the build-time Fig registry and save the executable plus a stable
subcommand/action as `"<prefix>:*"`; paths, URLs, file arguments and transient args never enter
the prefix. Wrappers are limited to two layers; saving preserves the wrapper and the user's
original executable token.

These cases all save the trimmed full command as exact instead: parse failure, dynamic
substitution, redirect, unknown compound node, tokens that cannot be serialized unambiguously,
dynamic env assignment, and high-risk shell/deletion/permission-modifying commands without a
stable action boundary. Each approval-requiring invocation of a compound command generates its
own rule, up to five; beyond five, the whole string falls back to exact.

Matching first checks the full raw exact, then does token-boundary prefix/wildcard matching for
AST-safe invocations. `allow` holds only when every approval-requiring invocation is covered by
the rule set; `deny`/`ask` holds when any invocation hits. `npm run:*` therefore must not match
`npm run test && rm -rf ...`, but multiple allow rules can jointly cover a safe compound command.

Full protocol, storage and UI design:
`docs/superpowers/specs/2026-07-13-bash-command-permission-registry-design.md`.
