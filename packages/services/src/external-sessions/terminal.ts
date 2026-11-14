import { containsAcpForbiddenLineChar } from "@zcode/shared/acp-launch-rules";
import { quoteShellArgument } from "#src/external-sessions/contract.js";

/**
 * The one line the resume terminal runs: `cd -- <cwd> && <resumeCommand>`. The cwd is quoted as a single
 * POSIX argument. `--` keeps a cwd starting with `-` from being read as a `cd` option, and a leading `-`
 * also gets a `./` prefix because a bare `-` operand still means $OLDPWD after `--`. CR/LF/NUL anywhere
 * are rejected because the line is embedded in a `.command` script.
 */
export function buildResumeCommandLine(params: { cwd: string; resumeCommand: string }): string {
  if (!params.resumeCommand) {
    throw new Error("Session id is not shell-safe; no resume command is available.");
  }
  if (
    containsAcpForbiddenLineChar(params.cwd) ||
    containsAcpForbiddenLineChar(params.resumeCommand)
  ) {
    throw new Error("Resume command line must not contain NUL, CR or LF characters");
  }
  // `cd -- -` still means $OLDPWD, so a leading "-" is made an explicit relative path first.
  const target = params.cwd.startsWith("-") ? `./${params.cwd}` : params.cwd;
  return `cd -- ${quoteShellArgument(target)} && ${params.resumeCommand}`;
}
