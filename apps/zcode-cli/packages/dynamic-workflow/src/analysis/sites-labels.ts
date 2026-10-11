import ts from "typescript";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import type { WorldReadOp } from "../facade/registry.js";
import type { ScriptLoc } from "../compiler/compile.js";
import type { NamePattern } from "./types.js";
import type { CallbackSemantics } from "./callbacks.js";
import type { IterationCandidate } from "./sites.js";

// sites.ts reached oxlint's max-lines limit (400), so name/label helpers (ask labels and template
// shape, actor names and template shape, world-read labels, literal text, iteration-candidate
// construction, counters) and their symbol-resolution dependencies (resolveSymbol /
// isFacadeDeclared) were moved here. The public surface is still exported from sites.ts (the latter
// two are re-exported there; the rest were not public). Site types remain in sites.ts and are
// imported here as types only.

/** Resolve a node's symbol, following one alias hop (imports never occur here). */
export function resolveSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** True iff any of the symbol's declarations lives in the facade `.d.ts`. */
export function isFacadeDeclared(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => declaration.getSourceFile().fileName === FACADE_FILE_NAME,
    ) ?? false
  );
}

/**
 * Text of an argument that is a **string literal without substitutions**; all other forms
 * (identifier, interpolated template, arbitrary expression) return undefined.
 *
 * Three sites share this rule: phase names, artifact IDs, and report labels. Their requirements are
 * identical—only literals resolved at compile time count. Leave anything opaque to the respective
 * diagnostic pass, which can locate the original expression; **never guess a value here** (a
 * guessed name would let a call pass silently when it should be corrected). `ts.isStringLiteralLike`
 * also covers template strings without substitutions.
 */
export function literalText(expr: ts.Expression | undefined): string | undefined {
  return expr !== undefined && ts.isStringLiteralLike(expr) ? expr.text : undefined;
}

/**
 * A set of per-kind site counters (`ask#N` / `actor#N` / …), plus an ID prefix.
 *
 * Prefixes are used for holes (docs/analysis.md, “Sites”, “Hole sites”): when the walk enters a hole
 * body, it **starts a fresh set of counters**. Every ID minted inside carries `<holeId>/`
 * (`hole#a91f3c07/ask#1`), and outer counters never see sites inside the body. Filling a hole (inserting
 * code into the middle of a script) therefore leaves every existing `ask#N` / `actor#N` / … unchanged.
 * This extends site-ID stability from adding markers to adding function bodies; live-run journal keys,
 * ask specs, and the site phase table all survive hole filling. The prefix is only **one level**: a
 * hole's own ID is a name key (hole-id.ts) without an outer prefix, so nested holes do not make IDs grow
 * with depth. `holeId` records which hole owns these counters, allowing sites inside its body to store
 * the containing hole in `fill`.
 * The global `order` is not managed here: it is the merge key for text output and counts continuously
 * across function bodies.
 */
export class SiteCounters {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly prefix = "",
    /** The hole body that owns this counter set; absent at the top level. */
    readonly holeId?: string,
  ) {}

  /** Mint the next `<prefix><kind>#<n>`. */
  next(kind: string): string {
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    return `${this.prefix}${kind}#${n}`;
  }

  /** Enter the body of hole `holeId`: start fresh counters prefixed by this hole's ID, without the outer prefix. */
  child(holeId: string): SiteCounters {
    return new SiteCounters(`${holeId}/`, holeId);
  }
}

/**
 * ask label: an inline `agent("name", …)` receiver contributes its literal name;
 * a plain identifier receiver contributes its text; otherwise `"ask"`.
 */
export function askLabel(receiver: ts.Expression, checker: ts.TypeChecker): string {
  if (ts.isCallExpression(receiver) && isActorCall(receiver, checker)) {
    const first = receiver.arguments[0];
    if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  }
  if (ts.isIdentifier(receiver)) return receiver.text;
  return "ask";
}

/**
 * ask label pattern: only for an inline `` agent(`研究员${i}`) `` receiver — the one shape
 * `askLabel` answers `"ask"` for despite the script having said something. A named or
 * identifier receiver already produced a real label, so there is nothing to reconstruct.
 */
export function askLabelPattern(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): NamePattern | undefined {
  if (!ts.isCallExpression(receiver) || !isActorCall(receiver, checker)) return undefined;
  return templateAffixes(receiver.arguments[0]);
}

function isActorCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (ts.isPropertyAccessExpression(call.expression)) return false;
  const symbol = resolveSymbol(call.expression, checker);
  return isFacadeDeclared(symbol) && symbol?.name === "agent";
}

/**
 * actor name: a string-literal first argument, else the binding name when the call
 * directly initializes a variable declaration, else undefined.
 */
export function actorName(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  const parent = call.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return undefined;
}

/**
 * actor name pattern: the static shape of a first argument that is a template literal
 * with holes. Only consulted when `actorName` came back undefined — a literal name and a
 * binding name are both real names, and a pattern must never displace one.
 */
export function actorNamePattern(call: ts.CallExpression): NamePattern | undefined {
  return templateAffixes(call.arguments[0]);
}

/**
 * Literal portions at the two ends of a template string: before the first substitution (`head`) and
 * after the last one (`tail`).
 *
 * `ts.isStringLiteralLike` already covers template strings without substitutions (they are literals
 * and use the `name` path), so this handles only actual `ts.TemplateExpression`s with substitutions.
 *
 * **Intermediate literal portions are intentionally discarded**: `` `a${x}b${y}c` `` gives `a`
 * and `c`, not `a…b…c`. The name is a one-line label, not a rendering of the expression that
 * produced it.
 */
function templateAffixes(arg: ts.Expression | undefined): NamePattern | undefined {
  if (arg === undefined || !ts.isTemplateExpression(arg)) return undefined;
  const head = meaningfulAffix(arg.head.text);
  const tail = meaningfulAffix(arg.templateSpans.at(-1)?.literal.text);
  if (head === undefined && tail === undefined) return undefined;
  return {
    ...(head === undefined ? {} : { head }),
    ...(tail === undefined ? {} : { tail }),
  };
}

/**
 * Whether an affix is worth displaying: after trimming it must contain at least one letter or digit.
 *
 * Why this gate exists: the tail of `` agent(`${x}-`) `` is `-`, which renders as `…-`—worse than
 * an unnamed actor because the reader gets no name and an extra punctuation mark. `\p{L}` covers
 * CJK, so `研究员` passes as expected.
 */
function meaningfulAffix(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : undefined;
}

/** world-read label: the op name, plus a string-literal first argument when present. */
export function worldReadLabel(op: WorldReadOp, arg: ts.Expression | undefined): string {
  if (arg !== undefined && ts.isStringLiteralLike(arg)) return `${op} ${arg.text}`;
  return op;
}

export function eachCandidate(
  call: ts.CallExpression,
  semantics: CallbackSemantics,
  order: number,
  loc: ScriptLoc,
): IterationCandidate | undefined {
  const index = semantics.callbacks[0];
  const argument = index === undefined ? undefined : call.arguments[index];
  const iterated = semantics.iterated;
  if (argument === undefined || iterated === undefined) return undefined;
  const literal = ts.isArrowFunction(argument) || ts.isFunctionExpression(argument);
  return {
    body: literal ? argument.body : argument,
    ...(literal ? { callback: argument } : { callbackExpr: argument }),
    call,
    element: literal ? argument.parameters[semantics.elementParams?.[0] ?? 0]?.name : undefined,
    form: "array-method",
    iterated,
    loc,
    method: semantics.label,
    order,
    semantics,
  };
}

export function forOfCandidate(
  statement: ts.ForOfStatement,
  order: number,
  loc: ScriptLoc,
): IterationCandidate {
  let element: ts.BindingName | undefined;
  if (ts.isVariableDeclarationList(statement.initializer)) {
    element = statement.initializer.declarations[0]?.name;
  }
  return {
    body: statement.statement,
    element,
    form: "for-of",
    iterated: statement.expression,
    loc,
    order,
  };
}
