import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// Must complete before appARMSBootstrap: desktopEarlyDataBaseDirBootstrap first injects dataBaseDir, then crashDumps is configured.
// remoteCrashReporterEnabled=true means ARMS has taken over remote crash reporting, so do not start the local-only crashReporter.
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, true);
