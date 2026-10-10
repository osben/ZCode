/**
 * Cap constants for `report`.
 *
 * Kept separate from `world-read-caps.ts` because their **enforcement sides differ**: the driver
 * enforces world-read caps (only it can stop producing results, e.g. stop ripgrep at 2,000
 * matches), while the **engine core** enforces report caps (report does not pass through the driver;
 * it is done once journaled by the core). Combining them would suggest the same side enforces both,
 * though in both modules the numbers are part of the contract.
 *
 * Overflow **fails the entire run** (`ReportCapExceeded`) instead of rejecting the node as
 * world-read does. This is about the **rejection channel**, not severity: `report` returns `void`,
 * so the script has nowhere to `catch` the error. Since the author has no recovery path, both
 * limits must be high enough that a reasonable script never reaches them.
 */

/** Per-run report-count and per-item serialized-byte limits. These numbers are part of the contract (see this module's header). */
export const REPORT_CAPS = {
  /** Maximum number of `report` calls in one run. */
  maxItemsPerRun: 256,
  /** Maximum serialized byte length for one item. */
  maxItemSerializedBytes: 32 * 1024,
} as const;
