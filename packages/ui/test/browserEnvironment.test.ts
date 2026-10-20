import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSafeLocalStorage,
  getSafeReadableLocalStorage,
  removeSafeLocalStorage,
  readSafeLocalStorage,
  writeSafeLocalStorage,
} from "@/lib/browserEnvironment.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserEnvironment localStorage helpers", () => {
  it("无 window 和 localStorage 时安全返回空值", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", undefined);

    expect(getSafeReadableLocalStorage()).toBeNull();
    expect(getSafeLocalStorage()).toBeNull();
    expect(readSafeLocalStorage("zcode-locale")).toBeNull();
    expect(() => writeSafeLocalStorage("zcode-locale", "zh-CN")).not.toThrow();
    expect(() => removeSafeLocalStorage("zcode-locale")).not.toThrow();
  });

  it("localStorage getter 抛错时读写都不抛出", () => {
    const windowStub = {};
    Object.defineProperty(windowStub, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    vi.stubGlobal("window", windowStub);

    expect(getSafeReadableLocalStorage()).toBeNull();
    expect(getSafeLocalStorage()).toBeNull();
    expect(readSafeLocalStorage("zcode-locale")).toBeNull();
    expect(() => writeSafeLocalStorage("zcode-locale", "zh-CN")).not.toThrow();
    expect(() => removeSafeLocalStorage("zcode-locale")).not.toThrow();
  });

  it("只读 storage 只开放读取能力，不作为可写 storage 返回", () => {
    const storage = {
      getItem: vi.fn(() => "en-US"),
    };
    vi.stubGlobal("window", { localStorage: storage });

    expect(getSafeReadableLocalStorage()).toBe(storage);
    expect(getSafeLocalStorage()).toBeNull();
    expect(readSafeLocalStorage("zcode-locale")).toBe("en-US");
    expect(() => writeSafeLocalStorage("zcode-locale", "zh-CN")).not.toThrow();
    expect(() => removeSafeLocalStorage("zcode-locale")).not.toThrow();
  });

  it("removes keys from writable localStorage", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage: storage });

    removeSafeLocalStorage("zcode-font-family");

    expect(storage.removeItem).toHaveBeenCalledWith("zcode-font-family");
  });
});
