/**
 * Launch rules for external ACP agent processes: one browser-safe validator
 * shared by the runtime launch validation (`@zcode/acp-agent-runtime`), the
 * provider config `acp-agent` complete schema and the settings bridge, so a
 * value accepted by one layer is never rejected (or, worse, accepted) by
 * another. Contract: specs/acp-agent-runtime.md ("Launch rules"), CONTRACT.md.
 *
 * Every `describe*Problem` returns `null` when the value is acceptable and a
 * short English reason otherwise.
 */

export const ACP_LAUNCH_LIMITS = Object.freeze({
  command: 4096,
  args: 32,
  argLength: 4096,
  envPairs: 64,
  envValue: 8192,
});

export const ACP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * NUL is rejected by the OS; CR/LF are rejected because a line break lets a
 * command or argument escape any line-oriented script it is embedded in (the
 * macOS login helper writes the command line into a shell script).
 */
const FORBIDDEN_LINE_CHARS = ["\0", "\r", "\n"] as const;

export function containsAcpForbiddenLineChar(value: string): boolean {
  return FORBIDDEN_LINE_CHARS.some((char) => value.includes(char));
}

/**
 * Loader, interpreter-startup and exec-hook variables an override may never set. Defence in depth for
 * the launch config, not a sandbox: an agent can still run any program its command is allowed to run.
 * One list for the UI validator and the runtime (`acp-agent-runtime` launch.ts), so both reject the same keys.
 */
const LOADER_ENV_KEY_RE =
  /^(?:LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|ZDOTDIR|ENV|BASH_FUNC_.*|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|GIT_PROXY_COMMAND)$/i;

export function isAcpLoaderInjectionEnvKey(key: string): boolean {
  return LOADER_ENV_KEY_RE.test(key);
}

export function describeAcpCommandProblem(command: unknown): string | null {
  if (typeof command !== "string" || command.trim().length === 0) {
    return "command must be a non-empty string";
  }
  if (command.trim().length > ACP_LAUNCH_LIMITS.command) {
    return `command exceeds ${ACP_LAUNCH_LIMITS.command} characters`;
  }
  if (containsAcpForbiddenLineChar(command)) {
    return "command must not contain NUL, CR or LF characters";
  }
  return null;
}

export function describeAcpArgProblem(arg: unknown): string | null {
  if (typeof arg !== "string") return "every arg must be a string";
  if (arg.length > ACP_LAUNCH_LIMITS.argLength) {
    return `arg exceeds ${ACP_LAUNCH_LIMITS.argLength} characters`;
  }
  if (containsAcpForbiddenLineChar(arg)) {
    return "args must not contain NUL, CR or LF characters";
  }
  return null;
}

export function describeAcpArgsProblem(args: unknown): string | null {
  if (!Array.isArray(args)) return "args must be an array of strings";
  if (args.length > ACP_LAUNCH_LIMITS.args) {
    return `args must contain at most ${ACP_LAUNCH_LIMITS.args} entries`;
  }
  for (const arg of args) {
    const problem = describeAcpArgProblem(arg);
    if (problem) return problem;
  }
  return null;
}

export function describeAcpEnvKeyProblem(key: string): string | null {
  if (!ACP_ENV_KEY_PATTERN.test(key)) {
    return `env key "${key}" is not a valid environment name`;
  }
  if (isAcpLoaderInjectionEnvKey(key)) {
    return `env key "${key}" is a loader/injection variable and cannot be set`;
  }
  return null;
}

export function describeAcpEnvValueProblem(key: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > ACP_LAUNCH_LIMITS.envValue) {
    return `env value for "${key}" must be a string of at most ${ACP_LAUNCH_LIMITS.envValue} characters`;
  }
  if (value.includes("\0")) {
    return `env value for "${key}" must not contain NUL characters`;
  }
  return null;
}

/**
 * Validates explicit env overrides. `undefined` deletes a key from the child
 * env, which is always allowed — including for loader keys — so only the key
 * syntax is checked for it.
 */
export function describeAcpEnvProblem(
  env: Readonly<Record<string, string | undefined>> | null | undefined,
): string | null {
  if (env == null) return null;
  const entries = Object.entries(env);
  if (entries.length > ACP_LAUNCH_LIMITS.envPairs) {
    return `env must contain at most ${ACP_LAUNCH_LIMITS.envPairs} entries`;
  }
  for (const [key, value] of entries) {
    if (value === undefined) {
      if (!ACP_ENV_KEY_PATTERN.test(key)) {
        return `env key "${key}" is not a valid environment name`;
      }
      continue;
    }
    const problem = describeAcpEnvKeyProblem(key) ?? describeAcpEnvValueProblem(key, value);
    if (problem) return problem;
  }
  return null;
}

/** Validates a full launch definition (command, args, env overrides). */
export function describeAcpLaunchProblem(input: {
  readonly command: unknown;
  readonly args: unknown;
  readonly env?: Readonly<Record<string, string | undefined>> | null;
}): string | null {
  return (
    describeAcpCommandProblem(input.command) ??
    describeAcpArgsProblem(input.args) ??
    describeAcpEnvProblem(input.env)
  );
}
