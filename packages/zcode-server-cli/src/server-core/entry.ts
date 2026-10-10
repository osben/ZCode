import { runServerCore } from "./core.js";

const generation = Number(process.argv[2] ?? 0);
void runServerCore(generation).catch((error: unknown) => {
  // As with core.ts shutdown, startup failure often happens after partial service initialization
  // (SQLite, intervals, etc. still hold event-loop handles). Setting only exitCode leaves the process hanging;
  // Supervisor never receives an exit event to apply crash backoff, and status stays stuck at starting.
  // Exit explicitly after sending the fatal message (or when there is no IPC channel).
  const exit = (): void => process.exit(1);
  if (typeof process.send !== "function" || process.connected === false) {
    exit();
    return;
  }
  try {
    process.send(
      { type: "fatal", message: error instanceof Error ? error.message : String(error) },
      exit,
    );
  } catch {
    // The parent may disconnect IPC at the same time startup fails; do not wait for a fatal callback that will never arrive.
    exit();
  }
});
