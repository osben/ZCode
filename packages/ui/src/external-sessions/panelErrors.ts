/**
 * Single error path for the transcript dialog and the row menu. A rejected task is reported exactly once and
 * never escapes, so callers can fire it with `void` without an unhandled rejection.
 */
export async function runWithErrorReport(
  task: () => Promise<void>,
  report: (error: unknown) => void,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    report(error);
  }
}
