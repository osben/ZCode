import { parseModule, type ESTree } from "meriyah";

/**
 * Pure functions for REPL code instrumentation (strategy B: top-level bindings persist across calls).
 *
 * Why: NodeReplSession wraps user code in `(async () => {...})()` to support top-level await, which captures top-level
 * `const/let/var/function/class` declarations in the IIFE's local scope instead of the persistent vm context. Use meriyah
 * to find top-level declarations and inject `globalThis.<name> = <name>;` after each declaration,
 * copying bindings into the persistent context so bare names in the next `js` call resolve to globalThis through the scope chain.
 *
 * This module is an A-ready seam: if `--experimental-vm-modules` becomes available for upgrading to SourceTextModule (strategy A),
 * only the executor needs replacement and a harvest-style instrument needs to be added; `parseReplCode`/`collectTopLevelBindingNames` can be reused
 * (changing the parser requires edits only inside parseReplCode).
 */

/** Result of parseReplCode: success carries the AST; failure carries parseError (does not throw, allowing callers to fall back). */
export type ParseReplCodeResult = { ast: ESTree.Program } | { parseError: Error };

/**
 * Parse REPL code into an ESTree AST. Wrap meriyah.parseModule here so parser implementation changes stay localized (A-ready seam).
 * Use module mode + next for current syntax; ranges attach start/end to each node (needed for instrumentation slices).
 * On parse failure return { parseError } and never throw (callers use it to fall back to unchanged execution).
 */
export function parseReplCode(code: string): ParseReplCodeResult {
  try {
    const ast = parseModule(code, { next: true, ranges: true });
    return { ast };
  } catch (error) {
    return { parseError: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Recursively collect all identifier names declared by a binding pattern.
 * Supports Identifier / ObjectPattern (including shorthand and RestElement) / ArrayPattern (including holes and RestElement)
 * / AssignmentPattern (default values) / RestElement.
 */
function collectPatternNames(node: ESTree.Node | null | undefined, out: string[]): void {
  if (!node) {
    // ArrayPattern holes (elisions) are null; skip them.
    return;
  }
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        // In pattern context meriyah emits RestElement/Property, but the type annotation is broad
        // (ObjectLiteralElementLike includes SpreadElement), so narrow by type one case at a time.
        const p = prop as ESTree.Node;
        if (p.type === "RestElement") {
          collectPatternNames(p.argument, out);
        } else if (p.type === "Property") {
          // The destructured binding is value (`xx` in `{x:xx}`; for shorthand `{x}`, value is also x).
          collectPatternNames(p.value as ESTree.Node, out);
        } else if (p.type === "SpreadElement") {
          // Defensive case: if a pattern is unusually marked as SpreadElement, collect its argument too.
          collectPatternNames(p.argument as ESTree.Node, out);
        }
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements) {
        collectPatternNames(el, out);
      }
      return;
    case "AssignmentPattern":
      // For `const {x = 1} = o` / `const [a = 1] = arr`, the binding name is in left.
      collectPatternNames(node.left, out);
      return;
    case "RestElement":
      collectPatternNames(node.argument, out);
      return;
    default:
      // Ignore non-declaration targets such as MemberExpression (destructuring assignment to an existing property); they create no new binding.
      return;
  }
}

/** Collect all binding names declared by one top-level declaration (used for per-statement instrumentation). */
function collectStatementBindingNames(node: ESTree.Node): string[] {
  const names: string[] = [];
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations) {
      collectPatternNames(decl.id, names);
    }
  } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    if (node.id) {
      names.push(node.id.name);
    }
  }
  return names;
}

/**
 * Rewrite dynamic import() in a cell to the injected importModule().
 * vm.Script cannot execute import expressions directly by default, so the executor uses the host loader and replaces only
 * ImportExpression nodes in the AST; strings, comments, and import.meta are unaffected.
 */
export function collectTopLevelBindingNames(ast: ESTree.Program): string[] {
  const names: string[] = [];
  for (const stmt of ast.body) {
    for (const name of collectStatementBindingNames(stmt)) {
      names.push(name);
    }
  }
  // Deduplicate (repeated declarations or same-name statements need only one assignment).
  return [...new Set(names)];
}

/**
 * Rewrite dynamic `import(...)` calls in a cell to the injected `importModule(...)`.
 *
 * Node's vm.Script can execute import expressions directly only when configured with a vm module loader, and desktop/SEA
 * Agents cannot reliably carry `--experimental-vm-modules`. The old contract therefore required the model to write ZCode-specific
 * `importModule(...)`, unlike the standard `await import(...)` used in skills. AST matching replaces only actual
 * ImportExpression nodes; strings, comments, and `import.meta` are unaffected.
 */
export function rewriteDynamicImports(code: string, ast: ESTree.Program): string {
  const starts: number[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { type?: unknown; start?: unknown; range?: unknown };
    if (node.type === "ImportExpression") {
      const start =
        typeof node.start === "number"
          ? node.start
          : Array.isArray(node.range) && typeof node.range[0] === "number"
            ? node.range[0]
            : undefined;
      if (start !== undefined) starts.push(start);
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(ast);
  let rewritten = code;
  for (const start of starts.sort((left, right) => right - left)) {
    rewritten = `${rewritten.slice(0, start)}importModule${rewritten.slice(start + "import".length)}`;
  }
  return rewritten;
}

/**
 * Rewrite dynamic import according to REPL syntax. User code allows top-level return, unlike the module parser; if direct parsing fails,
 * temporarily wrap it in an async function only to get reliable AST ranges, then remove the wrapper. This avoids regex replacement and does not
 * accidentally change `import(` in strings or comments.
 */
export function rewriteDynamicImportsForRepl(code: string): string {
  const direct = parseReplCode(code);
  if ("ast" in direct) return rewriteDynamicImports(code, direct.ast);

  const prefix = "(async () => {\n";
  const suffix = "\n})";
  const wrapped = `${prefix}${code}${suffix}`;
  const wrappedParsed = parseReplCode(wrapped);
  if (!("ast" in wrappedParsed)) return code;
  const rewritten = rewriteDynamicImports(wrapped, wrappedParsed.ast);
  return rewritten.slice(prefix.length, rewritten.length - suffix.length);
}

/** Get a node's end offset; end is guaranteed with ranges:true, and the fallback avoids a type-narrowing issue. */
function nodeEnd(node: ESTree.Node): number {
  const end = node.end ?? node.range?.[1];
  if (end === undefined) {
    throw new Error("instrument 需要节点 end（parseReplCode 应带 ranges:true）");
  }
  return end;
}

/** Get a node's start offset; paired with nodeEnd for slicing the completion value of the final expression statement. */
function nodeStart(node: ESTree.Node): number {
  const start = node.start ?? node.range?.[0];
  if (start === undefined) {
    throw new Error("instrument 需要节点 start（parseReplCode 应带 ranges:true）");
  }
  return start;
}

/**
 * Copy bindings into the persistent context after each top-level declaration and convert the final expression statement to return so the cell's
 * completion value is returned. Inject after each statement so declarations executed before a later statement throws are still preserved.
 */
export function instrumentForContextPersistence(code: string, ast: ESTree.Program): string {
  let cursor = 0;
  let out = "";
  const lastIndex = ast.body.length - 1;
  ast.body.forEach((stmt, index) => {
    // Convert the final top-level expression statement to return so the async IIFE returns its completion value (REPL echo).
    // Do not convert declarations/control-flow statements; their completion value is already undefined, matching REPL semantics.
    if (index === lastIndex && stmt.type === "ExpressionStatement") {
      const stmtStart = nodeStart(stmt);
      const stmtEnd = nodeEnd(stmt);
      // meriyah excludes the outer parentheses from the expression range for `({ value: 1 })`.
      // Inserting return at expression.start would produce invalid syntax `(return ({...});)`; use the whole
      // ExpressionStatement as the boundary and remove only the trailing semicolon.
      const expressionSource = code.slice(stmtStart, stmtEnd).replace(/;\s*$/, "");
      // Preserve the original trivia (whitespace/comments) before this statement, then wrap the full expression in return (...).
      out += code.slice(cursor, stmtStart);
      out += `return (${expressionSource});`;
      cursor = nodeEnd(stmt);
      return;
    }
    const end = nodeEnd(stmt);
    // Preserve the original source through this statement (including leading whitespace/comments and the statement itself).
    out += code.slice(cursor, end);
    cursor = end;
    const names = collectStatementBindingNames(stmt);
    if (names.length > 0) {
      const assigns = names.map((name) => `globalThis.${name}=${name};`).join("");
      out += `;${assigns}`;
    }
  });
  // Preserve the original trailing source after the final statement.
  out += code.slice(cursor);
  return out;
}
