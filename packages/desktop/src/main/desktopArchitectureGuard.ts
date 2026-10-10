import type { BrowserWindow, NativeImage } from "electron";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, buildZCodeEndpointUrls, type Locale } from "@zcode/shared";

interface ArchitectureMismatch {
  /** Architecture of the currently running binary, such as x64. */
  binaryArch: string;
  /** Recommended native architecture; translated execution currently falls back only to arm64. */
  nativeArch: string;
}

interface DetectArchitectureMismatchOptions {
  platform?: NodeJS.Platform;
  binaryArch?: string;
  /**
   * Electron's app.runningUnderARM64Translation:
   * true when an x64/x86 package is translated to run on ARM64 hardware
   * (Rosetta on macOS or Windows on ARM). This is the typical wrong-architecture installation scenario.
   */
  runningUnderARM64Translation?: boolean;
}

/**
 * Determine whether the current process is running under the wrong architecture.
 *
 * Use runningUnderARM64Translation instead of comparing process.arch with os.arch():
 * when Node runs an x64 package on Apple Silicon, os.arch() also returns "x64" (translated by
 * Rosetta), so comparing the two cannot reveal the mismatch. The translation flag is the only reliable signal.
 */
function detectArchitectureMismatch(
  options: DetectArchitectureMismatchOptions = {},
): ArchitectureMismatch | null {
  const platform = options.platform ?? process.platform;
  const binaryArch = options.binaryArch ?? process.arch;
  const translated = options.runningUnderARM64Translation ?? false;

  if (!translated) {
    return null;
  }
  // ARM64 translated execution occurs only on macOS / Windows; allow other platforms to avoid false positives.
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  return { binaryArch, nativeArch: "arm64" };
}

function resolveArchitectureDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  // Route to the language-specific download page, consistently with changelog and other external links.
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

interface ArchitectureMismatchDialogText {
  title: string;
  message: string;
  detail: string;
  downloadButton: string;
  dismissButton: string;
}

function formatArchitectureMismatchDialogText(
  mismatch: ArchitectureMismatch,
  locale: Locale,
): ArchitectureMismatchDialogText {
  const isZh = locale === "zh-CN";
  if (isZh) {
    return {
      title: "架构不匹配",
      message: "当前安装的不是适配本机的版本",
      detail:
        `你正在运行 ${mismatch.binaryArch} 版本，但本机是 ${mismatch.nativeArch}（Apple 芯片）架构，` +
        `当前通过系统转译运行，会更慢、更耗电。\n\n` +
        `建议前往官网下载并安装 ${mismatch.nativeArch} 原生版本以获得最佳性能。`,
      downloadButton: "前往下载",
      dismissButton: "暂不处理",
    };
  }

  if (locale === "uk-UA") {
    return {
      title: "Невідповідна архітектура",
      message: "Встановлена збірка не відповідає вашому комп'ютеру",
      detail:
        `Запущено збірку ${mismatch.binaryArch}, а цей комп'ютер має архітектуру ${mismatch.nativeArch}. ` +
        `Зараз застосунок працює через системну трансляцію, тому повільніший і витрачає більше енергії.\n\n` +
        `Для найкращої продуктивності завантажте та встановіть нативну збірку ${mismatch.nativeArch}.`,
      downloadButton: "Завантажити",
      dismissButton: "Не зараз",
    };
  }

  return {
    title: "Architecture Mismatch",
    message: "The installed build does not match your machine",
    detail:
      `You are running the ${mismatch.binaryArch} build, but this machine is ${mismatch.nativeArch}. ` +
      `It is currently running through system translation, which is slower and less power-efficient.\n\n` +
      `Please download and install the native ${mismatch.nativeArch} build for the best performance.`,
    downloadButton: "Download",
    dismissButton: "Not now",
  };
}

interface ArchitectureGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Check architecture compatibility at startup. If the user installed the wrong build, show a prompt
 * to download the native version. This is non-blocking: the prompt opens asynchronously and does not
 * delay the main interface.
 */
export async function maybeWarnArchitectureMismatch(options: {
  locale: Locale;
  logger: ArchitectureGuardLogger;
  parentWindow?: BrowserWindow | null;
  icon?: NativeImage;
}): Promise<void> {
  const { app, dialog, shell } = await import("electron");

  const mismatch = detectArchitectureMismatch({
    runningUnderARM64Translation: app.runningUnderARM64Translation,
  });
  if (!mismatch) {
    return;
  }

  options.logger.warn(
    `[architecture] 检测到架构不匹配：运行 ${mismatch.binaryArch}，本机为 ${mismatch.nativeArch}（转译运行）`,
  );

  const text = formatArchitectureMismatchDialogText(mismatch, options.locale);
  const dialogOptions = {
    type: "warning" as const,
    buttons: [text.downloadButton, text.dismissButton],
    defaultId: 0,
    cancelId: 1,
    title: text.title,
    message: text.message,
    detail: text.detail,
    ...(options.icon && !options.icon.isEmpty() ? { icon: options.icon } : {}),
  };

  const { response } =
    options.parentWindow && !options.parentWindow.isDestroyed()
      ? await dialog.showMessageBox(options.parentWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

  if (response === 0) {
    const url = resolveArchitectureDownloadUrl(options.locale);
    options.logger.info(`[architecture] 用户选择前往下载：${url}`);
    await shell.openExternal(url);
  }
}
