import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  content: Buffer.alloc(0),
  // Serve at most this many bytes per read call, like a FileHandle that returns short reads.
  chunkSize: 1,
  readCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (path: string) => path),
    open: vi.fn(async () => ({
      stat: async () => ({ isFile: () => true, size: fsMocks.content.length }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        fsMocks.readCalls += 1;
        const count = Math.min(length, fsMocks.chunkSize, fsMocks.content.length - position);
        if (count <= 0) {
          return { bytesRead: 0, buffer };
        }
        fsMocks.content.copy(buffer, offset, position, position + count);
        return { bytesRead: count, buffer };
      },
      close: async () => undefined,
    })),
  };
});

beforeEach(() => {
  vi.resetModules();
  fsMocks.readCalls = 0;
});

afterEach(() => {
  fsMocks.chunkSize = 1;
});

describe("resolveTaskDraftText with short reads", () => {
  it("reads the whole promptFile when FileHandle.read returns fewer bytes than requested", async () => {
    const { resolveTaskDraftText } = await import("../src/main/desktopTaskDraftDeepLink.js");
    // Multi-byte UTF-8 so a truncated prefix would also fail to decode or lose text.
    const text = "# План\n\nСделай ü — шаг 1";
    fsMocks.content = Buffer.from(text, "utf8");
    fsMocks.chunkSize = 3;

    await expect(
      resolveTaskDraftText({ projectPath: "/proj", promptFile: "/proj/plan.md" }),
    ).resolves.toEqual({ ok: true, text });
    expect(fsMocks.readCalls).toBeGreaterThan(1);
  });
});
