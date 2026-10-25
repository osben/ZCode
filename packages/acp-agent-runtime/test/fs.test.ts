import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTextFileViaBridge, type AcpFsBridge } from "../src/index.js";
import { cleanupTempDir, collectEvents, createTempDir, startMockRuntime } from "./helpers.js";

describe("fs capabilities", () => {
  it("routes read and write through the host bridge", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "read-me.txt"), "file-content", "utf8");
    const writes: { path: string; content: string }[] = [];
    const runtime = await startMockRuntime(cwd, "fs", {
      fs: {
        readFile: (path) => readFile(path, "utf8"),
        writeFile: async (path, content) => {
          writes.push({ path, content });
          await writeFile(path, content, "utf8");
        },
      },
    });
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("fs roundtrip");
      expect(response.stopReason).toBe("end_turn");
      expect(events).toContainEqual({ type: "message_chunk", text: "read:file-content" });
      const realCwd = await realpath(cwd);
      expect(writes).toEqual([
        { path: join(realCwd, "written-by-agent.txt"), content: "out:file-content" },
      ]);
      await expect(readFile(join(cwd, "written-by-agent.txt"), "utf8")).resolves.toBe(
        "out:file-content",
      );
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("advertises fs capabilities only when the bridge provides fs", async () => {
    const cwd = await createTempDir();
    const withoutFs = await startMockRuntime(cwd, "caps");
    try {
      const events = collectEvents(withoutFs);
      await withoutFs.prompt("");
      const text = firstMessageText(events);
      const parsed = JSON.parse(text) as {
        fs?: { readTextFile?: boolean; writeTextFile?: boolean };
      };
      expect(parsed.fs?.readTextFile ?? false).toBe(false);
      expect(parsed.fs?.writeTextFile ?? false).toBe(false);
    } finally {
      await withoutFs.stop();
    }

    const withFs = await startMockRuntime(cwd, "caps", {
      fs: { readFile: async () => "", writeFile: async () => {} },
    });
    try {
      const events = collectEvents(withFs);
      await withFs.prompt("");
      const text = firstMessageText(events);
      const parsed = JSON.parse(text) as {
        fs?: { readTextFile?: boolean; writeTextFile?: boolean };
      };
      expect(parsed.fs).toEqual({ readTextFile: true, writeTextFile: true });
    } finally {
      await withFs.stop();
      await cleanupTempDir(cwd);
    }
  });
});

function firstMessageText(events: { type: string; text?: string }[]): string {
  for (const event of events) {
    if (event.type === "message_chunk" && typeof event.text === "string") return event.text;
  }
  throw new Error("no message_chunk event captured");
}

describe("readTextFileViaBridge", () => {
  const bridge: AcpFsBridge = {
    readFile: async () => "a\nb\nc\nd",
    writeFile: async () => {},
  };

  it("applies line and limit slicing", async () => {
    await expect(
      readTextFileViaBridge(bridge, { sessionId: "s", path: "/x", line: 2, limit: 2 }),
    ).resolves.toEqual({ content: "b\nc" });
    await expect(
      readTextFileViaBridge(bridge, { sessionId: "s", path: "/x", line: 3 }),
    ).resolves.toEqual({ content: "c\nd" });
    await expect(readTextFileViaBridge(bridge, { sessionId: "s", path: "/x" })).resolves.toEqual({
      content: "a\nb\nc\nd",
    });
  });

  it("propagates bridge read errors", async () => {
    const failing: AcpFsBridge = {
      readFile: async () => {
        throw new Error("nope");
      },
      writeFile: async () => {},
    };
    await expect(
      readTextFileViaBridge(failing, { sessionId: "s", path: "/x" }),
    ).rejects.toThrowError("nope");
  });
});
