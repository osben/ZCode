import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IVoiceDictationService } from "@zcode/services";
import {
  applyIdleUnloadPreference,
  resetIdleUnloadPreferenceForTests,
} from "@/lib/voiceIdleUnload.js";

vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("applyIdleUnloadPreference", () => {
  beforeEach(() => {
    resetIdleUnloadPreferenceForTests();
  });

  it("sends the newest value when a newer request arrives while an older RPC is pending", async () => {
    const service = { setIdleUnloadMinutes: vi.fn() };
    const first = deferred();
    service.setIdleUnloadMinutes
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const host = service as unknown as IVoiceDictationService;

    // Cache 5 minutes as the applied value.
    await applyIdleUnloadPreference(host, 5);
    // 10 is sent and held pending; 5 is requested while that RPC is still unresolved.
    const pendingTen = applyIdleUnloadPreference(host, 10);
    const latestFive = applyIdleUnloadPreference(host, 5);
    await Promise.resolve();
    expect(service.setIdleUnloadMinutes.mock.calls.map(([minutes]) => minutes)).toEqual([5, 10]);

    first.resolve();
    await Promise.all([pendingTen, latestFive]);
    // The 5 request was not suppressed by the pending 10: the Host now receives the latest value.
    expect(service.setIdleUnloadMinutes.mock.calls.map(([minutes]) => minutes)).toEqual([5, 10, 5]);
  });

  it("skips the RPC when the value equals the last value actually sent", async () => {
    const service = { setIdleUnloadMinutes: vi.fn().mockResolvedValue(undefined) };
    const host = service as unknown as IVoiceDictationService;

    await applyIdleUnloadPreference(host, 5);
    await applyIdleUnloadPreference(host, 5);
    expect(service.setIdleUnloadMinutes).toHaveBeenCalledTimes(1);
  });

  it("keeps the queue moving after a failed apply", async () => {
    const service = {
      setIdleUnloadMinutes: vi
        .fn()
        .mockRejectedValueOnce(new Error("host unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const host = service as unknown as IVoiceDictationService;

    await expect(applyIdleUnloadPreference(host, 10)).rejects.toThrow("host unavailable");
    await applyIdleUnloadPreference(host, 5);
    expect(service.setIdleUnloadMinutes.mock.calls.map(([minutes]) => minutes)).toEqual([10, 5]);
  });
});
