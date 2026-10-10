interface ArmsUserIdentitySyncDeps {
  /** Device-level ID, reported directly as ARMS user.name. */
  deviceMid: string;
  /** Write the ARMS user configuration (by default, wraps armsRum.setConfig("user", ...)). */
  setUser: (user: { name: string }) => void;
}

interface ArmsUserIdentitySync {
  /** Write deviceMid to ARMS user.name (deduplicated). */
  refresh: () => void;
}

/**
 * Main-process ARMS RUM user identity synchronization: consistently report device_mid as user.name.
 *
 * Do not write user.id: the SDK skips config.user.id while merging events and replaces it with an
 * internal random value, so it cannot be injected; user.name is not filtered. Also, setConfig("user", ...)
 * replaces the entire user key rather than merging fields, so pass only { name }, intentionally
 * omitting id. This matches appARMSBootstrap.init and avoids repeated overwrites.
 */
export function createArmsUserIdentitySync(deps: ArmsUserIdentitySyncDeps): ArmsUserIdentitySync {
  let lastWrittenName: string | null = null;

  function refresh(): void {
    if (deps.deviceMid === lastWrittenName) {
      return;
    }
    lastWrittenName = deps.deviceMid;
    deps.setUser({ name: deps.deviceMid });
  }

  return { refresh };
}
