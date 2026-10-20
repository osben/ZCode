import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

describe("telemetry service registration", () => {
  // Bugfix: under full-suite pre-push concurrency, console output triggered by the module under test's initialization
  // reaches the main process via RPC and occasionally surfaces
  // "EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending",
  // turning a unit test false-red and blocking git push. Console is silenced for this whole test file's lifetime so no
  // background logs remain after afterEach restores.
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const originalEmitWarning = process.emitWarning;
    vi.spyOn(process, "emitWarning").mockImplementation(((...args: unknown[]) => {
      const [warning, second] = args;
      const message = warning instanceof Error ? warning.message : String(warning);
      const warningType =
        typeof second === "string"
          ? second
          : typeof second === "object" && second !== null && "type" in second
            ? String((second as { type?: unknown }).type)
            : undefined;

      // Bugfix: on Windows/Node 24, dynamically loading node:sqlite asynchronously throws an ExperimentalWarning.
      // That warning bypasses the console spy and triggers onUserConsoleLog pending when the Vitest environment closes.
      if (warningType === "ExperimentalWarning" && message.includes("SQLite")) {
        return;
      }

      return (originalEmitWarning as (...warningArgs: unknown[]) => void).apply(process, args);
    }) as typeof process.emitWarning);
  });

  it("does not register app-level telemetry in local services", async () => {
    // Bugfix: this case depends on dynamically importing the Node-side service assembly module.
    // Under full-suite pre-push concurrency, module initialization occasionally exceeds the default 5 seconds and was
    // misjudged as failure, blocking git push. The unit-test timeout is relaxed here,
    // keeping the assertion semantics unchanged and only removing environment-jitter false reds.
    const [{ createLocalServices }, { createServiceDescriptor }] = await Promise.all([
      import("../src/node.js"),
      import("../src/descriptors.js"),
    ]);

    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: resolve(
        import.meta.dirname,
        "../../../config/provider/zcode-builtin.json",
      ),
    });
    const telemetryDescriptor = createServiceDescriptor<{
      reportAppLaunch: unknown;
      reportAppDailyActive: unknown;
    }>("telemetry");
    expect(() => services.get(telemetryDescriptor)).toThrow("Service not registered: telemetry");
  });
});
