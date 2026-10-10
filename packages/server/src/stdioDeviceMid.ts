import { ensureDeviceMid as ensureSharedDeviceMid } from "@zcode/services/node";

interface EnsureRemoteServerDeviceMidOptions {
  /** Test injection only; production always uses services' ensureDeviceMid. */
  ensureDeviceMid?: () => Promise<string>;
  log: (...args: unknown[]) => void;
}

/**
 * Ensure the host has its own deviceMid when the remote server starts.
 *
 * Remote workspaces (SSH/WSL/Docker) have no Desktop main process, so previously no process wrote a device identity file on the remote host,
 * and buildZCodeSourceHeaders() only read it without generating one. Starting with 3.12.0, the remote host queries Start Plan entitlements itself;
 * billing/balance requests without X-Device-Mid were rejected by the server as parameter errors, so remote workspaces could not see Start Plan models.
 * Desktop main handles this locally through ensureDesktopDeviceMidSync; this gives the remote stdio entry the same responsibility,
 * reusing the same file, field, and lock so it shares a device identity with zcode-cli on the same host.
 *
 * Failure does not block startup: a missing device identity only leaves one header out of ZCode endpoint requests (the same behavior as before the fix),
 * and the rest of the remote server does not depend on it. Log a warning and preserve the cause; do not fabricate a device ID.
 */
export async function ensureRemoteServerDeviceMid(
  options: EnsureRemoteServerDeviceMidOptions,
): Promise<string | undefined> {
  const ensureDeviceMid = options.ensureDeviceMid ?? ensureSharedDeviceMid;
  try {
    return await ensureDeviceMid();
  } catch (error) {
    options.log(
      "deviceMid 初始化失败，ZCode endpoint 请求将不带 X-Device-Mid:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
