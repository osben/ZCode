/**
 * Cap constants for world-read.
 *
 * **Execution belongs to the driver; constants belong in the pure package**, for a reason: only
 * the driver can stop producing results—stopping ripgrep at 2,000 matches is better than
 * materializing a million and measuring afterward. But the constants are part of the contract, not
 * driver internals: engine and compiler tests assert them too. If the number existed only in the
 * driver, tests would need a copy, and eventually the two could disagree.
 *
 * Overflow **rejects the node** (`WorldReadCapExceeded`, which the script can `catch`); never
 * truncate and add a flag. Truncation would give the script a silently incomplete view of the
 * world, which it might then fan out—fan-out is the expensive step.
 */

/** Caps for grep / git.diff / git.log. These numbers are part of the contract (see this module's header). */
export const WORLD_READ_CAPS = {
  /**
   * Maximum matching files for `files.glob`. Previously glob had no cap of its own, so the
   * filesystem port's default for UI tools (100, sorted by descending mtime) silently applied—the
   * exact kind of “silent clamping” this registry is meant to prevent. Every world-read cap must be
   * named here.
   */
  globMaxFiles: 2000,
  /** Maximum number of matches for `files.grep`. */
  grepMaxMatches: 2000,
  /** Maximum serialized bytes for `files.grep` results (reject at whichever comes first: this or the match-count cap). */
  grepMaxSerializedBytes: 256 * 1024,
  /** Maximum bytes in `git.diff` output. */
  gitDiffMaxBytes: 512 * 1024,
  /** Maximum requested entry count for `git.log`; reject structurally if exceeded instead of silently clamping. */
  gitLogMaxCount: 100,
  /** Number of entries for `git.log` when count is unspecified. */
  gitLogDefaultCount: 20,
  /** Maximum bytes for `world.run` stdout (reject without truncating, probe at cap+1). */
  runStdoutMaxBytes: 256 * 1024,
  /** Maximum bytes for `world.run` stderr (same behavior). */
  runStderrMaxBytes: 256 * 1024,
  /** Wall-clock timeout (ms) for `world.run` when timeoutMs is unspecified. **No upper clamp**: supports genuinely long-running tests. */
  runDefaultTimeoutMs: 300_000,
} as const;
