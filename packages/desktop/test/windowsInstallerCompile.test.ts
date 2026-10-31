import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopDir = resolve(import.meta.dirname, "..");
const builderDir = dirname(require.resolve("app-builder-lib/package.json"));

it("compiles real UAC calls when the plugin directory follows the custom include", async (context) => {
  // The NSIS-bundled mac compiler is x86_64; on Apple Silicon without Rosetta, skip only this unsupported compile test.
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      await execFileAsync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (stderr.includes("Bad CPU type in executable")) {
        context.skip("NSIS x86_64 compiler requires Rosetta on Apple Silicon");
        return;
      }
      throw error;
    }
  }
  // electron-builder 26.17.0 moved NSIS download and path resolution into the toolset resolver; the old
  // nsisUtil private exports were removed. The test must reuse the production build entry so a second
  // compiler/include/plugin path set cannot hide compatibility problems.
  const { getMakeNsisPath, getNsisPluginsPath } = require(
    resolve(builderDir, "out/toolsets/windows.js"),
  );
  const [makeNsis, pluginsDir] = await Promise.all([
    getMakeNsisPath(undefined),
    getNsisPluginsPath(undefined),
  ]);
  const nsisDir = makeNsis.env?.NSISDIR;
  if (!nsisDir) {
    throw new Error("electron-builder NSIS toolset 缺少 NSISDIR");
  }
  const compiler = makeNsis.path;
  const temp = await mkdtemp(join(tmpdir(), "zcode-nsis-compile-"));
  try {
    for (const uninstaller of [false, true]) {
      const output = join(temp, uninstaller ? "uninstaller.exe" : "installer.exe");
      // Compile only, do not run: the payload reuses this file, so every platform can verify real NSIS plugin resolution.
      const args = [
        "-V2",
        "-INPUTCHARSET",
        "UTF8",
        ...(uninstaller ? ["-WX", "-DBUILD_UNINSTALLER"] : []),
        `-DNSIS_INCLUDE_DIR=${join(nsisDir, "Include")}`,
        `-DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${join(builderDir, "templates/nsis/include")}`,
        `-DNSIS_PLUGIN_DIR=${join(pluginsDir, "x86-unicode")}`,
        `-DZCODE_INSTALLER_NSH=${join(desktopDir, "build/installer.nsh")}`,
        `-DFIXTURE_EXE=${import.meta.filename}`,
        `-DOUTPUT_FILE=${output}`,
        `-DDEFAULT_LOG_PATH=${join(temp, "default.log")}`,
        `-DELEVATED_LOG_PATH=${join(temp, "elevated.log")}`,
        join(desktopDir, "test/fixtures/installer-nsh-smoke.nsi"),
      ];
      // makensis Unicode builds abort with std::bad_alloc under the C locale; pin UTF-8 so the result
      // does not depend on the caller's LANG/LC_ALL (electron-builder pins it the same way in production).
      await execFileAsync(compiler, args, {
        env: { ...process.env, ...makeNsis.env, LC_ALL: "C.UTF-8" },
      });
      expect((await stat(output)).size).toBeGreaterThan(0);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
