/* eslint-disable max-lines -- Editor detection needs to keep cross-platform paths, icon resolution, and caching together. */
/**
 * Editor detection and opening — detect installed editors/terminals, retrieve their icons, and open paths.
 *
 * Currently supports macOS / Windows. Linux support can be added later.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, win32 as pathWin32 } from "node:path";
import { app, nativeImage } from "electron";
import type { EditorInfo } from "@zcode/shared";
import { getZCodeDataRootDir } from "@zcode/services/node";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

export interface EditorDef {
  id: string;
  name: string;
  /** macOS .app bundle path. */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI command name, if available. Used to open a folder; null falls back to `open -a`. */
  command: string | null;
}

interface AppBundleInfoPlist {
  CFBundleIconFile?: string;
  CFBundleIconFiles?: string[];
  CFBundleIconName?: string;
  CFBundleIcons?: {
    CFBundlePrimaryIcon?: {
      CFBundleIconFiles?: string[];
      CFBundleIconName?: string;
    };
  };
}

interface ResolvedAppIconPath {
  candidateIconNames: string[];
  path: string | null;
  reason: "resolved" | "missing-plist" | "missing-icon-name" | "missing-icon-file";
}

interface ParsedIcnsPngCandidate {
  osType: string;
  size: number;
  image: Buffer;
}

const MAC_EDITOR_DEFS: EditorDef[] = [
  // Code editors.
  {
    id: "vscode",
    name: "VS Code",
    appPath: "/Applications/Visual Studio Code.app",
    command: "code",
  },
  // Previously, only stable VS Code was listed, and getInstalledEditors() used this static allowlist
  // for existsSync filtering. When a user installed `Visual Studio Code - Insiders.app`, main never
  // included it as a candidate, so the UI could not display it. This separate definition recognizes
  // Insiders and reuses the existing `code-insiders` CLI / `open -a` fallback path.
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    appPath: "/Applications/Visual Studio Code - Insiders.app",
    command: "code-insiders",
  },
  { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", command: "cursor" },
  { id: "trae", name: "Trae", appPath: "/Applications/Trae.app", command: null },
  { id: "zed", name: "Zed", appPath: "/Applications/Zed.app", command: "zed" },
  {
    id: "sublime",
    name: "Sublime Text",
    appPath: "/Applications/Sublime Text.app",
    command: "subl",
  },
  { id: "codebuddy", name: "CodeBuddy", appPath: "/Applications/CodeBuddy.app", command: null },
  { id: "qoder", name: "Qoder", appPath: "/Applications/Qoder.app", command: null },
  // JetBrains products.
  {
    id: "idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
    command: "idea",
  },
  {
    id: "idea-ce",
    name: "IntelliJ IDEA CE",
    appPath: "/Applications/IntelliJ IDEA CE.app",
    command: "idea",
  },
  { id: "webstorm", name: "WebStorm", appPath: "/Applications/WebStorm.app", command: "webstorm" },
  { id: "pycharm", name: "PyCharm", appPath: "/Applications/PyCharm.app", command: "pycharm" },
  { id: "goland", name: "GoLand", appPath: "/Applications/GoLand.app", command: "goland" },
  { id: "phpstorm", name: "PhpStorm", appPath: "/Applications/PhpStorm.app", command: "phpstorm" },
  { id: "rider", name: "Rider", appPath: "/Applications/Rider.app", command: "rider" },
  { id: "clion", name: "CLion", appPath: "/Applications/CLion.app", command: "clion" },
  { id: "rubymine", name: "RubyMine", appPath: "/Applications/RubyMine.app", command: "rubymine" },
  { id: "datagrip", name: "DataGrip", appPath: "/Applications/DataGrip.app", command: "datagrip" },
  // Terminals (the current macOS Terminal app is under /System/Applications).
  {
    id: "terminal",
    name: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    command: null,
  },
  { id: "iterm2", name: "iTerm", appPath: "/Applications/iTerm.app", command: null },
  { id: "ghostty", name: "Ghostty", appPath: "/Applications/Ghostty.app", command: null },
  { id: "warp", name: "Warp", appPath: "/Applications/Warp.app", command: null },
  // File managers.
  {
    id: "finder",
    name: "Finder",
    appPath: "/System/Library/CoreServices/Finder.app",
    command: null,
  },
  // Extension: QSpace / QSpace Pro are third-party macOS file managers without a CLI by default;
  // reuse `open -a` with the app bundle to open paths.
  {
    id: "qspace",
    name: "QSpace",
    appPath: "/Applications/QSpace.app",
    command: null,
  },
  {
    id: "qspace-pro",
    name: "QSpace Pro",
    appPath: "/Applications/QSpace Pro.app",
    command: null,
  },
];

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ),
  );
}

function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(
    process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`,
    "Programs",
  );
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

function findWindowsJetBrainsExecutableCandidates(
  productDirPrefix: string,
  executableName: string,
): string[] {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  const candidates: string[] = [];

  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.toLowerCase().startsWith(productDirPrefix.toLowerCase()),
        )
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));

      for (const entry of entries) {
        candidates.push(pathWin32.join(root, entry, "bin", executableName));
      }
    } catch {
      // JetBrains products are optional; missing roots are expected.
    }
  }

  return candidates;
}

function createWindowsEditorDef(
  id: string,
  name: string,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

function resolveWindowsCommandPaths(command: string): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

function deriveWindowsAppPathsFromCommand(command: string, appNames: string[]): string[] {
  const candidates: string[] = [];

  for (const commandPath of resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) {
        candidates.push(pathWin32.join(appRoot, appName));
      }
    }
  }

  // Windows PATH commonly contains shims such as bin\code.cmd; only the real exe provides an application icon like macOS.
  return uniquePaths(candidates).filter((candidate) => existsSync(candidate));
}

const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  // The Workspace "Open in Editor" menu previously exposed only IDEs to the UI, leaving Windows
  // users without a basic "Open in Explorer" entry and forcing them to use another menu.
  // Include the system file manager in the editor list to align the macOS Finder and Windows Explorer experiences.
  { id: "explorer", name: "资源管理器", appPath: WINDOWS_EXPLORER_PATH, command: null },
];

const WINDOWS_ADDITIONAL_EDITOR_DEFS: EditorDef[] = [
  createWindowsEditorDef(
    "vscode",
    "VS Code",
    [
      windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe"),
    ],
    "code",
    ["Code.exe"],
  ),
  createWindowsEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    [
      windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    ],
    "code-insiders",
    ["Code - Insiders.exe"],
  ),
  createWindowsEditorDef(
    "cursor",
    "Cursor",
    [
      windowsLocalProgramCandidate("Cursor", "Cursor.exe"),
      ...windowsProgramFilesCandidates("Cursor", "Cursor.exe"),
    ],
    "cursor",
    ["Cursor.exe"],
  ),
  createWindowsEditorDef("trae", "Trae", [
    windowsLocalProgramCandidate("Trae", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
    ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
  ]),
  createWindowsEditorDef("idea", "IntelliJ IDEA", [
    ...findWindowsJetBrainsExecutableCandidates("IntelliJ IDEA", "idea64.exe"),
  ]),
  createWindowsEditorDef("webstorm", "WebStorm", [
    ...findWindowsJetBrainsExecutableCandidates("WebStorm", "webstorm64.exe"),
  ]),
  createWindowsEditorDef("pycharm", "PyCharm", [
    ...findWindowsJetBrainsExecutableCandidates("PyCharm", "pycharm64.exe"),
  ]),
  createWindowsEditorDef("goland", "GoLand", [
    ...findWindowsJetBrainsExecutableCandidates("GoLand", "goland64.exe"),
  ]),
  createWindowsEditorDef("clion", "CLion", [
    ...findWindowsJetBrainsExecutableCandidates("CLion", "clion64.exe"),
  ]),
];

export function getEditorDefsForCurrentPlatform(): EditorDef[] {
  if (process.platform === "darwin") {
    return MAC_EDITOR_DEFS;
  }

  if (process.platform === "win32") {
    return [...WINDOWS_EDITOR_DEFS, ...WINDOWS_ADDITIONAL_EDITOR_DEFS];
  }

  return [];
}

/** Cache detection results to avoid repeated I/O. */
export function resolveEditorDefAppPath(def: EditorDef): string | null {
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? resolveWindowsCommandPaths(def.command)
        : [];
  const candidatePaths = uniquePaths([
    def.appPath,
    ...(def.appPathCandidates ?? []),
    ...commandAppPaths,
    ...commandPaths,
  ]);
  return candidatePaths.find((candidate) => existsSync(candidate)) ?? null;
}

let cachedEditors: EditorInfo[] | null = null;
let cachedIcnsModule: typeof import("@fiahfy/icns") | null | undefined;

function getIcnsModule(): typeof import("@fiahfy/icns") | null {
  if (cachedIcnsModule !== undefined) {
    return cachedIcnsModule;
  }

  try {
    cachedIcnsModule = require("@fiahfy/icns") as typeof import("@fiahfy/icns");
  } catch (error) {
    // Previously, this required @fiahfy/icns directly at module load. If the package omitted one of
    // its dependencies (pngjs in this case), main crashed while loading the file before reaching the
    // sips/file-icon fallback. Lazy loading means a missing dependency only downgrades icon parsing.
    cachedIcnsModule = null;
    logger.warn("[editors] 加载 @fiahfy/icns 失败，图标解析将回退到 sips", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return cachedIcnsModule;
}

function readAppBundleInfoPlist(appPath: string): AppBundleInfoPlist | null {
  try {
    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlistPath], {
      encoding: "utf8",
      timeout: 3000,
    });
    return JSON.parse(raw) as AppBundleInfoPlist;
  } catch (error) {
    logger.warn("[editors] 读取 Info.plist 失败，图标将回退到 file icon", {
      appPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveAppIconPath(appPath: string): ResolvedAppIconPath {
  const plist = readAppBundleInfoPlist(appPath);
  if (!plist) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-plist",
    };
  }

  // `defaults read` cannot read CFBundleIconFile from many third-party .app bundles, causing all
  // editors to fall back incorrectly to Electron's generic file icon. Parse Info.plist directly instead.
  const iconNames = [
    plist.CFBundleIconFile,
    ...(plist.CFBundleIconFiles ?? []),
    ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
    plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    plist.CFBundleIconName,
  ].filter(
    (iconName): iconName is string => typeof iconName === "string" && iconName.trim().length > 0,
  );

  if (iconNames.length === 0) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-icon-name",
    };
  }

  for (const iconName of iconNames) {
    const candidateFileNames = iconName.endsWith(".icns")
      ? [iconName]
      : [iconName, `${iconName}.icns`];

    for (const candidateFileName of candidateFileNames) {
      const candidatePath = join(appPath, "Contents", "Resources", candidateFileName);
      // Applications such as Ghostty may have both a same-named resource directory and an actual
      // .icns file. Checking only existsSync could select the directory and try to read it as an icon,
      // then fall back to the washed-out system file icon. Require each candidate path to be a file.
      if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
        return {
          candidateIconNames: iconNames,
          path: candidatePath,
          reason: "resolved",
        };
      }
    }
  }

  return {
    candidateIconNames: iconNames,
    path: null,
    reason: "missing-icon-file",
  };
}

function loadNativeImageFromIcnsViaPackage(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const icnsModule = getIcnsModule();
  if (!icnsModule) {
    return null;
  }

  const { Icns } = icnsModule;

  try {
    const icnsBuffer = readFileSync(icnsPath);
    const icns = Icns.from(icnsBuffer);
    const pngCandidates = icns.images
      .map((image): ParsedIcnsPngCandidate | null => {
        const supportedIconType = Icns.supportedIconTypes.find(
          (iconType) => iconType.osType === image.osType,
        );
        if (!supportedIconType || supportedIconType.format !== "PNG") {
          return null;
        }
        return {
          osType: image.osType,
          size: supportedIconType.size,
          image: image.image,
        };
      })
      .filter((candidate): candidate is ParsedIcnsPngCandidate => candidate !== null)
      .sort((left, right) => right.size - left.size);

    if (pngCandidates.length === 0) {
      logger.info("[editors] @fiahfy/icns 未解析到 PNG icon，图标将回退到 sips", {
        editorId,
        appPath,
        icnsPath,
        availableIconTypes: icns.images.map((image) => image.osType),
      });
      return null;
    }

    for (const candidate of pngCandidates) {
      const icon = nativeImage.createFromBuffer(candidate.image);
      if (!icon.isEmpty()) {
        return icon;
      }
    }

    logger.warn("[editors] @fiahfy/icns 已解析到 PNG icon，但 nativeImage 仍为空", {
      editorId,
      appPath,
      icnsPath,
      pngCandidateTypes: pngCandidates.map((candidate) => `${candidate.osType}:${candidate.size}`),
    });
    return null;
  } catch (error) {
    logger.warn("[editors] @fiahfy/icns 解析失败，图标将回退到 sips", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function loadNativeImageFromIcnsViaSips(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const tempRootDir = join(getZCodeDataRootDir(), "editor-icon");
  mkdirSync(tempRootDir, { recursive: true });
  const tempDirPath = mkdtempSync(join(tempRootDir, "icon-"));
  const tempPngPath = join(tempDirPath, "icon.png");

  try {
    execFileSync("sips", ["-s", "format", "png", icnsPath, "--out", tempPngPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pngBuffer = readFileSync(tempPngPath);
    const icon = nativeImage.createFromBuffer(pngBuffer);
    if (icon.isEmpty()) {
      logger.warn("[editors] sips 已输出 PNG，但 nativeImage 仍为空", {
        editorId,
        appPath,
        icnsPath,
        tempPngPath,
      });
      return null;
    }
    return icon;
  } catch (error) {
    logger.warn("[editors] .icns 转 PNG 失败，图标将回退到 file icon", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    try {
      rmSync(tempDirPath, { recursive: true, force: true });
    } catch {
      // Failure to clean up the temporary directory does not affect icon loading.
    }
  }
}

function loadNativeImageFromIcns(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  // Electron's nativeImage is not suitable for reading .icns directly. Prefer parsing a PNG icon
  // with the npm package to avoid starting a system subprocess for every icon; fall back to macOS
  // sips only for legacy formats or when the package cannot parse the icon.
  return (
    loadNativeImageFromIcnsViaPackage(editorId, appPath, icnsPath) ??
    loadNativeImageFromIcnsViaSips(editorId, appPath, icnsPath)
  );
}

/**
 * Read possible icon fields from an .app bundle's Info.plist, convert .icns to PNG, and create a
 * real icon for menus. If no real icon can be parsed, fall back to Electron's app.getFileIcon.
 */
export function getAppIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return app
      .getFileIcon(appPath, { size: "normal" })
      .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
      .catch((error) => {
        logger.warn("[editors] 获取 file icon 失败", {
          editorId,
          appPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
  }
  // Step 1: try loading the real app icon from the .icns file.
  const resolvedIcon = resolveAppIconPath(appPath);
  if (resolvedIcon.path) {
    const icon = loadNativeImageFromIcns(editorId, appPath, resolvedIcon.path);
    if (icon && !icon.isEmpty()) {
      // Scale to a suitable size (32x32 for menu display).
      const resized = icon.resize({ width: 32, height: 32 });
      return Promise.resolve(`data:image/png;base64,${resized.toPNG().toString("base64")}`);
    }
  } else {
    logger.info("[editors] 未解析到真实 app 图标，图标将回退到 file icon", {
      editorId,
      appPath,
      reason: resolvedIcon.reason,
      candidateIconNames: resolvedIcon.candidateIconNames,
    });
  }

  // Step 2: fall back to Electron's app.getFileIcon.
  return app
    .getFileIcon(appPath, { size: "normal" })
    .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
    .catch((error) => {
      logger.warn("[editors] 获取 file icon 失败", {
        editorId,
        appPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
}

/**
 * Detect installed editors/terminals and return a list with icons.
 * Cache the result for the lifetime of the application.
 */
export async function getInstalledEditors(): Promise<EditorInfo[]> {
  if (cachedEditors) {
    return cachedEditors;
  }

  const installed = getEditorDefsForCurrentPlatform()
    .map((def) => {
      const appPath = resolveEditorDefAppPath(def);
      return appPath ? { def, appPath } : null;
    })
    .filter((entry): entry is { def: EditorDef; appPath: string } => entry !== null);

  const results = await Promise.all(
    installed.map(async ({ def, appPath }) => {
      const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
      if (!iconDataUrl) {
        return null;
      }
      return { id: def.id, name: def.name, iconDataUrl };
    }),
  );

  cachedEditors = results.filter((r): r is EditorInfo => r !== null);
  return cachedEditors;
}
