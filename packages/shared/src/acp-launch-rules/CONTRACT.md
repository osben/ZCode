# acp-launch-rules

Pure, browser-safe launch rules for external ACP agent processes (`specs/acp-agent-runtime.md`,
"Launch rules"). One validator is shared by the runtime launch validation
(`@zcode/acp-agent-runtime`), the provider config `acp-agent` complete schema and the settings
bridge, so no layer accepts a launch another layer rejects.

- `command`: non-blank, at most 4096 characters, no NUL/CR/LF.
- `args`: at most 32 strings of at most 4096 characters, no NUL/CR/LF.
- `env` overrides: at most 64; keys match `[A-Za-z_][A-Za-z0-9_]*`; loader/injection keys
  (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`, case-insensitive) may only be deleted
  (`undefined`), never set; values at most 8192 characters without NUL.

Every `describe*Problem` returns `null` or a short English reason. The module has no IO, state or
dependencies; it owns no launch decision beyond accepting or rejecting a value.
