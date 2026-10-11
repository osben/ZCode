// ============================================================
// Quality epilogue for dwf asks.
// ============================================================
//
// Kept in a separate file because workflow-driver.ts is already over max-lines; this is only prose plus a schema check,
// unrelated to the driver's state machine.
//
// The epilogue used to vary by persona tool tier. A tool-less GLM subagent read "every finding
// cites what you read or ran," looked for tools it did not have, and emitted `escalate("placeholder")`.
// Tool tiers have been removed and every subagent now has the full work-tool set, so use one epilogue for all.

/**
 * Quality epilogue for every ask: standards for result content—evidence,
 * distinguish "ran" from "believe," report limitations honestly, and escalate when blocked. Add it to typed and untyped asks; for typed
 * asks, append the schema epilogue afterward. If top-level schema properties include `evidence` / `confidence`, name those fields explicitly;
 * otherwise, do not mention them.
 * Format (this comment is the contract): two blank lines + separator + title line + bullet list.
 */
export function qualityEpilogue(schema: unknown): string {
  const fields = topLevelSchemaProperties(schema);
  return [
    "",
    "",
    "---",
    "Standard for this result:",
    "- Every finding cites what you read or ran: path and line for code; the exact command and its output for a check; the part of the ask for material the ask itself gave you.",
    "- A check counts as passed only if you ran it during this ask. Otherwise report it as not run.",
    // Subagents may choose the fastest command that turns green and claim "tests passed"—the ask may request the full suite but they run one file,
    // or request e2e but they run unit tests. The contract requires honesty; this clarifies scope: report a substitute as a substitute and name the command that ran.
    "- Run the check the ask names, at the scale it names. A narrower or faster substitute — one test file for the suite, a build for the tests — is reported as what it is, never as the ask's check; say the exact command you ran.",
    "- Anything you could not do, verify, or find is stated as such — never filled with a plausible guess.",
    ...(fields.has("evidence") ? ["- Put each finding's citation in its `evidence` field."] : []),
    ...(fields.has("confidence")
      ? ["- Rate `confidence` honestly; a low value with a reason beats a confident guess."]
      : []),
    "- If you are blocked by something outside your reach, call `escalate` instead of inventing a value.",
  ].join("\n");
}

/** Set of top-level schema `properties` keys; empty if the schema is missing or not an object. */
function topLevelSchemaProperties(schema: unknown): Set<string> {
  if (typeof schema !== "object" || schema === null) return new Set();
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return new Set();
  return new Set(Object.keys(properties as Record<string, unknown>));
}
