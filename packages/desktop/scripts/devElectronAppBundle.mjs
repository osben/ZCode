import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const DEV_ELECTRON_PROTOCOL_SCHEME = "zcode";
export const DEV_ELECTRON_APP_NAME = "ZCode Dev";
export const DEV_ELECTRON_APP_BUNDLE_ID = "dev.zcode.app.development";
// Copy layout version; see the fingerprint notes in prepareDevElectronAppBundle.
export const DEV_ELECTRON_BUNDLE_FORMAT = 3;
const execFileAsync = promisify(execFile);

async function signDevElectronApp(appPath) {
  // Since Electron 42, notifications require a valid signature; the original npm runtime
  // signature may be incomplete, so it must be re-signed after any identity change too.
  // Ad-hoc signing applies only to the ignored dev copy; official releases still go through
  // the existing certificate and notarization flow.
  await execFileAsync("/usr/bin/codesign", [
    "--deep",
    "--force",
    "--sign",
    "-",
    "--preserve-metadata=entitlements,flags,runtime",
    appPath,
  ]);
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "u");
  if (!pattern.test(plist)) {
    throw new Error(`Dev Electron Info.plist is missing ${key}`);
  }
  return plist.replace(
    pattern,
    (_match, prefix, suffix) => `${prefix}${escapeXml(value)}${suffix}`,
  );
}

function appendProtocolDeclaration(plist) {
  if (plist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`)) {
    return plist;
  }

  const closingDictIndex = plist.lastIndexOf("</dict>");
  if (closingDictIndex < 0) {
    throw new Error("Dev Electron Info.plist is missing its root dict");
  }

  const protocolDeclaration = `\n\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>${DEV_ELECTRON_APP_NAME}</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`;
  return `${plist.slice(0, closingDictIndex)}${protocolDeclaration}${plist.slice(closingDictIndex)}`;
}

/**
 * Add the product identity and zcode URL scheme to the local macOS Dev runtime.
 * Raw Electron's Info.plist has no CFBundleURLTypes, so the system routes zcode to com.github.Electron.
 * Modify only the launch copy to avoid changing the Electron installation in node_modules.
 */
export function patchDevElectronInfoPlist(plist) {
  let patched = replacePlistString(plist, "CFBundleDisplayName", DEV_ELECTRON_APP_NAME);
  patched = replacePlistString(patched, "CFBundleIdentifier", DEV_ELECTRON_APP_BUNDLE_ID);
  patched = replacePlistString(patched, "CFBundleName", DEV_ELECTRON_APP_NAME);
  return appendProtocolDeclaration(patched);
}

export function resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch }) {
  return posix.join(runtimeRoot, `${electronVersion}-${arch}`, `${DEV_ELECTRON_APP_NAME}.app`);
}

export async function prepareDevElectronAppBundle({
  electronAppPath,
  runtimeRoot,
  electronVersion,
  arch,
  signApp = signDevElectronApp,
}) {
  const appPath = resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch });
  const infoPlistPath = posix.join(appPath, "Contents", "Info.plist");
  const sourceExecutablePath = posix.join(electronAppPath, "Contents", "MacOS", "Electron");
  const existingExecutablePath = posix.join(appPath, "Contents", "MacOS", "Electron");
  // Store the source binary fingerprint outside the .app; placing it in Contents would alter the bundle structure.
  const sourceStampPath = posix.join(dirname(appPath), ".zcode-dev-electron-source.json");
  // Fix reason: this previously read both Electron executables (over 100 MB each) into memory for
  // an equals check, causing a full disk read on every dev startup. The source binary is extracted
  // from an npm package, so recording its size+mtime is enough to determine whether it needs to be
  // copied again — equivalent semantics at constant-time cost.
  //
  // Do not compare source and copy mtimes directly: cp rounds mtime to milliseconds even with
  // preserveTimestamps, so the source's sub-millisecond precision is lost and the values never match.
  // That would make the cache ineffective.
  //
  // The format field records the copy layout version. Increment it when fixing the layout (for example,
  // changing symlink handling) so existing copies are recopied even when the source binary is unchanged.
  const sourceStats = await stat(sourceExecutablePath).catch(() => undefined);
  const sourceStamp = sourceStats
    ? JSON.stringify({
        format: DEV_ELECTRON_BUNDLE_FORMAT,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      })
    : undefined;
  let needsCopy = true;
  try {
    const existingInfoPlist = await readFile(infoPlistPath, "utf8");
    await access(existingExecutablePath);
    const existingStamp = await readFile(sourceStampPath, "utf8");
    needsCopy =
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_APP_BUNDLE_ID}</string>`) ||
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`) ||
      sourceStamp === undefined ||
      existingStamp !== sourceStamp;
  } catch {
    // If the directory is missing or was not generated by this tool, perform a full copy below.
  }

  if (needsCopy) {
    // Delete only the ignored runtime directory generated by this tool; never touch node_modules or user data.
    await rm(appPath, { recursive: true, force: true });
    await rm(sourceStampPath, { force: true });
    await mkdir(dirname(appPath), { recursive: true });
    // Keep verbatimSymlinks enabled: Electron Framework.framework uses relative symlinks such as
    // Resources -> Versions/Current/Resources and Current -> A. By default, fs.cp rewrites relative
    // links to absolute paths into node_modules. The main process can still read them, but macOS sandboxed
    // child processes such as GPU/network can only read within this bundle, so following those links is
    // blocked. This appears as "icudtl.dat not found in bundle" followed by
    // "GPU process isn't usable. Goodbye.".
    await cp(electronAppPath, appPath, { recursive: true, verbatimSymlinks: true });
    const patchedInfoPlist = patchDevElectronInfoPlist(await readFile(infoPlistPath, "utf8"));
    await writeFile(infoPlistPath, patchedInfoPlist, "utf8");
    await signApp(appPath);
    // Write the fingerprint last so a failure midway still triggers a recopy next time instead of leaving
    // a partial cache marked as complete.
    if (sourceStamp !== undefined) await writeFile(sourceStampPath, sourceStamp, "utf8");
  }

  return {
    appPath,
    executablePath: posix.join(appPath, "Contents", "MacOS", "Electron"),
  };
}
