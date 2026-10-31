import ts from "typescript";
import { isFunctionLike } from "./sites.js";

// causality-order.ts reached oxlint's max-lines limit (400), so pure function-resolution helpers
// (script-function detection, enclosing-function chain, function naming, call declaration
// resolution, recursive SCC precomputation, and binding-name expansion) were moved here; the
// public surface is still exported from causality-order.ts. These functions do not read traversal
// state; they inspect only the AST and checker.

export type ScriptFunction = ts.SignatureDeclaration & { body: ts.Node };

/** Identifiers a binding name introduces (an identifier, or every leaf of a pattern). */
export function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    out.push(...boundIdentifiers(element.name));
  }
  return out;
}

export function asScriptFunction(
  node: ts.Node,
  scriptFile: ts.SourceFile,
): ScriptFunction | undefined {
  if (!isFunctionLike(node)) return undefined;
  if (node.getSourceFile() !== scriptFile) return undefined;
  const body = (node as ts.SignatureDeclaration & { body?: ts.Node }).body;
  return body === undefined ? undefined : (node as ScriptFunction);
}

/** The function-like ancestors of a node, innermost first. */
export function enclosingFunctions(node: ts.Node): ScriptFunction[] {
  const scriptFile = node.getSourceFile();
  const out: ScriptFunction[] = [];
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const fn = asScriptFunction(current, scriptFile);
    if (fn !== undefined) out.push(fn);
  }
  return out;
}

export function functionName(decl: ts.Node): string | undefined {
  // A constructor is named by its class: `new Judge()` inlines as a call labelled "Judge".
  if (ts.isConstructorDeclaration(decl)) {
    const cls = decl.parent;
    return ts.isClassLike(cls) && cls.name !== undefined ? cls.name.text : undefined;
  }
  const named = decl as { name?: ts.Node };
  if (named.name !== undefined && ts.isIdentifier(named.name)) return named.name.text;
  const parent = decl.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

/**
 * The script-local function a call resolves to. `getResolvedSignature` handles the
 * hard shapes (methods, overloads, aliased consts) in one hop; anything outside the
 * authored file (the facade, the stdlib) is not inlinable.
 */
export function resolveCallDeclaration(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  scriptFile: ts.SourceFile,
): ScriptFunction | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined) return undefined;
  return asScriptFunction(declaration, scriptFile);
}

