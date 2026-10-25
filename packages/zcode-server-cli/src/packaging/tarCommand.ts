import { existsSync } from "node:fs";
import { join } from "node:path";

// Windows: Git Bash may put GNU tar first on PATH; it treats `C:` in archive arguments as a remote host
// and cannot write a zip archive based on the .zip suffix. Resolve System32 bsdtar explicitly and fail fast if missing instead of falling back to
// PATH. Non-Windows hosts return "tar" from PATH; System32 is a Windows implementation detail only.
export function resolveHostTarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const system32Tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (!existsSync(system32Tar)) {
    throw new Error(
      `System32 tar.exe missing (${system32Tar}); Windows staging requires the OS-bundled bsdtar`,
    );
  }
  return system32Tar;
}

/** COPYFILE_DISABLE detection must match both a bare `tar` and an absolute System32 tar.exe path. */
export function isTarCommand(command: string): boolean {
  return command === "tar" || command.endsWith("\\tar.exe") || command.endsWith("/tar");
}
