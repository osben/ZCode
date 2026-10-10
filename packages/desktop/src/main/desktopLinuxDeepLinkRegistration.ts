import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installLinuxAppImageDesktopIconBestEffort } from "./desktopLinuxAppImageIcon.js";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

const LINUX_DEEP_LINK_DESKTOP_FILE = "zcode.desktop";
const LINUX_DEEP_LINK_MIME_TYPE = "x-scheme-handler/zcode";
// Ownership marker: identifies whether the user-level zcode.desktop was written by this app (all historical versions include this Comment line).
const LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER = "Comment=ZCode Desktop App";

type LinuxDesktopEnv = {
  APPIMAGE?: string;
  XDG_DATA_HOME?: string;
  XDG_DATA_DIRS?: string;
};

interface RegisterLinuxDeepLinkProtocolOptions {
  executablePath: string;
  homeDir: string;
  productName?: string;
  iconSourcePath?: string;
  env?: LinuxDesktopEnv;
  argv?: string[];
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
  systemApplicationDirs?: string[];
}

interface LinuxDeepLinkCommand {
  executablePath: string;
  args: string[];
}

const APPIMAGE_DEEP_LINK_ARG_NAMES = new Set([
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
]);

const APPIMAGE_DEEP_LINK_ARG_PREFIXES = [
  "--use-gl=",
  "--use-angle=",
  "--disable-features=",
  "--enable-features=",
];

function resolveLinuxDeepLinkCommand(params: {
  env?: { APPIMAGE?: string };
  executablePath: string;
  argv?: string[];
}): LinuxDeepLinkCommand {
  const appImagePath = params.env?.APPIMAGE?.trim();
  if (!appImagePath) {
    return { executablePath: params.executablePath, args: [] };
  }

  return {
    executablePath: appImagePath,
    // xdg-open relaunches an AppImage through the .desktop Exec command for zcode:// callbacks.
    // Sandbox/GPU arguments added to a manual launch are not inherited, so the relaunch may crash
    // before Electron initializes. Persist only allowlisted arguments that affect startup success;
    // do not hard-code deep-link URLs, debug ports, or workspace paths.
    args: resolveAppImageDeepLinkArgs(params.argv ?? []),
  };
}

function quoteDesktopExecPath(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (match) => `\\${match}`)}"`;
}

function isAllowedAppImageDeepLinkArg(arg: string): boolean {
  return (
    APPIMAGE_DEEP_LINK_ARG_NAMES.has(arg) ||
    APPIMAGE_DEEP_LINK_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

function resolveAppImageDeepLinkArgs(argv: string[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!isAllowedAppImageDeepLinkArg(arg) || seen.has(arg)) {
      continue;
    }
    seen.add(arg);
    args.push(arg);
  }
  return args;
}

function quoteDesktopExecToken(value: string): string {
  return quoteDesktopExecPath(value);
}

function formatDesktopExec(command: LinuxDeepLinkCommand): string {
  return [command.executablePath, ...command.args]
    .map(quoteDesktopExecToken)
    .concat("%U")
    .join(" ");
}

function createLinuxDeepLinkDesktopEntry(params: {
  executablePath: string;
  args?: string[];
  productName?: string;
  iconName?: string;
}): string {
  const productName = params.productName ?? "ZCode";
  const iconName = params.iconName ?? "zcode";
  const command = {
    executablePath: params.executablePath,
    args: params.args ?? [],
  };
  return [
    "[Desktop Entry]",
    `Name=${productName}`,
    LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER,
    `Exec=${formatDesktopExec(command)}`,
    "Terminal=false",
    "Type=Application",
    `Icon=${iconName}`,
    "Categories=Development;",
    `MimeType=${LINUX_DEEP_LINK_MIME_TYPE};`,
    `StartupWMClass=${productName}`,
    "",
  ].join("\n");
}

function resolveLinuxUserDataDir(params: {
  env?: { XDG_DATA_HOME?: string };
  homeDir: string;
}): string {
  const xdgDataHome = params.env?.XDG_DATA_HOME?.trim();
  return xdgDataHome || join(params.homeDir, ".local", "share");
}

function resolveLinuxSystemApplicationDirs(env?: { XDG_DATA_DIRS?: string }): string[] {
  const raw = env?.XDG_DATA_DIRS?.trim();
  const entries = raw
    ? raw
        .split(":")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  // The XDG default is /usr/local/share:/usr/share; an entirely empty XDG_DATA_DIRS also falls back to this default.
  const dataDirs = entries.length > 0 ? entries : ["/usr/local/share", "/usr/share"];
  return dataDirs.map((dir) => join(dir, "applications"));
}

function findSystemLevelDesktopEntryPath(systemApplicationDirs: string[]): string | undefined {
  for (const dir of systemApplicationDirs) {
    const candidate = join(dir, LINUX_DEEP_LINK_DESKTOP_FILE);
    // Boundary: a directory or malformed path must not count as a valid system-level entry, or a
    // broken path could suppress user-level registration for AppImage-only users. Only regular files participate in shadowing checks.
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // The path is missing or cannot be stat'ed (permissions); skip this candidate directory.
    }
  }
  return undefined;
}

function isOwnedDesktopEntry(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    // Remove \r and surrounding whitespace to support CRLF endings and extra spaces introduced by
    // manual editors, avoiding legacy entries being mistaken for user-customized entries and left behind.
    return content
      .split("\n")
      .some((line) => line.replaceAll("\r", "").trim() === LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER);
  } catch {
    return false;
  }
}

function removeOwnedUserDesktopEntry(
  desktopFilePath: string,
  logger: LinuxDeepLinkRegistrationLogger,
): void {
  if (!existsSync(desktopFilePath)) {
    return;
  }
  if (!isOwnedDesktopEntry(desktopFilePath)) {
    logger.warn("[deep-link] Linux 用户级 zcode.desktop 非本应用写入，保留不清理", {
      desktopFilePath,
    });
    return;
  }
  try {
    rmSync(desktopFilePath);
    logger.info("[deep-link] 已清理遗留的用户级 zcode.desktop，恢复系统级条目", {
      desktopFilePath,
    });
  } catch (error) {
    logger.warn("[deep-link] 清理遗留用户级 zcode.desktop 失败", { desktopFilePath, error });
  }
}

function resolveLinuxDeepLinkDesktopFilePath(dataDir: string): string {
  return join(dataDir, "applications", LINUX_DEEP_LINK_DESKTOP_FILE);
}

function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

export function registerLinuxDeepLinkProtocol(options: RegisterLinuxDeepLinkProtocolOptions): void {
  const command = resolveLinuxDeepLinkCommand({
    env: options.env,
    executablePath: options.executablePath,
    argv: options.argv,
  });
  const dataDir = resolveLinuxUserDataDir({ env: options.env, homeDir: options.homeDir });
  const desktopFilePath = resolveLinuxDeepLinkDesktopFilePath(dataDir);
  const applicationsDir = dirname(desktopFilePath);
  const desktopEntry = createLinuxDeepLinkDesktopEntry({
    ...command,
    productName: options.productName,
  });
  let protocolRegistered = false;
  const runCommand = options.runCommand ?? runXdgCommand;

  // XDG resolution always prefers a user-level zcode.desktop over a system-level entry with the
  // same name. After rpm/deb installation, an old user-level entry written by AppImage would keep
  // shadowing /usr/share/applications/zcode.desktop, so shortcuts and zcode:// links would continue
  // pointing to the old AppImage (if present) or stop working (if deleted) until a newer version was
  // manually launched. Now, when a system-level entry with the same ID exists:
  // - For a system installation (rpm/deb), remove this app's legacy user-level entry and stop writing one.
  // - For AppImage, stop writing user-level entries and icons so an old AppImage cannot shadow the system install again.
  // Preserve user-written custom zcode.desktop files without an ownership marker.
  const systemDesktopEntryPath = findSystemLevelDesktopEntryPath(
    options.systemApplicationDirs ?? resolveLinuxSystemApplicationDirs(options.env),
  );

  try {
    let changed = false;
    if (systemDesktopEntryPath) {
      options.logger.info("[deep-link] Linux 系统级 desktop entry 已存在", {
        systemDesktopEntryPath,
        desktopFilePath,
      });
      removeOwnedUserDesktopEntry(desktopFilePath, options.logger);
    } else {
      changed = writeFileIfChanged(desktopFilePath, desktopEntry);
    }
    // A directly run AppImage cannot reliably write a system desktop entry like a deb package.
    // Deep links are core to OAuth/payment/workspace opening, so refresh the user-level protocol
    // handler first. Icon installation is optional; handle it separately after registration succeeds
    // so a failure does not expand the login-callback failure surface.
    const updateResult = runCommand("update-desktop-database", [applicationsDir]);
    const defaultResult = runCommand("xdg-mime", [
      "default",
      LINUX_DEEP_LINK_DESKTOP_FILE,
      LINUX_DEEP_LINK_MIME_TYPE,
    ]);

    if (defaultResult.status === 0) {
      protocolRegistered = true;
      options.logger.info("[deep-link] Linux 用户级协议注册成功", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        changed,
        systemDesktopEntryPath,
      });
    } else {
      options.logger.warn("[deep-link] Linux 用户级协议注册失败", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        status: defaultResult.status,
        signal: defaultResult.signal,
        timeoutMs: defaultResult.signal === "SIGTERM" ? XDG_COMMAND_TIMEOUT_MS : undefined,
        error: defaultResult.error?.message,
        stderr: defaultResult.stderr?.trim(),
      });
    }

    if (updateResult.error) {
      options.logger.warn("[deep-link] update-desktop-database 不可用，已跳过", {
        desktopFilePath,
        message: updateResult.error.message,
      });
    } else if (updateResult.signal === "SIGTERM") {
      options.logger.warn("[deep-link] update-desktop-database 超时，已跳过", {
        desktopFilePath,
        timeoutMs: XDG_COMMAND_TIMEOUT_MS,
      });
    } else if (updateResult.status !== 0) {
      options.logger.warn("[deep-link] update-desktop-database 失败，已跳过", {
        desktopFilePath,
        status: updateResult.status,
        signal: updateResult.signal,
        stderr: updateResult.stderr?.trim(),
      });
    }
  } catch (error) {
    options.logger.warn("[deep-link] Linux 用户级协议注册异常", {
      desktopFilePath,
      executablePath: command.executablePath,
      args: command.args,
      error,
    });
  }

  const iconInstallResult = systemDesktopEntryPath
    ? null
    : installLinuxAppImageDesktopIconBestEffort({
        dataDir,
        env: options.env,
        iconSourcePath: options.iconSourcePath,
        logger: options.logger,
        runCommand,
      });
  if (iconInstallResult) {
    options.logger.info("[deep-link] Linux AppImage 用户级图标安装完成", {
      protocolRegistered,
      iconFilePath: iconInstallResult.iconFilePath,
      iconInstalled: iconInstallResult.installed,
      iconChanged: iconInstallResult.changed,
    });
  }
}
