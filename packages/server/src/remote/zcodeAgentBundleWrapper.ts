// The remote ZCode Agent runs as a standalone Node process with the compiled zcode.cjs, rather than as a native binary with Node embedded per platform.
// Remote deployment already includes a standalone Node binary for zcode-server.cjs, which the Agent can reuse to run zcode.cjs.
//
// Deployment layout: place zcode.cjs at agents/<provider>/zcode.cjs, then write a same-name wrapper—the executable entry point
// expected by the resolver (for example, agents/glm/zcode-agent)—which uses remote Node to run zcode.cjs.
// The provider runtime resolver can keep looking for the zcode-agent executable without distinguishing native and JS runtimes.
// Development and production share the same wrapper semantics.

export const REMOTE_AGENT_BUNDLE_NAME = "zcode.cjs";

export function buildRemoteAgentBundleWrapper(runtimeResourceDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'runtime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}"',
    `exec "$runtime_root/node" "$HOME/.zcode/server/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}" "$@"`,
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
): boolean {
  return content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir);
}
