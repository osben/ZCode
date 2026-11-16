import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getInfoValueForKey: () => "dev.zcode.app" },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
    askForMediaAccess: vi.fn(),
  },
}));

import { resolveMicrophoneReset } from "../src/main/microphone-access/desktopMicrophoneAccess.js";

function makeSeeds(options: {
  statuses: MicrophoneStatusSequence;
  askResult?: boolean;
  resetResult?: boolean;
}) {
  const calls = { status: 0, ask: 0, reset: 0 };
  return {
    calls,
    status: async () => options.statuses[Math.min(calls.status++, options.statuses.length - 1)]!,
    ask: async () => {
      calls.ask += 1;
      return options.askResult ?? true;
    },
    resetTcc: async () => {
      calls.reset += 1;
      return options.resetResult ?? true;
    },
  };
}

type MicrophoneStatusSequence = Array<"granted" | "denied" | "restricted" | "not-determined">;

describe("resolveMicrophoneReset state machine", () => {
  it("never resets an existing grant", async () => {
    const seeds = makeSeeds({ statuses: ["granted"] });
    await expect(resolveMicrophoneReset({ ...seeds, canResetTcc: true })).resolves.toBe("granted");
    expect(seeds.calls.reset).toBe(0);
  });

  it("dev builds without tccutil ask for a restart instead of resetting", async () => {
    const seeds = makeSeeds({ statuses: ["denied"] });
    await expect(resolveMicrophoneReset({ ...seeds, canResetTcc: false })).resolves.toBe(
      "restart-required",
    );
    expect(seeds.calls.reset).toBe(0);
  });

  it("a failed tccutil run reports failure without asking", async () => {
    const seeds = makeSeeds({ statuses: ["denied"], resetResult: false });
    await expect(resolveMicrophoneReset({ ...seeds, canResetTcc: true })).resolves.toBe("failed");
    expect(seeds.calls.ask).toBe(0);
  });

  it("a reset followed by a prompt grant resolves granted", async () => {
    const seeds = makeSeeds({ statuses: ["denied", "not-determined"], askResult: true });
    await expect(resolveMicrophoneReset({ ...seeds, canResetTcc: true })).resolves.toBe("granted");
    expect(seeds.calls.reset).toBe(1);
    expect(seeds.calls.ask).toBe(1);
  });

  it("a declined fresh prompt resolves denied", async () => {
    const seeds = makeSeeds({ statuses: ["denied", "not-determined"], askResult: false });
    await expect(resolveMicrophoneReset({ ...seeds, canResetTcc: true })).resolves.toBe("denied");
  });

  it("a still-denied record after the reset requires a restart", async () => {
    // TCC only re-reads on next launch: the process keeps seeing the stale denial.
    const seeds = makeSeeds({ statuses: ["denied", "denied"] });
    await expect(resolveMicrophoneReset({ ...seeds, canResetTcc: true })).resolves.toBe(
      "restart-required",
    );
    expect(seeds.calls.ask).toBe(0);
  });
});
