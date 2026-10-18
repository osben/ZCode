import { describe, expect, it, vi } from "vitest";
import { INCOGNITO_UNSUPPORTED_ERROR } from "@zcode/shared";
import {
  ensureIncognitoSupport,
  ensureIndependentPlanSupport,
} from "../src/zcode-agent/runtimeCapabilitySupport.js";

describe("独立 Plan 执行端能力", () => {
  it("复用同一 CLI 的成功检查，重建 CLI 后重新检查", async () => {
    const first = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await ensureIndependentPlanSupport(first as never);
    await ensureIndependentPlanSupport(first as never);
    expect(first.request).toHaveBeenCalledTimes(1);
    const second = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await ensureIndependentPlanSupport(second as never);
    expect(second.request).toHaveBeenCalledTimes(1);
  });
  it("旧 CLI 不认识能力查询时拒绝，不能只相信新 Host 的版本", async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    await expect(ensureIndependentPlanSupport(client as never)).rejects.toThrow(
      "proto.independentPlanUnsupported",
    );
  });
});

// specs/incognito-session.md "Protocol": the Host never forwards an incognito create to a CLI that
// would silently run it as a normal session.
describe("incognito execution-endpoint capability", () => {
  it("accepts a CLI that advertises incognitoSession and shares one capability read", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        independentPlanState: true,
        incognitoSession: true,
        incognitoProfileV2: true,
      }),
    };
    await ensureIncognitoSupport(client as never);
    await ensureIndependentPlanSupport(client as never);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("rejects a v1-era CLI that advertises incognitoSession but not the v2 profile flag", async () => {
    // incognitoProfileV2 is the version gate: such a CLI would read the v2 toggles as absent.
    const v1Era = {
      request: vi.fn().mockResolvedValue({ independentPlanState: true, incognitoSession: true }),
    };
    await expect(ensureIncognitoSupport(v1Era as never)).rejects.toThrow(
      INCOGNITO_UNSUPPORTED_ERROR,
    );
    const v2 = {
      request: vi.fn().mockResolvedValue({ incognitoSession: true, incognitoProfileV2: true }),
    };
    await expect(ensureIncognitoSupport(v2 as never)).resolves.toBeUndefined();
  });

  it("rejects a CLI without the capability or without the capability query", async () => {
    const older = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await expect(ensureIncognitoSupport(older as never)).rejects.toThrow(
      INCOGNITO_UNSUPPORTED_ERROR,
    );
    const oldest = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    await expect(ensureIncognitoSupport(oldest as never)).rejects.toThrow(
      INCOGNITO_UNSUPPORTED_ERROR,
    );
  });
});
