// The previous default matched the model's common 30-second page wait, so sending could
// finish successfully and then be aborted before the result was read.
// The execution layer and model-visible description share this constant to keep the
// actual timeout aligned with the tools/list description.
export const NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000;

// MCP serverInfo had long been hard-coded to 0.1.0, diverging from plugin releases and
// preventing the host from identifying which Browser Use runtime was loaded. Keep it in
// sync with package.json when upgrading.
// This is the host's version, not the browser-use plugin's version. The number was
// retained when the host became @zcode/node-repl-host because it had always been the
// version advertised by the node_repl server; changing it would needlessly change the
// protocol. From now on it tracks changes to the host contract (bridge members and tool
// surface), independently of either plugin's version.
// Bump to 0.5.0: the host contract changed (node_repl was extracted from browser-use into
// its own seed unit, and the tool surface was adjusted for the rebuilt CUA node_repl SDK),
// so the rule above requires a bump. Matching browser-use 0.5.0 is historical coincidence;
// the versions remain independent.
// Bump to 0.6.0: the tool surface now contains only `js`; remove `js_reset`,
// `js_add_node_module_dir`, and moduleDirs. Since the fresh-kernel redesign,
// js_reset has been a no-op that always succeeds; “never fails” encouraged repeated
// model calls that kept consuming budget. moduleDirs pushed a host responsibility to the
// model, which cannot know which node_modules directory to pass. Only skill docs could
// provide that path, and the host can inject it directly. Both tools had zero observed
// calls. When the host protocol changes, update serverInfo so the host can identify which
// generation of the tool surface it connected to.
export const NODE_REPL_SERVER_VERSION = "0.6.0";

// node_repl provides general-purpose JS, but the old descriptions did not define a model
// routing boundary, so non-browser tasks could also select this high-privilege tool.
// Browser Use and Computer Use are valid entry points, so both server and tool
// descriptions must explicitly limit the scope.
export const NODE_REPL_SERVER_INSTRUCTIONS =
  "Browser Use and Computer Use only. Use `js` to run JavaScript in a fresh Node-backed kernel only when " +
  "the corresponding official skill instructs you to control a browser or computer. Do not use this server for unrelated tasks, " +
  "including general-purpose JavaScript, filesystem, shell, package inspection, or data processing. " +
  `Calls default to a ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms timeout. ` +
  "Always provide `title` as a short user-facing description in the user's language. " +
  "Every `js` call starts fresh; reconstruct browser wrappers and recover persistent tabs from current BrowserControl facts.";

export const JS_TOOL_DESCRIPTION =
  "Browser Use and Computer Use only. Run JavaScript in a fresh Node-backed kernel with top-level await only as " +
  "instructed by the corresponding official skill to control a browser or computer. Do not use it as a general-purpose JavaScript runtime " +
  "or for filesystem, shell, package inspection, data processing, or other non-browser work. " +
  "Always provide the required `title` as a short " +
  "user-facing description in the user's language without implementation terms. If `timeout_ms` is omitted, execution times out " +
  `after ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms. If the code may take more than 30000 ms including all awaited operations, you MUST set \`timeout_ms\` to at least the estimated total runtime plus 15000 ms; split the work into multiple calls if that exceeds the 120000 ms maximum. Use \`nodeRepl.cwd\`, \`nodeRepl.homeDir\`, \`nodeRepl.tmpDir\`, ` +
  "`nodeRepl.requestMeta`, `nodeRepl.setResponseMeta(meta)`, `nodeRepl.write(value)`, and " +
  "`await nodeRepl.emitImage(imageLike)`. Global bindings and module cache do not persist across calls. " +
  "For Computer Use SDK results, do not console.log/JSON.stringify the complete result or call " +
  "nodeRepl.emitImage yourself; the SDK submits the structured image/state result and you should " +
  "use nodeRepl.write for short text-only status. `get_app_state` is an explicit observation: " +
  "assign it to `const state`, always call `nodeRepl.write(state.text)`, and use " +
  "`state.state_id` plus `state.elements[*].index` for element targets; do not leave " +
  "get_app_state as the final expression or regex state_id from its text. " +
  "Metadata methods such as list_apps and list_windows may not return " +
  "action_sent; a missing field is not a failure, so inspect text or structuredContent. " +
  "Never use screenshot_display.bounds or app/window bounds as raster pixel coordinates; " +
  "x/y must be integer pixels inside the width/height of the returned raster. " +
  "Every Computer Use JavaScript call must start with the complete SDK bootstrap in the same cell " +
  "before agent.computerUse; never split bootstrap and action across calls. Never rely on agent, " +
  "runtime, browser, or imported bindings from an earlier call. " +
  "Import only `node:*` builtins and absolute `file://` URLs built from the official skill root, " +
  'for example `await import(pathToFileURL(join(root, "scripts", "client.mjs")).href)`; ' +
  "bare package specifiers do not resolve. Bootstrap the requested official capability in every call.";
