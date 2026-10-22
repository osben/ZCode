/**
 * Launch validation and child environment construction.
 *
 * The inherited parent environment is copied with two filters applied:
 * privileged ZCode runtime variables are removed through the shared
 * sanitizer predicate, and secret-named variables are scrubbed by segment
 * (see `SECRET_NAME_RE`). Configuration passed explicitly via
 * `AcpLaunchOptions.env` wins and may re-introduce any name, except loader /
 * injection keys (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`), which an
 * override may only delete.
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
import {
  describeAcpArgsProblem,
  describeAcpCommandProblem,
  describeAcpEnvProblem,
  isAcpLoaderInjectionEnvKey,
} from "@zcode/shared/acp-launch-rules";
import { shouldSanitizeZCodeRuntimeEnvKey } from "@zcode/shared/runtime-env";
import { AcpLaunchValidationError } from "./errors.js";
import type { AcpLaunchOptions } from "./types.js";

/**
 * Secret-looking name segments; matches `AWS_ACCESS_KEY_ID`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, `DB_PASSWORD`, … while leaving names like
 * `MONKEY` or `TOKENIZER` alone (the segment must stand between separators).
 */
const SECRET_NAME_RE =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWORDS|PASSWD|CREDENTIAL|CREDENTIALS|APIKEY)(?:_|$)/i;

/**
 * Validates and normalizes a launch definition; throws `AcpLaunchValidationError`.
 * Command/args/env use the shared launch rules (`@zcode/shared/acp-launch-rules`),
 * the same validator as the provider config schema and the settings bridge.
 */
export function validateLaunchOptions(input: AcpLaunchOptions): AcpLaunchOptions {
  const problem =
    describeAcpCommandProblem(input.command) ??
    describeAcpArgsProblem(input.args) ??
    describeAcpEnvProblem(input.env);
  if (problem) throw new AcpLaunchValidationError(problem);
  if (!isAbsolute(input.cwd)) {
    throw new AcpLaunchValidationError("cwd must be an absolute path");
  }
  if (input.cwd.includes("\0")) {
    throw new AcpLaunchValidationError("cwd must not contain NUL characters");
  }
  const env = input.env ?? {};
  return { ...input, command: input.command.trim(), args: [...input.args], env: { ...env } };
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
    else if (isAcpLoaderInjectionEnvKey(key)) {
      // Explicit overrides win over scrubbing, so this is the last gate that keeps
      // LD_PRELOAD / DYLD_INSERT_LIBRARIES / NODE_OPTIONS out of the agent process.
      throw new AcpLaunchValidationError(`env key "${key}" is a loader/injection variable`);
    } else env[key] = value;
  }
  return env;
}
