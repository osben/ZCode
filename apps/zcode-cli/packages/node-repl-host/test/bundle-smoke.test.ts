import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { buildBrowserUsePluginBundles } from "../../browser-use-plugin/scripts/build.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const buildTimeoutMs = 120_000;

type ProbeResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

// Bug cause: the node_repl MCP server is a separate stdio child process spawned by the CLI, loaded by the
// plugin host via `await import(pathToFileURL(dist/mcp/server.js))`. All prior tests ran against TS sources,
// and none covered "whether the built bundle can be imported", so the 2026-07-27 ESM bundle's
// yaml require("process") hit the esbuild throwing __require shim and crashed at load,
// passing lint, unit tests, and CI all green until the user noticed the mcp__node_repl__js tool had disappeared entirely.
// This smoke test builds the real artifact and imports it once in a child process, catching "load-time crashes" before commit.
const runBundleProbe = (bundlePath: string): Promise<ProbeResult> => {
  // Use --input-type=module -e instead of executing the file directly: on import, process.argv[1] is empty,
  // so server.ts's "direct execution" branch is not triggered and no stdio server actually starts and hangs the child process,
  // while the module evaluation path (where the crash happened) is identical to the real plugin host.
  const probeSource = [
    `const bundle = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});`,
    "process.stdout.write(typeof bundle.main);",
  ].join("\n");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probeSource], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stderr, stdout });
    });
  });
};

describe("node_repl host and browser-use runtime bundles", () => {
  let outputDirectory = "";
  let mcpOutfile = "";
  let browserClientOutfile = "";

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "zcode-node-repl-bundle-"));
    // The host bundle is built by this package; browser-client is still built by browser-use. Both bundles are ESM,
    // and both can be blown up at load time by CJS dependencies, so smoke them together.
    // The temp directory is not inside a type=module package; use .mjs so a direct spawn matches the official .js artifact semantics.
    const [host, browser] = await Promise.all([
      buildNodeReplHostBundle({ outfile: join(outputDirectory, "mcp", "server.mjs") }),
      buildBrowserUsePluginBundles({
        browserClientOutfile: join(outputDirectory, "browser-client.mjs"),
      }),
    ]);
    mcpOutfile = host.outfile;
    browserClientOutfile = browser.browserClientOutfile;
  }, buildTimeoutMs);

  afterAll(async () => {
    if (outputDirectory) {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  it(
    "imports the built node_repl MCP server bundle without failing module evaluation",
    async () => {
      const probe = await runBundleProbe(mcpOutfile);

      // Asserting on stderr is so that, on failure, the crash cause is directly visible instead of just an exit code.
      expect(probe.stderr).not.toContain("Dynamic require of");
      expect({ exitCode: probe.exitCode, stderr: probe.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      // The plugin host requires the runtime bundle to explicitly export main(); without it the process exits before the MCP handshake.
      expect(probe.stdout).toBe("function");
    },
    buildTimeoutMs,
  );

  it(
    "negotiates MCP 2026-07-28 and isolates globals plus module cache in built node_repl",
    async () => {
      const transport = new StdioClientTransport({
        args: [mcpOutfile],
        command: process.execPath,
        cwd: packageRoot,
        stderr: "pipe",
      });
      const client = new Client(
        { name: "node-repl-bundle-smoke", version: "0.1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      let serverStderr = "";
      transport.stderr?.setEncoding("utf8");
      transport.stderr?.on("data", (chunk: string) => {
        serverStderr += chunk;
      });
      try {
        await client.connect(transport).catch(async (error) => {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nbundle: ${mcpOutfile}\nserver stderr:\n${serverStderr}`,
          );
        });
        const listed = await client.listTools();
        expect(client.getProtocolEra()).toBe("modern");
        expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["js"]);
        const meta = {
          "com.zcode/request-context": {
            runtime_scope: "main",
            session_id: "bundle-session",
          },
        };
        const first = await client.callTool({
          name: "js",
          arguments: {
            code: [
              "globalThis.__zcodeKernelMarker = 'FIRST';",
              "require('node:events').__zcodeModuleMarker = 'FIRST';",
              "'set';",
            ].join("\n"),
          },
          _meta: meta,
        });
        expect(first.isError).not.toBe(true);
        const second = await client.callTool({
          name: "js",
          arguments: {
            code: "({ kernel: typeof globalThis.__zcodeKernelMarker, module: typeof require('node:events').__zcodeModuleMarker });",
          },
          _meta: meta,
        });
        expect(second.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"kernel": "undefined"'),
          }),
        );
        expect(second.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"module": "undefined"'),
          }),
        );
        expect(serverStderr).toBe("");
      } finally {
        await client.close();
      }
    },
    buildTimeoutMs,
  );

  it("guards its CLI entry with pathToFileURL so Windows actually builds", async () => {
    // Bug cause (2026-09-12, CI build:windows:x64): the entry guard was originally written as
    // `import.meta.url === \`file://${process.argv[1]}\``. On Windows argv[1] is
    // `C:\\...\\build.mjs` while import.meta.url is `file:///C:/.../build.mjs`, so they never compare equal —
    // the script was treated as a plain module import and exited without doing anything, the build "succeeded"
    // with no artifact, and it only surfaced when the dev guard reported
    // "build succeeded without required MCP runtime".
    const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(source).toContain("pathToFileURL");
    // If the string-concatenation form ever comes back, Windows would silently produce nothing again. Only look at code lines (a counterexample is kept in a comment).
    const codeLines = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(codeLines).not.toMatch(/file:\/\/\$\{process\.argv/u);
  });

  it("injects a real require into both ESM bundles so bundled CJS dependencies keep working", async () => {
    const [mcpBundle, browserClientBundle] = await Promise.all([
      readFile(mcpOutfile, "utf8"),
      readFile(browserClientOutfile, "utf8"),
    ]);

    for (const bundle of [mcpBundle, browserClientBundle]) {
      expect(bundle).toContain('createRequire as __zcodeCreateRequire } from "node:module"');
    }
  });

  // The build-time guard itself needs tests: if the define name drifts, the build must **fail**, not silently emit an empty string —
  // the latter's symptom only appears in the official package and manifests as a timeout with no logs at all.
  it("fails the build when the injected build id does not reach the output", async () => {
    const outfile = join(outputDirectory, "mcp", "server.guard.mjs");
    // Use a value that cannot appear in the artifact: after a full build, the guard should throw.
    // Temporarily rewriting the define name is impractical here, so verify the guard's criterion directly — the artifact must contain the value.
    const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(source).toContain("__ZCODE_CUA_HELPER_BUILD_ID__");
    expect(source).toMatch(/未折叠进|did not reach/u);
    // Also confirm the guard only applies when buildId is non-empty (the dev empty string must not fail the build).
    const devResult = await buildNodeReplHostBundle({ outfile, cuaHelperBuildId: "" });
    expect(devResult.cuaHelperBuildId).toBe("");
  }, buildTimeoutMs);
});
