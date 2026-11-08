import { containsAcpForbiddenLineChar } from "@zcode/shared/acp-launch-rules";
import { quoteShellArgument } from "#src/external-sessions/contract.js";

/**
 * The one line the resume terminal runs: `cd <cwd> && <resumeCommand>`. The cwd is quoted as a single
 * POSIX argument; CR/LF/NUL anywhere are rejected because the line is embedded in a `.command` script.
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
  return `cd ${quoteShellArgument(params.cwd)} && ${params.resumeCommand}`;
}
