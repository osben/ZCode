import { Console } from "node:console";

/**
 * Install a console-output boundary for CLI modes that exclusively own stdout (stdio protocol / TUI).
 *
 * app-server/agent-server stdout can carry only ZCode Protocol NDJSON frames, but
 * third-party SDKs may write plain text through console.*. If output is not separated
 * before loading these dependencies, the Host may parse any log line as JSON or it may
 * overwrite the TUI at its current cursor position.
 */
export function installStderrConsoleBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalConsole = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    globalThis.console = originalConsole;
  };
}
