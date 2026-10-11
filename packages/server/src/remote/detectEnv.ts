function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeRemotePlatform(rawPlatform: string): string {
  const platform = normalizeToken(rawPlatform);

  if (platform === "darwin" || platform === "macos") {
    return "darwin";
  }

  if (platform === "linux" || platform === "gnu/linux") {
    return "linux";
  }

  if (
    platform === "windows_nt" ||
    platform.startsWith("mingw") ||
    platform.startsWith("msys") ||
    platform.startsWith("cygwin")
  ) {
    return "win32";
  }

  return platform;
}

export function normalizeRemoteArch(rawArch: string): string {
  const arch = normalizeToken(rawArch);

  if (arch === "x86_64" || arch === "amd64") {
    return "x64";
  }

  if (arch === "aarch64" || arch === "arm64e") {
    return "arm64";
  }

  return arch;
}

export function resolveRemotePlatform(reportedPlatform: string, kernelOstype: string): string {
  const normalizedReportedPlatform = normalizeRemotePlatform(reportedPlatform);
  const normalizedKernelOstype = normalizeRemotePlatform(kernelOstype);

  // Some SSH/Docker test containers spoof `uname -s` as Darwin,
  // while still running a Linux kernel. Selecting a package as Darwin would upload a Mach-O binary and cause Exec format error in the container.
  // Prefer the actual kernel type exposed by /proc to avoid misidentifying Linux containers as macOS.
  if (normalizedReportedPlatform === "darwin" && normalizedKernelOstype === "linux") {
    return "linux";
  }

  return normalizedReportedPlatform;
}
