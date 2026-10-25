import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserSitePermissionsSnapshot } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

type WriteOperation =
  | { kind: "set"; permission: string; state: "allow" | "deny" | "ask" }
  | { kind: "reset" };
type WriteState =
  | { status: "idle" }
  | { status: "pending" | "failed" | "succeeded"; operation: WriteOperation };

/** The main site-permission store is the single source of authorization state; the hook only holds a read projection and user-operation progress. */
export function useBrowserSitePermissions(origin: string, enabled: boolean) {
  const platform = usePlatform();
  const [states, setStates] = useState<Record<string, "allow" | "deny"> | null>(null);
  const [error, setError] = useState(false);
  const [writeState, setWrite] = useState<WriteState>({ status: "idle" });
  const pendingWrite = useRef<WriteOperation | null>(null);
  const generation = useRef(0);
  const supported =
    !!platform.getEmbeddedBrowserSitePermissions &&
    !!platform.setEmbeddedBrowserSitePermission &&
    !!platform.resetEmbeddedBrowserSitePermission;

  useEffect(() => {
    setWrite({ status: "idle" });
    // Hiding the tab does not cancel an already-submitted write; only switching the target
    // site/platform or unmounting detaches the old operation from the UI.
    return () => {
      pendingWrite.current = null;
    };
  }, [origin, platform]);

  const refresh = useCallback(async () => {
    if (!enabled || !platform.getEmbeddedBrowserSitePermissions) return;
    const current = ++generation.current;
    try {
      const snapshot: EmbeddedBrowserSitePermissionsSnapshot =
        await platform.getEmbeddedBrowserSitePermissions();
      if (current !== generation.current) return;
      setStates(snapshot[origin] ?? {});
      setError(false);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(true);
      logger.warn("[browser-permissions] settings read failed", cause);
    }
  }, [enabled, origin, platform]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return () => {
      generation.current++;
    };
  }, [enabled, origin, platform, refresh]);

  async function run(operation: WriteOperation) {
    if (!enabled || !supported || pendingWrite.current) return;
    // Accept only one click even before the React state has rendered; the reference also
    // identifies which operation the async completion belongs to.
    pendingWrite.current = operation;
    setWrite({ status: "pending", operation });
    try {
      if (operation.kind === "reset") {
        await platform.resetEmbeddedBrowserSitePermission!({ origin });
      } else {
        await platform.setEmbeddedBrowserSitePermission!({
          origin,
          permission: operation.permission,
          state: operation.state,
        });
      }
    } catch (cause) {
      logger.warn("[browser-permissions] settings write failed", cause);
      if (pendingWrite.current === operation) {
        pendingWrite.current = null;
        setWrite({ status: "failed", operation });
      }
      return;
    }
    if (pendingWrite.current !== operation) return;
    // Write and re-read failures belong to different operations. An already-successful write must
    // not be resubmitted because the read failed.
    await refresh();
    if (pendingWrite.current !== operation) return;
    pendingWrite.current = null;
    setWrite({ status: "succeeded", operation });
  }

  return {
    states,
    error,
    refresh,
    supported,
    write: writeState,
    setPermission: (permission: string, setting: "ask" | "allow" | "block") =>
      run({ kind: "set", permission, state: setting === "block" ? "deny" : setting }),
    reset: () => run({ kind: "reset" }),
    retryWrite: async () => {
      if (writeState.status === "failed") await run(writeState.operation);
    },
  };
}
