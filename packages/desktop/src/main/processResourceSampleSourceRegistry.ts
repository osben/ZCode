import { mcpProcessResourceSampleSource } from "./processResourceMcpTelemetrySource.js";
/**
 * Resource sample-source registry.
 *
 * When adding a source, create a source file and add one line to the array below,
 * keeping merge conflicts during parallel development to adjacent lines.
 * Array order does not express dependencies: device-level sources receive same-tick facts through the second-stage `sampleDevice` context.
 */

import { chromiumProcessResourceSampleSource } from "./processResourceChromiumSource.js";
import { cliProcessResourceSampleSource } from "./processResourceCliSource.js";
import { rendererHeapProcessResourceSampleSource } from "./processResourceRendererHeapSource.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { selfHeapProcessResourceSampleSource } from "./processResourceSelfHeapSource.js";
import { systemProcessResourceSampleSource } from "./processResourceSystemSource.js";

export const PROCESS_RESOURCE_SAMPLE_SOURCES: readonly ProcessResourceSampleSource[] = [
  chromiumProcessResourceSampleSource,
  systemProcessResourceSampleSource,
  selfHeapProcessResourceSampleSource,
  rendererHeapProcessResourceSampleSource,
  cliProcessResourceSampleSource,
  mcpProcessResourceSampleSource,
];
