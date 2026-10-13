import { describe, expect, it } from "vitest";
import desktopBuilderConfig from "../electron-builder.config.js";
import { resolveDesktopProductIdentity } from "../scripts/desktop-product-identity.mjs";

// Linux packaging target contract: rpm is the install distribution format besides deb and must not change the existing update chain.
// latest.yml / electron-updater are fixed to AppImage as the update artifact on Linux,
// and scripts/upload-oss.sh also parses update metadata by AppImage, so AppImage must be kept.
describe("electron-builder Linux 打包目标", () => {
  it("prerelease 也生成统一的 latest.yml", () => {
    expect(desktopBuilderConfig.detectUpdateChannel).toBe(false);
  });

  it("Linux 同时产出 AppImage、deb、rpm 与 pacman 安装包", () => {
    const targets = desktopBuilderConfig.linux?.target ?? [];

    expect(targets).toContain("AppImage");
    expect(targets).toContain("deb");
    expect(targets).toContain("rpm");
    expect(targets).toContain("pacman");
  });

  it("rpm 与 deb 的 packageName 按 flavor 拆分且保持一致", () => {
    // Production and Preview must be two separate system packages: if rpm reuses the default package name,
    // dnf treats an install of the other flavor as an upgrade replacement; this aligns with the deb packageName constraint.
    const identity = resolveDesktopProductIdentity();

    expect(desktopBuilderConfig.rpm?.packageName).toBe(identity.linuxPackageName);
    expect(desktopBuilderConfig.deb?.packageName).toBe(identity.linuxPackageName);
    expect(desktopBuilderConfig.pacman?.packageName).toBe(identity.linuxPackageName);
  });

  it("rpm 通过 fpm 追加 Electron 实际需要的运行库 Requires", () => {
    // electron-builder's default rpm Requires omits mesa-libgbm / alsa-lib (the real DT_NEEDED dependencies of
    // the Electron ELF), so a minimal RHEL install fails to start; they must be appended via fpm -d instead of
    // replacing the default Requires wholesale with depends.
    expect(desktopBuilderConfig.rpm?.fpm).toContain("mesa-libgbm");
    expect(desktopBuilderConfig.rpm?.fpm).toContain("alsa-lib");
    expect(desktopBuilderConfig.rpm?.fpm).toContain("-d");
  });

  it("pacman 使用 Arch 原生 .pkg.tar.zst 扩展名", () => {
    expect(desktopBuilderConfig.pacman?.artifactName).toContain(".pkg.tar.zst");
  });

  it("pacman 显式声明 Electron 启动所需的 Arch 运行库", () => {
    const dependencies = desktopBuilderConfig.pacman?.depends ?? [];

    // Explicit dependencies must use package names from the official Arch repositories; electron-builder's
    // long-stale default set pulls in removed packages such as libappindicator-gtk3/http-parser and makes pacman -U fail.
    expect(dependencies).toEqual([
      "gtk3",
      "nss",
      "libxss",
      "libxtst",
      "libnotify",
      "alsa-lib",
      "mesa",
      "xdg-utils",
    ]);
  });

  it("pacman 不显式覆盖 electron-builder 的默认压缩格式", () => {
    // electron-builder 26.8.1's pacman default artifact is already zstd; explicitly writing zstd is rejected by its
    // config schema, so we only assert the extension name and do not override the default compression in the config.
    expect(desktopBuilderConfig.pacman?.compression).toBeUndefined();
  });
});
