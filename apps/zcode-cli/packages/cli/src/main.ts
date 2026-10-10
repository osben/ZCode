import { interceptTuiStderr, isTuiInvocation } from "./tui-stderr.js";
import { interceptKnownRuntimeWarnings } from "./runtime-warnings.js";
import { installStderrConsoleBoundary } from "./protocol-console.js";
import { setCliProcessTitle } from "./process-name.js";
import { applyCliRuntimeEnvSanitization } from "./env.js";
import { ensureSeaRuntimeTools } from "./sea-runtime-tools.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { scheduleCliExitWatchdog } from "./shutdown.js";
import { installCliProcessErrorBoundary } from "./process-errors.js";
import { installProtocolStderrBoundary } from "./protocol-stderr.js";
import { createProtocolProcessLifecycle } from "./protocol-lifecycle.js";
import { isProtocolServerInvocation } from "./arguments.js";

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Storage mode can also run in a Host Worker; do not change the process name for the entire Host.
  if (!argv.includes("--prepare-storage")) setCliProcessTitle();
  // A few paths in the actual zcode CLI process may still read process.env directly.
  // Sanitize NODE_ENV, proxy, and certificate variables injected by the user's shell at
  // the entry point; preserve network variables only for later restoration in Bash/tool subprocesses.
  applyCliRuntimeEnvSanitization(process.env);
  const isProtocol = isProtocolServerInvocation(argv);
  const isTui = isTuiInvocation(argv);
  if (isProtocol) installProtocolStderrBoundary(process.stderr);
  const lifecycle =
    isProtocol && !argv.includes("--prepare-storage")
      ? createProtocolProcessLifecycle()
      : undefined;
  // app-server/agent-server stdout is a strict ZCode Protocol frame channel, so plain
  // output such as third-party SDK console.debug must not write there. Redirect the
  // process-level console to stderr before loading run/bootstrap, or any dependency log
  // line can crash transport JSON parsing. TUI also exclusively owns stdout; the AI SDK's
  // initial notice uses console.info and must be captured on stderr too.
  const restoreConsole =
    isProtocol || isTui ? installStderrConsoleBoundary(process.stderr) : undefined;
  const runtimeWarnings = interceptKnownRuntimeWarnings(process.stderr);
  const tuiStderr = isTui ? interceptTuiStderr(process.stderr) : undefined;
  const stderr = tuiStderr?.passthrough ?? process.stderr;
  const disposeProcessErrorBoundary = isProtocol
    ? installCliProcessErrorBoundary({
        stderr,
        onFatal: (reason) => {
          if (lifecycle)
            lifecycle.requestShutdown(new Error("Uncaught process error", { cause: reason }));
          else process.exit(1);
        },
      })
    : undefined;

  try {
    if (!argv.includes("--prepare-storage"))
      Object.assign(process.env, await ensureSeaRuntimeTools());
    lifecycle?.signal.throwIfAborted();
    const context = {
      argv,
      stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    };
    // plugin-host carries only plugins. Importing run first evaluates Agent, tool
    // registry, and workflow modules, making every MCP subprocess load the full business
    // dependency set even if no AgentRuntime is created.
    if (isPluginHostInvocation(argv)) {
      process.exitCode = await runPluginHostCommand(context, argv.slice(1));
      return;
    }
    if (!argv.includes("--prepare-storage")) {
      const { prepareCliProviderRuntimeEnv } = await import("./provider-runtime-env.js");
      Object.assign(
        process.env,
        await prepareCliProviderRuntimeEnv({
          argv,
          env: process.env,
        }),
      );
    }
    lifecycle?.signal.throwIfAborted();
    const { run } = await import("./run.js");
    lifecycle?.signal.throwIfAborted();
    const exitCode = await run(context, {
      protocolLifecycle: lifecycle,
      protocolInput: lifecycle?.input,
    });

    process.exitCode = exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await waitForPendingWarnings();
    // Keep lifecycle and stderr guards installed until actual exit so late errors cannot recursively write to a broken stream.
    if (lifecycle) {
      await lifecycle.complete(normalizeProcessExitCode(process.exitCode));
    } else {
      if (tuiStderr) {
        tuiStderr.restore();
      }
      runtimeWarnings.restore();
      disposeProcessErrorBoundary?.();
      // plugin-host main() returns after MCP server.connect() completes, but stdio
      // handles are what keep the service alive. The one-shot CLI watchdog must not
      // mistake them for leaks and kill the process.
      const exitCode = normalizeProcessExitCode(process.exitCode);
      if (!isPluginHostInvocation(argv) || exitCode !== 0) {
        scheduleCliExitWatchdog({ exitCode });
      }
      restoreConsole?.();
    }
  }
}

function normalizeProcessExitCode(exitCode: string | number | null | undefined): number {
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  if (typeof exitCode === "string") {
    const parsed = Number(exitCode);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

function waitForPendingWarnings(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
