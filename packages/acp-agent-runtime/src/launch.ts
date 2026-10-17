/**
 * Launch validation and child environment construction.
 *
 * The inherited parent environment is copied with two filters applied:
 * privileged ZCode runtime variables are removed through the shared
 * sanitizer predicate, and secret-named variables are scrubbed by segment
 * (see `SECRET_NAME_RE`). Configuration passed explicitly via
 * `AcpLaunchOptions.env` always wins and may re-introduce any name.
 *
 * User capability variables (SSH_AUTH_SOCK, KRB5CCNAME, GPG_AGENT_INFO, …)
 * are intentionally inherited: the agent runs unsandboxed as the user with
 * full file access, so stripping the sockets would not create a boundary but
 * would break git/ssh, gpg and Kerberos workflows — parity with ZCode's own
 * runtime tooling (see the inherited login-shell env key patterns in
 * packages/services/src/runtime-tools/runtimeCommandEnv.ts). Callers that
 * want a leaner environment delete them per launch (for example
 * `env: { SSH_AUTH_SOCK: undefined }`).
 */
import { isAbsolute } from "node:path";
import { shouldSanitizeZCodeRuntimeEnvKey } from "@zcode/shared/runtime-env";
import { AcpLaunchValidationError } from "./errors.js";
import type { AcpLaunchOptions } from "./types.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Secret-looking name segments; matches `AWS_ACCESS_KEY_ID`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, `DB_PASSWORD`, … while leaving names like
 * `MONKEY` or `TOKENIZER` alone (the segment must stand between separators).
 */
const SECRET_NAME_RE =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWORDS|PASSWD|CREDENTIAL|CREDENTIALS|APIKEY)(?:_|$)/i;
const LIMITS = {
  command: 4096,
  args: 32,
  argLength: 4096,
  envPairs: 64,
  envValue: 8192,
} as const;

/** Validates and normalizes a launch definition; throws `AcpLaunchValidationError`. */
export function validateLaunchOptions(input: AcpLaunchOptions): AcpLaunchOptions {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command.length === 0) {
    throw new AcpLaunchValidationError("command must be a non-empty string");
  }
  if (command.length > LIMITS.command) {
    throw new AcpLaunchValidationError(`command exceeds ${LIMITS.command} characters`);
  }
  if (command.includes("\0")) {
    throw new AcpLaunchValidationError("command must not contain NUL characters");
  }
  if (!Array.isArray(input.args)) {
    throw new AcpLaunchValidationError("args must be an array of strings");
  }
  if (input.args.length > LIMITS.args) {
    throw new AcpLaunchValidationError(`args must contain at most ${LIMITS.args} entries`);
  }
  for (const arg of input.args) {
    if (typeof arg !== "string") {
      throw new AcpLaunchValidationError("every arg must be a string");
    }
    if (arg.length > LIMITS.argLength) {
      throw new AcpLaunchValidationError(`arg exceeds ${LIMITS.argLength} characters`);
    }
    if (arg.includes("\0")) {
      throw new AcpLaunchValidationError("args must not contain NUL characters");
    }
  }
  const env = input.env ?? {};
  const envEntries = Object.entries(env);
  if (envEntries.length > LIMITS.envPairs) {
    throw new AcpLaunchValidationError(`env must contain at most ${LIMITS.envPairs} entries`);
  }
  for (const [key, value] of envEntries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new AcpLaunchValidationError(`env key "${key}" is not a valid environment name`);
    }
    if (value !== undefined && (typeof value !== "string" || value.length > LIMITS.envValue)) {
      throw new AcpLaunchValidationError(
        `env value for "${key}" must be a string of at most ${LIMITS.envValue} characters`,
      );
    }
  }
  if (!isAbsolute(input.cwd)) {
    throw new AcpLaunchValidationError("cwd must be an absolute path");
  }
  if (input.cwd.includes("\0")) {
    throw new AcpLaunchValidationError("cwd must not contain NUL characters");
  }
  return { ...input, command, args: [...input.args], env: { ...env } };
}

/**
 * Builds the child process environment.
 *
 * 1. Copy the parent env, dropping secret-named variables and undefined values.
 * 2. Apply explicit overrides; `undefined` deletes a key, any string sets it.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    // Same privilege boundary as every other spawned subprocess: a leaked
    // broker socket / authority would let the agent drive the authorized
    // Helper (confused deputy) — see packages/shared/src/runtimeEnv.ts.
    if (shouldSanitizeZCodeRuntimeEnvKey(key)) continue;
    if (SECRET_NAME_RE.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
