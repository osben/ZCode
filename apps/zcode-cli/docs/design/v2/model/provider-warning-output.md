# Provider warning output policy

## Background

The stdout of headless `--prompt` is the model answer consumed by users or scripts. stderr carries only
errors ZCode can explain and act on. Compatibility warnings from the Node runtime, provider SDKs and the
AI SDK are dependency-layer diagnostics: they may go to controlled debug logs or test assertions but
must not pollute normal `--prompt` output.

## Output contract

- A successful `--prompt` writes only the final answer or the `--json` payload to stdout.
- stderr keeps ZCode-formatted local errors, provider business errors, cancellation, permission denial
  and verbose stack traces.
- Known, non-actionable dependency warnings are filtered at the CLI entry point: Node TLS environment
  warnings, known Node/loader warnings and the AI SDK Anthropic-compatible thinking budget warning.
- Filtering is exact or narrow. It must not swallow unknown stderr, provider error bodies, permission
  prompts or user command output.
- Where a warning can be avoided at the source, fix the model/provider option in the capability policy.
  For example, Anthropic-compatible thinking mode must declare `budgetTokens` explicitly so the AI SDK
  does not use an implicit default.

## Test coverage

- The CLI warning interceptor covers the Node TLS warning and the AI SDK Anthropic thinking budget
  warning, and proves unknown stderr is preserved unchanged.
- The capability/default policy for the Anthropic-compatible thinking toggle covers `budgetTokens`, so
  GLM/DeepSeek Anthropic-compatible mode does not rely on the AI SDK implicit default budget.
