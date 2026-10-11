import ts from "typescript";
import { FACADE_FILE_NAME } from "./dts.js";

/**
 * World-read registry:
 * the single source of truth for **(facade container, member) → op**. One table has three
 * consumers—site collection in `analysis/sites.ts`, facade-siting diagnostics in
 * `analysis/facade-misuse.ts`, and rewriting in `lowering/lower.ts`—so adding a world-read
 * primitive means **adding one row**, with no consumer changes.
 *
 * ————————————————————————————————————————————————————————————————
 * Why the key must include the **declared container**, not only the member name:
 * ————————————————————————————————————————————————————————————————
 * `git.log` collides with the top-level `log()`. A bare-name set has only two outcomes: assign a
 * world-read site to every progress message, or drop the `git.log` site entirely. A facade call
 * without a site has no journal key, exactly the kind of unreliability the facade-siting rule
 * prevents. Facade identity is already **declaration-based** elsewhere (the misuse pass resolves
 * the callee symbol, not its spelling), so this applies the same rule consistently rather than
 * introducing a new one.
 *
 * Derive the op union type from this table (see {@link WorldReadOp}): adding a row expands
 * Boundary A's op vocabulary without requiring another type declaration, a common source of a
 * second truth.
 */

/** One registry row: a facade container member mapped to a Boundary A op. */
interface WorldReadRow {
  /** Facade container that declares this member (`files` in `declare const files: {...}`). */
  readonly container: string;
  /** Member name on the container (`glob` in `files.glob`). */
  readonly member: string;
  /** Boundary A op name; does **not** have to match the member name: `git.log` → `"git-log"`. */
  readonly op: string;
}

/**
 * World-read registry. Add a primitive by adding one row.
 *
 * The `git.log` row is why this table exists: its member name collides with top-level `log()`,
 * but the container is part of the key, so the two never collide (see this module's header).
 */
export const WORLD_READ_REGISTRY = [
  { container: "files", member: "glob", op: "glob" },
  { container: "files", member: "read", op: "read" },
  { container: "files", member: "grep", op: "grep" },
  { container: "git", member: "changedFiles", op: "git-changed-files" },
  { container: "git", member: "diff", op: "git-diff" },
  { container: "git", member: "status", op: "git-status" },
  { container: "git", member: "log", op: "git-log" },
  // world.run: journaled command execution, using the same table and mechanism. The difference
  // between a "read" and an "effect" is authorization (compile-time literal cmd + confirmation
  // dialog) and journal node kind (world-run), not site identity.
  { container: "world", member: "run", op: "run" },
] as const satisfies readonly WorldReadRow[];

/**
 * World-read operation (read-only, journaled). Derived from the registry, so adding one row
 * expands the op vocabulary. Used by Boundary A's `worldRead(siteId, op, args)` and the journal's
 * `inputHash({op, args})`.
 */
export type WorldReadOp = (typeof WORLD_READ_REGISTRY)[number]["op"];

/**
 * Artifact registry: six members of the `artifact` container map to six Boundary A ops.
 * **Same shape as, but separate from, the world-read registry**, intentionally:
 *
 * Every row in the world-read table ultimately reaches `driver.executeWorldRead` and means
 * "read." The two artifact families differ: one is a store-writing effect (`publishArtifact`),
 * and the other bypasses the driver (`declareArtifact`). Combining them would add an "unless it
 * is actually an artifact" branch to world-read handling in misuse analysis, lowering, and the
 * engine—the three places that should need no changes when adding a primitive.
 *
 * Terminology: artifact here means a **user-facing artifact**, not the engine's internal top-level return value.
 */
export interface ArtifactRow {
  /** Facade container declaring this member (always `artifact`). */
  readonly container: "artifact";
  /** Member name on the container. */
  readonly member: string;
  /** Boundary A op name (same as the member name; artifact members have no `git.log`-style name collision). */
  readonly op: string;
  /**
   * Member family. `content` is an effect (async, goes through the driver, and can reject);
   * `preset` is a declaration (sync void, bypasses the driver). The family determines whether
   * lowering rewrites to `publishArtifact` or `declareArtifact`, and whether overflow rejects the
   * node or calls failRun. Keep it on the same row as op rather than checking separately in
   * three places.
   */
  readonly family: "content" | "preset";
}

/** Artifact registry. Add an artifact kind by adding one row. */
export const ARTIFACT_REGISTRY = [
  { container: "artifact", member: "file", op: "file", family: "content" },
  { container: "artifact", member: "markdown", op: "markdown", family: "content" },
  { container: "artifact", member: "chart", op: "chart", family: "preset" },
  { container: "artifact", member: "table", op: "table", family: "preset" },
  { container: "artifact", member: "metrics", op: "metrics", family: "preset" },
  { container: "artifact", member: "board", op: "board", family: "preset" },
] as const satisfies readonly ArtifactRow[];

/** All artifact ops (six members), derived from the registry so adding one row expands the vocabulary. */
export type ArtifactOp = (typeof ARTIFACT_REGISTRY)[number]["op"];

/** Ops for content members (effects: async, through driver, return `ArtifactRef`). */
export type ArtifactContentOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "content" }
>["op"];

/** Ops for preset members (declarations: sync void, bypass driver). */
export type ArtifactPresetOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "preset" }
>["op"];

/**
 * Registry lookup: (container, member) → artifact row. Non-artifact members return undefined.
 *
 * Return the **literal type of the table entry** rather than the widened {@link ArtifactRow}:
 * the `op` and `family` unions are derived from this table, and widening them to `string` would
 * deprive the site table and lowering of their dispatch basis.
 */
function artifactRow(
  container: string | undefined,
  member: string,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  if (container === undefined) return undefined;
  return ARTIFACT_REGISTRY.find((row) => row.container === container && row.member === member);
}

/** Artifact row resolved from a facade symbol (determined by declared container); undefined for non-artifact members. */
export function artifactRowOfSymbol(
  symbol: ts.Symbol | undefined,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return artifactRow(member.container, member.member);
}

/** Artifact family for an op. The op is derived from the registry, so lookup always succeeds. */
export function artifactFamilyOf(op: ArtifactOp): "content" | "preset" {
  const row = ARTIFACT_REGISTRY.find((candidate) => candidate.op === op);
  if (row === undefined) throw new Error(`unknown artifact op: ${op}`);
  return row.family;
}

/** Whether the op is a preset member (declaration family). The engine and analyzer use this to dispatch two distinct paths. */
export function isArtifactPresetOp(op: string): op is ArtifactPresetOp {
  return ARTIFACT_REGISTRY.some((row) => row.op === op && row.family === "preset");
}

/**
 * Container for `ask`: it is not a world-read, but it is also a site-producing facade member,
 * so facade-siting rules constrain it too (direct calls only). Keep it here so there is one list
 * of members that produce sites.
 */
const ASK_MEMBER = { container: "Agent", member: "ask" } as const;

/**
 * Top-level facade functions that produce sites (without a container). `log` is omitted because it
 * does not produce a site. `hole` is included: a hole has a site ID (the name key `hole#<hash>`) and a
 * host call (docs/dynamic-workflow/authoring.md, “Holes”). Its identity is also determined by the
 * **declaration file**; a script's own `hole` function is an ordinary function.
 */
const SITE_PRODUCING_FUNCTIONS = ["agent", "report", "hole"] as const;

/**
 * Names of top-level site-producing facade functions. The bare-callee branch in `sites.ts`
 * dispatches using this set, keeping one list of which top-level functions produce sites.
 *
 * `report` is included and `log` is not. The distinction is not severity, but **whether there is
 * a journal key**: report creates a `dwf_node` row (replay deduplicates by site × ordinal), so
 * facade-siting rules (direct calls only) must constrain it; a report call without a site would
 * create a journal record without a key. `log` has no site, so aliasing cannot break anything.
 */
type SiteProducingFunction = (typeof SITE_PRODUCING_FUNCTIONS)[number];

/**
 * **Top-level site-producing function** resolved from a facade symbol (declaration-based; the
 * container must be absent). Return undefined for non-facade symbols, facade container members,
 * and top-level functions such as `log` that do not produce a site.
 */
export function siteProducingFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): SiteProducingFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return SITE_PRODUCING_FUNCTIONS.find((name) => name === member.member);
}

/**
 * **Presentation markers** among top-level facade functions: they have facade identity but do
 * not produce sites. Currently only `phase`.
 *
 * Why it has its own list instead of {@link SITE_PRODUCING_FUNCTIONS}: that list answers which
 * top-level functions produce sites, while `phase` has no site ID, journal row, or host call;
 * lowering erases it to `void 0`. Adding it to the site-producing list would make facade-misuse
 * pass 2 ("direct calls that produce a site but were not sited") reject every valid `phase("gate")`.
 *
 * It remains a facade function declaration, so alias escape (`const p = phase`) is still
 * rejected by facade-misuse pass 1; lowering can therefore safely erase it by node identity.
 */
const MARKER_FUNCTIONS = ["phase"] as const;

/** Top-level presentation-marker facade function names, derived from {@link MARKER_FUNCTIONS}; add a marker by adding one row. */
type MarkerFunction = (typeof MARKER_FUNCTIONS)[number];

/**
 * **Presentation-marker** top-level function resolved from a facade symbol (declaration-based;
 * container must be absent); return undefined for non-markers. Same shape as
 * {@link siteProducingFunctionOfSymbol}, but intentionally a separate table.
 */
export function markerFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): MarkerFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return MARKER_FUNCTIONS.find((name) => name === member.member);
}

/**
 * Top-level facade functions that are **pure value constructors**: they have facade identity, but
 * produce no site and do not cross into the host. Currently there is only
 * `model`（docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）。
 *
 * `ModelRef` exists only in the type system; at runtime it is the model-name string itself. Lowering
 * therefore erases `model("x")` to its argument, `"x"`; there is no `__host.model` or journal row in
 * the sandbox. It is listed separately from `phase` for the same reason as {@link MARKER_FUNCTIONS}:
 * it does not produce a site, and including it in the site-producing list would make facade-misuse
 * pass 2 reject every valid call. It remains a facade function declaration, so pass 1 still rejects
 * alias escape (`const m = model`); lowering can safely erase it by node identity.
 */
const VALUE_FUNCTIONS = ["model"] as const;

/** Names of top-level pure-value facade functions, derived from {@link VALUE_FUNCTIONS}. */
type ValueFunction = (typeof VALUE_FUNCTIONS)[number];

/** Resolve a facade symbol to a top-level pure-value function (based on declaration; it must have no container), or return undefined. */
export function valueFunctionOfSymbol(symbol: ts.Symbol | undefined): ValueFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return VALUE_FUNCTIONS.find((name) => name === member.member);
}

/**
 * Names of all site-producing facade members (world-read members + `ask`). A **bare-name** list,
 * usable only in a two-step check: find candidates by name, then verify identity by declaration.
 * Never use it alone as identity (see this module's header).
 *
 * After adding `git.log`, this set **contains `"log"`**, while top-level `log()` does not produce
 * a site. This is not a contradiction; it proves that this list can only be a candidate key.
 * Identity must come from (container, member) or declaration resolution; the name alone cannot
 * answer. The only other relied-upon property is that **no two facade containers declare the
 * same member name**. Since the set omits containers, duplicate names would make reverse lookup
 * ambiguous (facade-misuse diagnostics refer to this).
 */
export const SITE_MEMBER_NAMES: ReadonlySet<string> = new Set<string>([
  ASK_MEMBER.member,
  ...WORLD_READ_REGISTRY.map((row) => row.member),
  ...ARTIFACT_REGISTRY.map((row) => row.member),
]);

/**
 * Registry lookup: (container, member) → op. Never matches when container is undefined
 * (top-level function); world-read ops always belong to facade container objects.
 */
export function worldReadOp(
  container: string | undefined,
  member: string,
): WorldReadOp | undefined {
  if (container === undefined) return undefined;
  return WORLD_READ_REGISTRY.find((row) => row.container === container && row.member === member)
    ?.op;
}

/**
 * Whether (container, member) is a site-producing facade call (world-read, artifact, `Agent.ask`, or top-level
 * `agent`/`report`）。
 *
 * Artifact members are included for the same reason as `report`: they have journal keys
 * (`artifact#N` × ordinal), and a publish without a site would be a journal row without a key—
 * exactly what facade-siting rules prevent.
 */
export function isSiteProducing(container: string | undefined, member: string): boolean {
  if (container === undefined) return SITE_PRODUCING_FUNCTIONS.some((name) => name === member);
  if (container === ASK_MEMBER.container && member === ASK_MEMBER.member) return true;
  if (artifactRow(container, member) !== undefined) return true;
  return worldReadOp(container, member) !== undefined;
}

/**
 * **Container name** owning a facade declaration: `glob` in `declare const files: { glob(...) }`
 * → `"files"`; `ask` in `declare interface Agent { ask(...) }` → `"Agent"`; top-level
 * `declare function agent()` → undefined (no container).
 *
 * Implementation: a member declaration is a method/property signature in a type literal or
 * interface body. Walk upward to VariableDeclaration (const container) or
 * InterfaceDeclaration/TypeAliasDeclaration (named type container) and use its name. Only
 * declarations in facade `.d.ts` files count; same-named members defined by a script return undefined.
 */
export function facadeContainerOf(declaration: ts.Node | undefined): string | undefined {
  if (declaration === undefined) return undefined;
  if (declaration.getSourceFile().fileName !== FACADE_FILE_NAME) return undefined;
  for (let node: ts.Node | undefined = declaration.parent; node !== undefined; node = node.parent) {
    if (ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isSourceFile(node)) return undefined;
  }
  return undefined;
}

/**
 * (container, member) identity for a facade symbol. A symbol matches if any declaration is in a
 * facade `.d.ts`; resolve the container by walking up from that declaration (top-level facade
 * functions have no container). Non-facade symbols return undefined.
 */
export function facadeMemberOf(
  symbol: ts.Symbol | undefined,
): { container: string | undefined; member: string } | undefined {
  const declaration = symbol?.declarations?.find(
    (decl) => decl.getSourceFile().fileName === FACADE_FILE_NAME,
  );
  if (declaration === undefined || symbol === undefined) return undefined;
  return { container: facadeContainerOf(declaration), member: symbol.name };
}

/** World-read op resolved from a facade symbol (determined by declared container); undefined for non-world-read symbols. */
export function worldReadOpOfSymbol(symbol: ts.Symbol | undefined): WorldReadOp | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return worldReadOp(member.container, member.member);
}
