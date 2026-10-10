import type { LaunchMarks } from "@zcode/shared";

// Startup timings (epoch ms): T0 process creation / T1 main JS / T2 whenReady. T3 is recorded in loadWindow.
// Keep this in a separate module so it is not coupled to index.js bootstrap side effects (desktopHostProcess also reads these marks).
// process.getCreationTime is an Electron extension to process and is absent in Node environments (including tests), so guard it.
const launchCreatedAt =
  (typeof process.getCreationTime === "function" ? process.getCreationTime() : null) ?? Date.now();
const launchMainStart = Date.now();
let launchAppReady = launchMainStart;

export function markMainLaunchAppReady(): void {
  launchAppReady = Date.now();
}

export function getMainLaunchPartialMarks(): Omit<LaunchMarks, "loadUrl"> {
  return { createdAt: launchCreatedAt, mainStart: launchMainStart, appReady: launchAppReady };
}
