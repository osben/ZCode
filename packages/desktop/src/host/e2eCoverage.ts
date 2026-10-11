import { mkdirSync } from "node:fs";
import { takeCoverage } from "node:v8";

export function flushHostE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (process.env.ZCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // Main schedules Host shutdown, and Node is not guaranteed to flush on exceptions or forced cleanup.
    // Flush after resources are released so this process isolate's V8 counters are written to disk.
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
