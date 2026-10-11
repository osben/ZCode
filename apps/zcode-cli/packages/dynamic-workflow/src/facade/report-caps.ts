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

/**
 * Per-run caps for report count, serialized bytes per item, and total serialized bytes. These numbers
 * are the contract; see the top of this module.
 *
 * The resource actually being limited is **bytes** (each item is stored twice on disk: once in a node
 * row and once in an event). Count and per-item byte limits are proxies for it. Together, the three
 * limits bound the worst case to 1 GiB of items per run, or about 2 GiB on disk.
 */
export const REPORT_CAPS = {
  /**
   * Maximum number of `report` items in a run. The previous limit was 256, chosen to match the node
   * cap of 100. After removing the node cap, a fan-out with one report per task could reasonably hit
   * this limit and fail the entire run. Count itself is inexpensive: readers do not load items beyond
   * the display cap into memory (docs/execution-engine.md, “Reading the journal”); total disk usage is
   * controlled by {@link REPORT_CAPS.maxBytesPerRun}.
   */
  maxItemsPerRun: 65_536,
  /**
   * Maximum serialized byte length of one item. The previous limit was 32 KiB. The 1 MiB cap ensures
   * an item fits in one protocol message (16 MiB maximum frame size; board and event-log pages are
   * 4 MiB and must contain at least one item) and leaves headroom for readers loading a complete item.
   * Cold replay and GetWorkflowRun read at most 64 items per request, using up to 64 MiB of transient
   * memory. Larger outputs should use `artifact.file` (20 MiB cap, read in chunks).
   */
  maxItemSerializedBytes: 1024 * 1024,
  /**
   * Maximum total serialized byte length of all items in a run. Without it, 65,536 items × 1 MiB
   * would allow 64 GiB of items (128 GiB on disk). On resume, `sumResultBytes` restores the value from
   * the journal, continuous across resumes.
   */
  maxBytesPerRun: 1024 * 1024 * 1024,
} as const;
