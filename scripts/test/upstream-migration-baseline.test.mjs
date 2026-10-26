import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendBaseline,
  BaselineFormatError,
  checkBaseline,
  effectivePin,
  FORK_MIGRATION_ID,
  parseBaseline,
  serializeBaseline,
  upstreamEntries,
} from "../upstream-migration-baseline.mjs";

const PIN = "3c5b227649371507ddc4eb46ac5133afe6db1cab";
const NEW_PIN = "4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70";
const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);
const CHECKSUM_C = "c".repeat(64);

const entry = (id, checksum) => ({ id, checksum });

function minimalBaseline() {
  return {
    upstreamCommit: PIN,
    sets: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_A),
        entry("0020_provider_model_selection", CHECKSUM_B),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
    acceptedVariants: { cli: { "0020_provider_model_selection": ["f".repeat(64)] } },
  };
}

test("fork id regex accepts fork ids and rejects upstream and malformed ids", () => {
  assert.ok(FORK_MIGRATION_ID.test("9001_fork_session_incognito"));
  assert.ok(FORK_MIGRATION_ID.test("9999_fork_x"));
  for (const id of [
    "0014_message_part_sequence",
    "9001_fork_UPPER",
    "9001fork_x",
    "8001_fork_x",
    "9001_fork_",
  ])
    assert.ok(!FORK_MIGRATION_ID.test(id), id);
});

test("upstreamEntries drops fork ids anywhere in the sequence", () => {
  const rows = [
    entry("0014_message_part_sequence", CHECKSUM_A),
    entry("9001_fork_session_incognito", CHECKSUM_B),
    entry("0020_provider_model_selection", CHECKSUM_C),
  ];
  assert.deepEqual(
    upstreamEntries(rows).map((e) => e.id),
    ["0014_message_part_sequence", "0020_provider_model_selection"],
  );
});

test("checkBaseline passes when checksums, order, and pin match", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: PIN,
    collected: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_A),
        entry("9001_fork_x", CHECKSUM_B),
        entry("0020_provider_model_selection", CHECKSUM_B),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.deepEqual(errors, []);
});

test("checkBaseline fails naming the id when a frozen checksum changes", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: PIN,
    collected: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_C),
        entry("0020_provider_model_selection", CHECKSUM_B),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Frozen upstream migration changed: cli 0014_message_part_sequence/);
  assert.match(errors[0], new RegExp(`expected ${CHECKSUM_A} got ${CHECKSUM_C}`));
  assert.match(errors[0], /~\/\.zcode\/cli\/db\/db\.sqlite is shared with the upstream app/);
  assert.match(errors[0], new RegExp(`git show ${PIN}:`));
  assert.match(errors[0], /add a 9NNN_fork_\* migration instead/);
});

test("checkBaseline accepts a checksum listed in acceptedVariants", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: PIN,
    collected: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_A),
        entry("0020_provider_model_selection", "f".repeat(64)),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.deepEqual(errors, []);
});

test("checkBaseline fails on an unknown non-fork id (e.g. a new 0025)", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: PIN,
    collected: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_A),
        entry("0020_provider_model_selection", CHECKSUM_B),
        entry("0025_new_upstream", CHECKSUM_C),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Unknown upstream migration id: cli applies 0025_new_upstream/);
  assert.match(errors[0], /does not match 9NNN_fork_\*/);
});

test("checkBaseline fails when a baseline id is missing from the collected set", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: PIN,
    collected: {
      cli: [entry("0020_provider_model_selection", CHECKSUM_B)],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /Frozen upstream migration missing: cli no longer applies 0014_message_part_sequence/,
  );
});

test("checkBaseline fails on reorder even with identical checksums", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: PIN,
    collected: {
      cli: [
        entry("0020_provider_model_selection", CHECKSUM_B),
        entry("0014_message_part_sequence", CHECKSUM_A),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Frozen upstream migration order changed in cli/);
  assert.match(errors[0], /applied \[0020_provider_model_selection, 0014_message_part_sequence\]/);
});

test("checkBaseline fails when the upstream pin moved without regenerating", () => {
  const errors = checkBaseline({
    baseline: minimalBaseline(),
    pin: NEW_PIN,
    collected: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_A),
        entry("0020_provider_model_selection", CHECKSUM_B),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    new RegExp(`Upstream pin moved: fork-upstream-base\\.json is ${NEW_PIN}`),
  );
  assert.match(errors[0], /upstream pin moved; regenerate the baseline in this sync PR/);
});

test("appendBaseline appends new upstream ids after a pin bump and keeps frozen entries", () => {
  const appended = appendBaseline({
    baseline: minimalBaseline(),
    pin: NEW_PIN,
    collected: {
      cli: [
        entry("0014_message_part_sequence", CHECKSUM_A),
        entry("9006_fork_new_thing", CHECKSUM_B),
        entry("0020_provider_model_selection", "f".repeat(64)), // still an accepted variant
        entry("0025_new_upstream", CHECKSUM_C),
      ],
      "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
    },
  });
  assert.equal(appended.upstreamCommit, NEW_PIN);
  assert.deepEqual(appended.sets.cli, [
    entry("0014_message_part_sequence", CHECKSUM_A),
    entry("0020_provider_model_selection", CHECKSUM_B),
    entry("0025_new_upstream", CHECKSUM_C),
  ]);
  assert.deepEqual(appended.acceptedVariants, minimalBaseline().acceptedVariants);
});

test("appendBaseline refuses to change an existing entry's checksum", () => {
  assert.throws(
    () =>
      appendBaseline({
        baseline: minimalBaseline(),
        pin: NEW_PIN,
        collected: {
          cli: [
            entry("0014_message_part_sequence", CHECKSUM_C),
            entry("0020_provider_model_selection", CHECKSUM_B),
          ],
          "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
        },
      }),
    /upstream rewrote a frozen migration — stop and escalate/,
  );
});

test("appendBaseline refuses a removed or reordered existing id", () => {
  assert.throws(
    () =>
      appendBaseline({
        baseline: minimalBaseline(),
        pin: NEW_PIN,
        collected: {
          cli: [entry("0020_provider_model_selection", CHECKSUM_B)],
          "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
        },
      }),
    /0014_message_part_sequence disappeared[\s\S]*stop and escalate/,
  );
  assert.throws(
    () =>
      appendBaseline({
        baseline: minimalBaseline(),
        pin: NEW_PIN,
        collected: {
          cli: [
            entry("0020_provider_model_selection", CHECKSUM_B),
            entry("0014_message_part_sequence", CHECKSUM_A),
          ],
          "tasks_index:base": [entry("0003_official_glm_selection", CHECKSUM_C)],
        },
      }),
    /existing ids reordered[\s\S]*stop and escalate/,
  );
});

test("appendBaseline refuses --update when the pin has not moved and a baseline exists", () => {
  assert.throws(
    () => appendBaseline({ baseline: minimalBaseline(), pin: PIN, collected: {} }),
    /--update refused: fork-upstream-base\.json still points at/,
  );
});

test("appendBaseline creates the first baseline when none exists", () => {
  const created = appendBaseline({
    baseline: undefined,
    pin: PIN,
    collected: { cli: [entry("0014_message_part_sequence", CHECKSUM_A)] },
  });
  assert.equal(created.upstreamCommit, PIN);
  assert.deepEqual(created.sets.cli, [entry("0014_message_part_sequence", CHECKSUM_A)]);
});

test("parseBaseline rejects fork ids, bad checksums, and non-JSON text", () => {
  assert.throws(() => parseBaseline("{", "fork-upstream-migrations.json"), BaselineFormatError);
  assert.throws(
    () =>
      parseBaseline(
        JSON.stringify({ upstreamCommit: "x", sets: { cli: [entry("1", "z")] } }),
        "b.json",
      ),
    BaselineFormatError,
  );
  assert.throws(
    () =>
      parseBaseline(
        JSON.stringify({ upstreamCommit: PIN, sets: { cli: [entry("9001_fork_x", CHECKSUM_A)] } }),
        "b.json",
      ),
    BaselineFormatError,
  );
});

test("serializeBaseline keeps set order and round-trips through parseBaseline", () => {
  const text = serializeBaseline(minimalBaseline());
  assert.ok(text.startsWith('{\n  "upstreamCommit"'));
  assert.ok(text.endsWith("}\n"));
  const roundTrip = parseBaseline(text, "b.json");
  // serializeBaseline fills SET_ORDER sets that the in-memory baseline omits.
  assert.deepEqual(roundTrip.sets, {
    ...minimalBaseline().sets,
    "tasks_index:projects": [],
    "tasks_index:controller-remote": [],
    "tasks_index:source-server": [],
  });
});

test("effectivePin prefers pendingUpstreamCommit during a pre-port series", () => {
  assert.equal(effectivePin({ upstreamCommit: PIN }), PIN);
  assert.equal(effectivePin({ upstreamCommit: PIN, pendingUpstreamCommit: NEW_PIN }), NEW_PIN);
  assert.throws(() => effectivePin({ upstreamCommit: "short" }), BaselineFormatError);
});
