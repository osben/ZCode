/**
 * dream-journal 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { DreamJournalContract } from "./contract.js";

/** Opens one run, snapshots a file before touching it, then finalizes. */
export async function exampleDreamJournal(
  contract: DreamJournalContract,
  memoryRoot: string,
  filePath: string,
): Promise<void> {
  const run = await contract.beginRun({ memoryRoot, trigger: "manual", now: new Date() });
  await run.snapshotBeforeFirstTouch(filePath);
  await run.finalize({ status: "succeeded", now: new Date() });
}
