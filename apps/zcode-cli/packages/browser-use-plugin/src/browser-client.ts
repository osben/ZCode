// Importing from the @zcode/core root barrel makes esbuild trace Agent/tool modules with top-level side effects,
// bundling the Bash registry, subagents, and runtime into the official plugin. Browser artifacts must depend only on narrow subpaths.
import { setupBrowserRuntime as setupCoreBrowserRuntime } from "@zcode/core/browser-client";
import { readNodeReplBrowserRuntimeBridge } from "@zcode/node-repl-host/runtime-bridge";

export async function setupBrowserRuntime(input: {
  globals: Record<PropertyKey, unknown>;
}): Promise<void> {
  const bridge = readNodeReplBrowserRuntimeBridge(input.globals);
  bridge.assertAvailable();
  setupCoreBrowserRuntime({
    globals: input.globals as Record<string, unknown>,
    transport: bridge,
    documentationRoot: bridge.documentationRoot,
    assertAvailable: bridge.assertAvailable,
  });
}
