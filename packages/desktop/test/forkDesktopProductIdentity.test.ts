import { describe, expect, it } from "vitest";

import {
  FORK_PREVIEW_RS_IDENTITY,
  isForkRsIdentityRequested,
  resolveForkDesktopProductIdentity,
  resolveForkProductVariantDefine,
  resolveForkWindowsAppUserModelId,
} from "../scripts/fork-desktop-product-identity.mjs";
import { desktopProductIdentities } from "../scripts/desktop-product-identity.mjs";

const PREVIEW_RELEASE_ENV = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" };

describe("fork desktop product identity (ZCode Preview RS)", () => {
  it("resolves the RS identity on a production-backend Preview build", () => {
    const identity = resolveForkDesktopProductIdentity({
      ...PREVIEW_RELEASE_ENV,
      ZCODE_FORK_RS_IDENTITY: "1",
    });
    expect(identity).toEqual({
      flavor: "preview",
      forkVariant: "rs",
      appId: "dev.zcode.app.preview.rs",
      productName: "ZCode Preview RS",
      linuxExecutableName: "zcode-preview-rs",
      linuxPackageName: "zcode-preview-rs",
      cuaHelperInstallVariant: "preview-rs",
      defaultAgentRuntime: "rust",
    });
    expect(identity.appId).not.toBe(desktopProductIdentities.preview.appId);
  });

  it("resolves the RS identity on a test-backend build (always Preview)", () => {
    expect(
      resolveForkDesktopProductIdentity({ ZCODE_ENV: "test", ZCODE_FORK_RS_IDENTITY: "1" }),
    ).toBe(FORK_PREVIEW_RS_IDENTITY);
  });

  it("returns the upstream identity with node as default without the flag", () => {
    for (const flag of [undefined, "", "0"]) {
      const identity = resolveForkDesktopProductIdentity({
        ...PREVIEW_RELEASE_ENV,
        ZCODE_FORK_RS_IDENTITY: flag,
      });
      expect(identity).toEqual({
        ...desktopProductIdentities.preview,
        forkVariant: null,
        defaultAgentRuntime: "node",
      });
    }
    expect(resolveForkDesktopProductIdentity({ ZCODE_ENV: "production" })).toMatchObject({
      ...desktopProductIdentities.production,
      forkVariant: null,
    });
  });

  it("refuses an RS build on the production identity", () => {
    expect(() =>
      resolveForkDesktopProductIdentity({ ZCODE_ENV: "production", ZCODE_FORK_RS_IDENTITY: "1" }),
    ).toThrow(/requires the Preview identity/);
  });

  it("accepts only 1, 0 or empty", () => {
    expect(isForkRsIdentityRequested({ ZCODE_FORK_RS_IDENTITY: " 1 " })).toBe(true);
    for (const value of ["true", "yes", "rs", "2"]) {
      expect(() => isForkRsIdentityRequested({ ZCODE_FORK_RS_IDENTITY: value })).toThrow(
        /expected 1 or 0/,
      );
    }
  });

  it("emits the compile-time variant define", () => {
    expect(
      resolveForkProductVariantDefine({ ...PREVIEW_RELEASE_ENV, ZCODE_FORK_RS_IDENTITY: "1" }),
    ).toBe("rs");
    expect(resolveForkProductVariantDefine(PREVIEW_RELEASE_ENV)).toBe("");
  });

  it("uses the RS app id as the packaged Windows AUMID and keeps the dev AUMID", () => {
    expect(resolveForkWindowsAppUserModelId("preview", "rs")).toBe("dev.zcode.app.preview.rs");
    expect(resolveForkWindowsAppUserModelId("preview", null)).toBe("dev.zcode.app.preview");
    expect(resolveForkWindowsAppUserModelId("production", null)).toBe("dev.zcode.app");
    expect(resolveForkWindowsAppUserModelId("preview", "rs", { isPackaged: false })).toBe(
      "cn.aminer.zcode",
    );
  });
});
