import {
  collectProcessTreePids,
  isSamplablePid,
  ProcessProbeFailure,
  toSample,
  type ProcessProbeSample,
  type ProcessRelation,
} from "./process-probe-shared.js";

/** Linux `USER_HZ`: utime/stime in `/proc/<pid>/stat` use this unit; it is 100 on all supported platforms. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const MS_PER_SECOND = 1_000;
/**
 * Scan `/proc` in batches and stop starting batches after a timeout.
 * A single `Promise.all` of hundreds of readFile calls cannot be cancelled, so on a slow disk it would keep using
 * IO after the sample had already been discarded.
 */
const PROC_READ_BATCH_SIZE = 64;

export interface LinuxProcReaders {
  listProcDirectory: () => Promise<readonly string[]>;
  readProcFile: (path: string) => Promise<string>;
  /** Whether this sample timed out; if true, stop remaining `/proc` reads and report no sample. */
  isExpired?: () => boolean;
}

/**
 * Linux reads `/proc` in two passes: first read every `stat` for ppid, pgid, and CPU time,
 * then read `VmRSS` from `status` only for pids in the target process tree. No processes are started.
 */
export async function sampleLinuxProcessTrees(
  readers: LinuxProcReaders,
  rootPids: readonly number[],
): Promise<ReadonlyMap<number, readonly ProcessProbeSample[]>> {
  const relations = await readLinuxProcessRelations(readers);
  const relationByPid = new Map(relations.map((relation) => [relation.pid, relation]));
  const treePidsByRoot = collectProcessTreePids(relations, rootPids);
  const rssByPid = await readLinuxRssKb(readers, [...treePidsByRoot.values()].flat());
  const trees = new Map<number, readonly ProcessProbeSample[]>();
  for (const [rootPid, treePids] of treePidsByRoot) {
    trees.set(rootPid, buildLinuxSamples(treePids, relationByPid, rssByPid));
  }
  return trees;
}

export async function sampleLinuxProcessGroup(
  readers: LinuxProcReaders,
  processGroupId: number,
): Promise<readonly ProcessProbeSample[]> {
  const relations = await readLinuxProcessRelations(readers);
  const members = relations.filter((relation) => relation.processGroupId === processGroupId);
  const rssByPid = await readLinuxRssKb(
    readers,
    members.map((relation) => relation.pid),
  );
  return buildLinuxSamples(
    members.map((relation) => relation.pid),
    new Map(members.map((relation) => [relation.pid, relation])),
    rssByPid,
  );
}

function buildLinuxSamples(
  pids: readonly number[],
  relationByPid: ReadonlyMap<number, ProcessRelation>,
  rssByPid: ReadonlyMap<number, number>,
): readonly ProcessProbeSample[] {
  return pids.flatMap((pid) => {
    const relation = relationByPid.get(pid);
    const rssKb = rssByPid.get(pid);
    // If a process exits between the two reads, its status file is gone; skip that pid and return the other samples as usual.
    if (!relation || rssKb === undefined) return [];
    return [toSample({ ...relation, rssKb })];
  });
}

async function readLinuxProcessRelations(
  readers: LinuxProcReaders,
): Promise<readonly ProcessRelation[]> {
  let entries: readonly string[];
  try {
    entries = await readers.listProcDirectory();
  } catch (error) {
    throw new ProcessProbeFailure(`/proc 不可读: ${String(error)}`);
  }
  const pids = entries.map(Number).filter(isSamplablePid);
  const relations = await readProcInBatches(readers, pids, async (pid) => {
    let stat: string;
    try {
      stat = await readers.readProcFile(`/proc/${pid}/stat`);
    } catch {
      // If reading one pid fails (usually because the process just exited), skip it without affecting the overall sample.
      return undefined;
    }
    const parsed = parseLinuxStat(stat);
    return parsed ? { pid, ...parsed } : undefined;
  });
  return relations;
}

async function readLinuxRssKb(
  readers: LinuxProcReaders,
  pids: readonly number[],
): Promise<ReadonlyMap<number, number>> {
  const entries = await readProcInBatches(readers, [...new Set(pids)], async (pid) => {
    try {
      const rssKb = parseLinuxVmRssKb(await readers.readProcFile(`/proc/${pid}/status`));
      return rssKb === undefined ? undefined : ([pid, rssKb] as const);
    } catch {
      return undefined;
    }
  });
  return new Map(entries);
}

/** Read `/proc` concurrently in batches, checking for timeout before each batch; stop the scan and report no sample if expired. */
async function readProcInBatches<T>(
  readers: LinuxProcReaders,
  pids: readonly number[],
  read: (pid: number) => Promise<T | undefined>,
): Promise<readonly T[]> {
  const collected: T[] = [];
  for (let offset = 0; offset < pids.length; offset += PROC_READ_BATCH_SIZE) {
    if (readers.isExpired?.()) throw new ProcessProbeFailure("/proc 扫描超时");
    const batch = await Promise.all(pids.slice(offset, offset + PROC_READ_BATCH_SIZE).map(read));
    for (const item of batch) {
      if (item !== undefined) collected.push(item);
    }
  }
  return collected;
}

/** The comm field may contain spaces and parentheses, so split at the last `)`. */
function parseLinuxStat(
  stat: string,
): { cpuTimeMs: number; parentPid: number; processGroupId: number } | undefined {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd === -1) return undefined;
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  // After splitting, fields[0] is state (field 3 of stat), so ppid=1, pgrp=2, utime=11, and stime=12.
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const utimeTicks = Number(fields[11]);
  const stimeTicks = Number(fields[12]);
  if (!Number.isInteger(parentPid) || parentPid < 0 || !Number.isInteger(processGroupId)) {
    return undefined;
  }
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) return undefined;
  return {
    cpuTimeMs: Math.round(
      ((utimeTicks + stimeTicks) / LINUX_CLOCK_TICKS_PER_SECOND) * MS_PER_SECOND,
    ),
    parentPid,
    processGroupId,
  };
}

function parseLinuxVmRssKb(status: string): number | undefined {
  const match = /^VmRSS:\s+(\d+)\s*kB$/mu.exec(status);
  if (!match) return undefined;
  const rssKb = Number(match[1]);
  return Number.isFinite(rssKb) ? rssKb : undefined;
}
