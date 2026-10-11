import type { RemoteEnvironment } from "@zcode/server/remote/backend.js";

export function assertSupportedRemoteEnvironment(env: RemoteEnvironment): void {
  if (env.platform !== "win32") {
    return;
  }

  // Previously deploy/connect each hardcoded Windows rejection logic, which could be bypassed by skipDeploy or produce inconsistent errors.
  // Current remote backends and startup commands still depend on a POSIX shell; centralize the capability boundary until a Windows shell strategy is added.
  throw new Error("当前 remote 模式仅支持 POSIX shell 环境，暂不支持 Windows 原生远程主机");
}
