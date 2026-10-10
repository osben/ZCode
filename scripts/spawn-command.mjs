import { spawnSync } from "node:child_process";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // On Windows runners, bare `pnpm` / `npm` commands are also provided through cmd shims.
      // Rewriting the command to `pnpm.cmd` first caused some `pnpm exec` cases to use the wrong package cwd,
      // making tsup resolve its entry as scripts/src/... and report "Cannot find src/main/index.ts".
      // Keep the original command and let shell/cmd.exe resolve the shim, avoiding changes to pnpm's package context.
      shell: true,
    };
  }

  return {};
}

// With shell:true, Node joins args with spaces without escaping them (the source of DEP0190).
// On Windows, when a repository path contains spaces (for example E:\Z Code\...), cmd splits the pnpm --dir path at the space,
// truncating it to E:\Z and reporting ENOENT: lstat. Quote arguments containing spaces according to cmd.exe rules;
// leave arguments without spaces unchanged so existing paths and CI behavior are unaffected.
export function quoteArgsForWindowsShell(args) {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

export function runCommand(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    stdio: "inherit",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    encoding: "utf8",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result.stdout;
}
