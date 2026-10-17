import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpSessionRuntime } from "../src/index.js";
import { MOCK_AGENT_PATH, createTempDir, cleanupTempDir } from "./helpers.js";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ACP owned process tree", () => {
  it("cleans a TERM-resistant descendant after its parent exits on EOF", async () => {
    const cwd = await createTempDir();
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    let runtime: AcpSessionRuntime | undefined;
    let descendant: number | undefined;
    const code = `import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {stdio:['ignore','ignore','ignore','ipc']});
      await new Promise(r=>child.once('message',r));
      process.stderr.write('OWNED_DESCENDANT='+child.pid+'\\n');
      process.stdin.on('end',()=>process.exit(0));
      await import(${JSON.stringify(pathToFileURL(MOCK_AGENT_PATH).href)});`;
    try {
      runtime = await AcpSessionRuntime.start(
        {
          agentId: "tree-test",
          command: process.execPath,
          args: ["--input-type=module", "-e", code],
          cwd,
          timeouts: { initializeMs: 8000, newSessionMs: 8000, stopGraceMs: 200, killGraceMs: 200 },
        },
        {},
      );
      descendant = Number(runtime.stderrTail().match(/OWNED_DESCENDANT=(\d+)/)?.[1]);
      expect(descendant).toBeGreaterThan(1);
      await runtime.stop();
      expect(runtime.state).toBe("stopped");
      expect(alive(descendant)).toBe(false);
      await runtime.stop();
      expect(alive(sentinel.pid!)).toBe(true);
    } finally {
      await runtime?.stop();
      if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
      sentinel.kill("SIGKILL");
      await cleanupTempDir(cwd);
    }
  }, 15000);
});
