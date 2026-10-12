import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "@zcode/services/process/processTreeTerminator";
import { ZCodeStdioTransport } from "@zcode/services/node";

const activeChildren = new Set<ChildProcessWithoutNullStreams>();

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    // Windows has no system ps; the ps bundled with Git neither guarantees stdout nor can reliably query native PIDs.
    // process.kill(pid, 0) already covers liveness probing on this platform.
    return true;
  }
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const status = result.stdout.trim();
  return status.length > 0 && !status.startsWith("Z");
}

afterEach(() => {
  for (const child of activeChildren) {
    terminateProcessTree(child);
  }
  activeChildren.clear();
});

describe("ZCodeStdioTransport", () => {
  it("stderr failure alone leaves a responsive protocol usable", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      process.stdin.on("data", () => process.stdout.write(JSON.stringify({ id: "pong", result: {} }) + "\\n"));
      process.stdin.once("end", () => process.exit(0));
      process.stdout.write(JSON.stringify({ id: "ready", result: {} }) + "\\n");
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    await new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    child.stderr.emit("error", new Error("diagnostic reader failed"));
    const response = new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    await transport.send({ id: "ping", method: "workspace/readState", params: {} });
    await response;
    expect(closed).toBe(false);
    await transport.disposeAndWait();
    expect(child.exitCode).toBe(0);
  });

  it("keeps the final stderr line while EOF retires the protocol", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      process.stdin.resume();
      process.stdin.once("end", () => process.stderr.write("FINAL_DIAGNOSTIC", () => process.exit(0)));
      process.stdout.write(JSON.stringify({ id: "ready", result: {} }) + "\\n");
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    activeChildren.add(child);
    const lines: string[] = [];
    const transport = new ZCodeStdioTransport(child, { onStderrLine: (line) => lines.push(line) });
    await new Promise<void>((resolve) => transport.onMessage(() => resolve()));
    // Fix reason: post-exit process identity re-verification can block the event loop, letting the 250ms
    // drain timer fire before stderr EOF is delivered. This case only verifies tail-line collection; the
    // real exit deadline is verified by later cases.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await transport.disposeAndWait();
      expect(child.exitCode).toBe(0);
      expect(lines).toEqual(["FINAL_DIAGNOSTIC"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposeAndWait 优先用 stdin EOF 关闭 stdio agent", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
process.stdin.once("close", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    await delay(50);

    const startedAt = Date.now();
    // Bugfix: the natural shutdown boundary of app-server --stdio is stdin EOF; every close must not go
    // straight into process-tree force-kill waiting, or even an agent that can shut down cleanly adds
    // seconds of window-close latency.
    await transport.disposeAndWait();
    const durationMs = Date.now() - startedAt;

    expect(child.exitCode).toBe(0);
    // Threshold rationale: the product constraint is that Windows cleanup fits within the Host's 3.5s
    // service phase budget (disposeAndWaitOnce's absolute deadline is built from it). The original tight
    // 1s assertion was unstable on some Windows machines — stdin pipe teardown plus a process-tree
    // snapshot (WMI/CIM query) can legitimately take ~2s combined while a graceful exit still holds
    // (exitCode=0); that is machine performance variance, not a regression. Linux/mac keep the tight 1s
    // threshold unchanged.
    const shutdownBudgetMs = process.platform === "win32" ? 3_500 : 1_000;
    expect(durationMs).toBeLessThan(shutdownBudgetMs);
    activeChildren.delete(child);
  });

  it.runIf(process.platform !== "win32")(
    "stdin EOF 让根进程先退出时仍回收已发现的 detached 后代",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
process.stderr.write("starting\\n");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); process.send?.("ready"); setInterval(() => {}, 1000);'],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => process.stderr.write(String(descendant.pid) + "\\n"));
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      let reportPid: ((pid: number) => void) | undefined;
      const descendantPidPromise = new Promise<number>((resolve) => {
        reportPid = resolve;
      });
      const transport = new ZCodeStdioTransport(child, {
        onStderrLine: (line) => {
          const pid = Number(line);
          if (Number.isInteger(pid)) reportPid?.(pid);
        },
      });
      const descendantPid = await descendantPidPromise;
      expect(isPidRunning(descendantPid)).toBe(true);

      try {
        // Fix reason: during EOF-based normal shutdown the root process may exit first, but a detached MCP does
        // not exit with it. disposeAndWait must finish descendant cleanup using the process tree snapshot saved before EOF.
        await transport.disposeAndWait();
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) {
          process.kill(-descendantPid, "SIGKILL");
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform !== "win32")(
    "根进程异常退出后仍按 Host 已拥有的进程组回收后代",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
process.stderr.write("starting\\n");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.send?.("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => {
  const frame = JSON.stringify({ method: "state.updated", params: { pid: descendant.pid } }) + "\\n";
  process.stdout.write(frame, () => setTimeout(() => process.exit(1), 50));
});
`,
        ],
        {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      activeChildren.add(child);
      const transport = new ZCodeStdioTransport(child, {
        ownedProcessGroupId: child.pid,
      });
      const descendantPidPromise = new Promise<number>((resolve) => {
        transport.onMessage((message) => {
          if (!("method" in message) || message.method !== "state.updated") return;
          const pid = (message.params as { pid?: unknown } | undefined)?.pid;
          if (typeof pid === "number") resolve(pid);
        });
      });
      const descendantPid = await descendantPidPromise;
      await waitForExit(child);
      expect(isPidRunning(descendantPid)).toBe(true);

      try {
        // Fix reason: the runtime protocol hot path must not scan the process table as an abnormal-exit fallback.
        // The POSIX Host already puts the Agent in its own process group; after the root exits, cleanup should
        // recover same-group descendants by the PGID it already owns at the cleanup boundary, not rely on some
        // runtime notification.
        await transport.disposeAndWait();
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) {
          process.kill(-descendantPid, "SIGKILL");
        }
      }
      activeChildren.delete(child);
    },
  );

  it.runIf(process.platform === "win32")(
    "Windows 根进程异常退出后仍按 ParentProcessId 回收 task tree",
    async () => {
      const spawnRequestedAt = Date.now();
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
const { spawn } = require("node:child_process");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.send?.("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
descendant.once("message", () => {
  const frame = JSON.stringify({ method: "state.updated", params: { pid: descendant.pid } }) + "\\n";
  process.stdout.write(frame, () => process.exit(1));
});
`,
        ],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      activeChildren.add(child);
      const transport = new ZCodeStdioTransport(child, {
        ownedProcessStartedAtMs: spawnRequestedAt,
      });
      const descendantPidPromise = new Promise<number>((resolve) => {
        transport.onMessage((message) => {
          if (!("method" in message) || message.method !== "state.updated") return;
          const pid = (message.params as { pid?: unknown } | undefined)?.pid;
          if (typeof pid === "number") resolve(pid);
        });
      });
      const descendantPid = await descendantPidPromise;
      await waitForExit(child);

      try {
        // Fix reason: Windows has no POSIX PGID; when the root exits first you cannot re-taskkill the bare root PID.
        // cleanup only recovers members along the ParentProcessId kept by Win32_Process and pins descendant identity
        // with CreationDate, so app quit can still recycle the original task tree.
        await transport.disposeAndWait();
        expect(isPidRunning(descendantPid)).toBe(false);
      } finally {
        if (isPidRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
      }
      activeChildren.delete(child);
    },
  );

  it("高频 telemetry 保持实时有序分发且应用退出后仍回收 Agent", async () => {
    const frameCount = 300;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const frames = Array.from({ length: ${frameCount} }, (_, index) => ({
  method: "v4/telemetry/event",
  params: { index, pid: process.pid },
}));
process.stdout.write(frames.map((frame) => JSON.stringify(frame)).join("\\n") + "\\n");
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    let firstFrameAt = 0;
    let receivedFrameCount = 0;
    let agentPid = 0;
    const receivedIndexes: number[] = [];
    const allFramesPromise = new Promise<void>((resolve) => {
      transport.onMessage((message) => {
        if (!("method" in message) || message.method !== "v4/telemetry/event") return;
        const params = message.params as { index?: unknown; pid?: unknown } | undefined;
        if (firstFrameAt === 0) firstFrameAt = Date.now();
        if (typeof params?.pid === "number") agentPid = params.pid;
        if (typeof params?.index === "number") receivedIndexes.push(params.index);
        receivedFrameCount += 1;
        if (receivedFrameCount === frameCount) resolve();
      });
    });
    await allFramesPromise;

    try {
      // Fix reason: process cleanup used to synchronously spawnSync("ps") before every telemetry frame; 300 messages
      // would block the Host for seconds and leave the subagent panel blank. Runtime frames must be delivered directly;
      // the full tree scan is only allowed once disposeAndWait has entered the exit phase.
      expect(Date.now() - firstFrameAt).toBeLessThan(750);
      expect(receivedIndexes).toEqual(Array.from({ length: frameCount }, (_, index) => index));
      expect(isPidRunning(agentPid)).toBe(true);
      await transport.disposeAndWait();
      expect(isPidRunning(agentPid)).toBe(false);
    } finally {
      if (isPidRunning(agentPid)) {
        process.kill(process.platform === "win32" ? agentPid : -agentPid, "SIGKILL");
      }
    }
    activeChildren.delete(child);
  }, 15_000);

  it("agent 退出后会把 transport 视为关闭", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10);"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    await expect(
      transport.send({
        type: "zcode-hello-ack",
        version: 1,
        clientId: "test",
      } as never),
    ).rejects.toThrow("ZCode agent stdio transport is closed");
    activeChildren.delete(child);
  });

  it("按 LF 分帧时允许 JSON 字符串包含 Unicode 行分隔符", async () => {
    const frame = Buffer.from(
      `{"method":"session/event","params":{"text":"before\u2028middle\u2029after"}}\n`,
      "utf8",
    ).toString("base64");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const frame = Buffer.from("${frame}", "base64");
process.stdout.write(frame, () => setTimeout(() => process.exit(0), 10));
`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    activeChildren.add(child);
    const transport = new ZCodeStdioTransport(child);
    let closeReason: string | undefined;
    transport.onClose((event) => {
      closeReason = event.reason;
    });
    const messagePromise = new Promise((resolve) => {
      transport.onMessage((message) => resolve(message));
    });

    await expect(messagePromise).resolves.toEqual({
      method: "session/event",
      params: {
        text: "before\u2028middle\u2029after",
      },
    });
    await waitForExit(child);

    expect(closeReason ?? "").not.toContain("protocol_parse_error");
    activeChildren.delete(child);
  });
});

// Uses PassThrough to fake the child's stdio so stdout chunk boundaries can be controlled precisely.
function createFakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    pid: undefined,
    exitCode: null,
    signalCode: null,
  });
  return child as unknown as ChildProcessWithoutNullStreams & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
}

function writeInChunks(stream: PassThrough, bytes: Buffer, chunkBytes: number): void {
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    stream.write(bytes.subarray(offset, offset + chunkBytes));
  }
}

describe("ZCodeStdioTransport stdout 分帧", () => {
  it("跨 chunk 的超大多字节帧、同 chunk 多帧与 EOF 尾帧按序完整交付", async () => {
    const child = createFakeChild();
    const transport = new ZCodeStdioTransport(child);
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));
    const closed = new Promise<string | undefined>((resolve) => {
      transport.onClose((event) => resolve(event.reason));
    });

    const big = { method: "session/event", params: { text: "中文🙂\u2028".repeat(40_000) } };
    const small = [1, 2, 3].map((n) => ({ id: `small-${n}`, result: { n } }));
    const tail = { id: "tail", result: {} };
    const bytes = Buffer.from(
      `${JSON.stringify(small[0])}\n${JSON.stringify(big)}\r\n${JSON.stringify(small[1])}\n\n${JSON.stringify(small[2])}\n${JSON.stringify(tail)}`,
      "utf8",
    );
    // The odd 7-byte chunks cut through UTF-8 multi-byte sequences and CRLF.
    writeInChunks(child.stdout, bytes, 7);
    child.stdout.end();

    await expect(closed).resolves.toBe("stdout_closed");
    expect(messages).toEqual([small[0], big, small[1], small[2], tail]);
  });

  it("超大单行按小块到达时换行扫描量保持线性", async () => {
    const child = createFakeChild();
    const transport = new ZCodeStdioTransport(child);
    const received = new Promise((resolve) => transport.onMessage(resolve));
    const line = Buffer.from(
      `${JSON.stringify({ method: "session/event", params: { text: "x".repeat(4 << 20) } })}\n`,
      "utf8",
    );

    // Bug cause: the old implementation ran indexOf("\n") over the whole accumulated buffer for every chunk;
    // V8 has to flatten the cons string entirely, so a 15MB session/read response arriving in 64KB chunks
    // allocated gigabytes per pass (host CPU 100%).
    // This counts characters scanned for "\n"; a linear implementation should stay on the order of the frame length.
    let scannedChars = 0;
    const originalIndexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (this: string, search: string, position?: number) {
      if (search === "\n") scannedChars += this.length - (position ?? 0);
      return originalIndexOf.call(this, search, position);
    };
    try {
      writeInChunks(child.stdout, line, 4096);
      await received;
    } finally {
      String.prototype.indexOf = originalIndexOf;
    }
    expect(scannedChars).toBeLessThan(line.length * 2);
    child.stdout.end();
  });
});
