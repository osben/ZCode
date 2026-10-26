// Pure compare/append logic for the frozen upstream migration gate (specs/upstream-migration-freeze.md).
// No application imports: the tsx collector, node --test, and any future CI wrapper all load this module.

/** Fork-owned migration id: 9NNN_fork_<lowercase>. Everything else is upstream and frozen. */
export const FORK_MIGRATION_ID = /^9\d{3}_fork_[a-z0-9_]+$/;

/** Application-order set labels, also the key order of the baseline file. */
export const SET_ORDER = [
  "cli",
  "tasks_index:base",
  "tasks_index:projects",
  "tasks_index:controller-remote",
  "tasks_index:source-server",
];

/** Static per-set context for failure messages: which shared database and source file to point at. */
export const SET_METADATA = {
  cli: {
    database: "~/.zcode/cli/db/db.sqlite",
    sources: "apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts",
  },
  "tasks_index:base": {
    database: "~/.zcode/v2/tasks-index.sqlite",
    sources: "packages/services/src/session/tasksDatabase/migrations.ts",
  },
  "tasks_index:projects": {
    database: "~/.zcode/v2/tasks-index.sqlite",
    sources: "packages/services/src/project-storage/index.ts",
  },
  "tasks_index:controller-remote": {
    database: "~/.zcode/v2/tasks-index.sqlite",
    sources: "packages/services/src/session/tasksDatabase/controller-remote-schema-v4.ts",
  },
  "tasks_index:source-server": {
    database: "~/.zcode/v2/tasks-index.sqlite",
    sources: "packages/services/src/session/tasksDatabase/source-server-schema-v5.ts",
  },
};

const SPEC = "See specs/upstream-migration-freeze.md.";

export class BaselineFormatError extends Error {}

/**
 * @typedef {{ id: string, checksum: string }} BaselineEntry
 * @typedef {{ upstreamCommit: string, sets: Record<string, BaselineEntry[]>, acceptedVariants: Record<string, Record<string, string[]>> }} Baseline
 */

/** Parses and shape-checks a baseline file's text; throws BaselineFormatError with the offending path. */
export function parseBaseline(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BaselineFormatError(`${path} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new BaselineFormatError(`${path} must be an object`);
  if (!/^[0-9a-f]{40}$/.test(parsed.upstreamCommit ?? ""))
    throw new BaselineFormatError(`${path} upstreamCommit must be a 40-hex sha`);
  if (!parsed.sets || typeof parsed.sets !== "object")
    throw new BaselineFormatError(`${path} must carry a sets object`);
  for (const set of Object.keys(parsed.sets)) {
    const entries = parsed.sets[set];
    if (
      !Array.isArray(entries) ||
      entries.some((e) => !e?.id || !/^[0-9a-f]{64}$/.test(e.checksum ?? ""))
    )
      throw new BaselineFormatError(
        `${path} set ${set} must be [{ id, checksum }] with sha256 hex checksums`,
      );
    if (entries.some((entry) => FORK_MIGRATION_ID.test(entry.id)))
      throw new BaselineFormatError(`${path} set ${set} must not contain fork ids`);
  }
  if (parsed.acceptedVariants && typeof parsed.acceptedVariants !== "object")
    throw new BaselineFormatError(`${path} acceptedVariants must be an object`);
  return parsed;
}

/** Stable serialization: set order, then JSON with a trailing newline. */
export function serializeBaseline(baseline) {
  const sets = {};
  for (const set of SET_ORDER) sets[set] = baseline.sets[set] ?? [];
  return `${JSON.stringify({ ...baseline, sets }, null, 2)}\n`;
}

function acceptedChecksums(baseline, set, id) {
  return baseline.acceptedVariants?.[set]?.[id] ?? [];
}

/** The upstream (non-fork) entries of a collected set, in application order. */
export function upstreamEntries(entries) {
  return entries.filter((entry) => !FORK_MIGRATION_ID.test(entry.id));
}

function checksumError(set, entry, expected, baseline) {
  const meta = SET_METADATA[set];
  return (
    `[db:migrations] Frozen upstream migration changed: ${set} ${entry.id} expected ${expected} got ${entry.checksum}. ` +
    `${meta.database} is shared with the upstream app; restore the upstream text ` +
    `(git show ${baseline.upstreamCommit}:${meta.sources}) and add a 9NNN_fork_* migration instead. ${SPEC}`
  );
}

/**
 * Compares collected ledgers against the baseline and the upstream pin.
 * @returns {string[]} failure messages; empty means the gate passes.
 */
/**
 * The upstream commit the baseline must match. During a pre-port series fork-upstream-base.json
 * carries pendingUpstreamCommit (specs/fork-format-scope.md); upstream migrations copied from that
 * commit are baselined against it, and the sync PR that moves upstreamCommit there and removes the
 * pending field needs no regeneration.
 * @param {{ upstreamCommit?: string, pendingUpstreamCommit?: string }} pinFile
 */
export function effectivePin(pinFile) {
  const pin = pinFile.pendingUpstreamCommit ?? pinFile.upstreamCommit;
  if (!/^[0-9a-f]{40}$/.test(pin ?? ""))
    throw new BaselineFormatError("fork-upstream-base.json pin must be a 40-hex sha");
  return pin;
}

export function checkBaseline({ baseline, pin, collected }) {
  const errors = [];
  if (pin !== baseline.upstreamCommit)
    errors.push(
      `[db:migrations] Upstream pin moved: fork-upstream-base.json is ${pin} but fork-upstream-migrations.json ` +
        `was generated at ${baseline.upstreamCommit}; upstream pin moved; regenerate the baseline in this sync PR. ${SPEC}`,
    );
  for (const set of Object.keys(collected)) {
    if (!SET_ORDER.includes(set)) {
      errors.push(
        `[db:migrations] Unknown migration set: ${set} is collected but not defined in ${SPEC}`,
      );
      continue;
    }
    const expected = baseline.sets[set];
    if (!expected) {
      errors.push(
        `[db:migrations] Migration set ${set} is missing from fork-upstream-migrations.json. ${SPEC}`,
      );
      continue;
    }
    const actual = upstreamEntries(collected[set]);
    const expectedIds = expected.map((entry) => entry.id);
    const actualIds = actual.map((entry) => entry.id);
    if (actualIds.join("\n") !== expectedIds.join("\n")) {
      errors.push(...sequenceErrors(set, actual, expected, baseline));
      continue;
    }
    for (let index = 0; index < actual.length; index++) {
      const entry = actual[index];
      const baselineEntry = expected[index];
      const accepted = [baselineEntry.checksum, ...acceptedChecksums(baseline, set, entry.id)];
      if (!accepted.includes(entry.checksum))
        errors.push(checksumError(set, entry, baselineEntry.checksum, baseline));
    }
  }
  for (const set of Object.keys(baseline.sets)) {
    if (baseline.sets[set].length && !collected[set])
      errors.push(
        `[db:migrations] Migration set ${set} is in fork-upstream-migrations.json but nothing was collected for it. ${SPEC}`,
      );
  }
  return errors;
}

/** Splits an id-sequence mismatch into unknown/missing/reorder messages that name the ids. */
function sequenceErrors(set, actual, expected, baseline) {
  const meta = SET_METADATA[set];
  const expectedIds = new Set(expected.map((entry) => entry.id));
  const actualIds = new Set(actual.map((entry) => entry.id));
  const errors = [];
  for (const entry of actual) {
    if (!expectedIds.has(entry.id))
      errors.push(
        `[db:migrations] Unknown upstream migration id: ${set} applies ${entry.id}, which is not in ` +
          `fork-upstream-migrations.json and does not match 9NNN_fork_*. ${meta.database} is shared with the ` +
          `upstream app; upstream ids are frozen, so add fork changes as a 9NNN_fork_* migration instead. ${SPEC}`,
      );
  }
  for (const entry of expected) {
    if (!actualIds.has(entry.id))
      errors.push(
        `[db:migrations] Frozen upstream migration missing: ${set} no longer applies ${entry.id} ` +
          `(baseline ${entry.checksum}). Removing or renaming an upstream migration breaks the shared ledger; ` +
          `restore it (git show ${baseline.upstreamCommit}:${meta.sources}). ${SPEC}`,
      );
  }
  if (!errors.length) {
    const actualIds = actual.map((entry) => entry.id);
    const expectedIds = expected.map((entry) => entry.id);
    errors.push(
      `[db:migrations] Frozen upstream migration order changed in ${set}: applied [${actualIds.join(", ")}] ` +
        `but the baseline order is [${expectedIds.join(", ")}]. The ledger applies in list order; restore the ` +
        `upstream order. ${SPEC}`,
    );
  }
  return errors;
}

/**
 * Appends freshly collected upstream entries to a baseline after an upstream pin bump.
 * @throws {Error} when --update is not allowed (pin unchanged) or an existing entry would change.
 */
export function appendBaseline({ baseline, pin, collected }) {
  if (baseline && pin === baseline.upstreamCommit)
    throw new Error(
      `[db:migrations] --update refused: fork-upstream-base.json still points at ${pin}, the commit the ` +
        `baseline was generated from; there is nothing to regenerate. ${SPEC}`,
    );
  const previous = baseline ?? { upstreamCommit: "", sets: {}, acceptedVariants: {} };
  const sets = {};
  for (const set of SET_ORDER) {
    const expected = previous.sets[set] ?? [];
    const actual = upstreamEntries(collected[set] ?? []);
    sets[set] = mergeSet(set, expected, actual, previous);
  }
  return { upstreamCommit: pin, sets, acceptedVariants: previous.acceptedVariants ?? {} };
}

/** Append-only merge of one set; refuses checksum rewrites, removals, and reorders of surviving ids. */
function mergeSet(set, expected, actual, previous) {
  const expectedIds = new Set(expected.map((entry) => entry.id));
  const actualIds = new Set(actual.map((entry) => entry.id));
  for (const entry of expected) {
    if (!actualIds.has(entry.id))
      throw new Error(
        `[db:migrations] --update refused for ${set}: upstream id ${entry.id} disappeared — ` +
          `upstream rewrote a frozen migration — stop and escalate. ${SPEC}`,
      );
  }
  const surviving = actual.filter((entry) => expectedIds.has(entry.id));
  const survivingIds = surviving.map((entry) => entry.id).join("\n");
  if (survivingIds !== expected.map((entry) => entry.id).join("\n"))
    throw new Error(
      `[db:migrations] --update refused for ${set}: existing ids reordered — ` +
        `upstream rewrote a frozen migration — stop and escalate. ${SPEC}`,
    );
  const byId = new Map(expected.map((entry) => [entry.id, entry]));
  return actual.map((entry) => {
    const frozen = byId.get(entry.id);
    if (!frozen) return { id: entry.id, checksum: entry.checksum };
    const accepted = [frozen.checksum, ...acceptedChecksums(previous, set, entry.id)];
    if (!accepted.includes(entry.checksum))
      throw new Error(
        `[db:migrations] --update refused for ${set}: ${entry.id} would change from ${frozen.checksum} to ` +
          `${entry.checksum} — upstream rewrote a frozen migration — stop and escalate. ${SPEC}`,
      );
    return frozen;
  });
}
