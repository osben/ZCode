import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const readyMarkerNames = {
  main: ".main-build-ready",
  host: ".host-build-ready",
  preload: ".preload-build-ready",
  // Scheduler is now an independent tsup target, and onSuccess calls this marker script for it too.
  // The old allowlist omitted this target, so production builds failed with unknown target after bundling.
  scheduler: ".scheduler-build-ready",
};

if (!Object.hasOwn(readyMarkerNames, target)) {
  throw new Error(`unknown ready marker target: ${target ?? "<empty>"}`);
}

const readyMarkerPath = resolve(root, "out", readyMarkerNames[target]);

mkdirSync(dirname(readyMarkerPath), { recursive: true });

// tsup's CLI-level onSuccess runs for each sub-build and does not mean the full desktop build is complete.
// Write a separate marker for main, host, and preload so dev.mjs starts Electron only after all three
// are ready.
writeFileSync(readyMarkerPath, `${new Date().toISOString()}\n`, "utf8");
