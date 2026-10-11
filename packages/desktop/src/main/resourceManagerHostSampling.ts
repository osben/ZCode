import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  type HostResourceUsageProcess,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

/**
 * Resource Manager main → Host sampling fan-out.
 * For each snapshot, send one request per live Host using a requestId; on timeout, use that Host's
 * previous result as a fallback so the list does not flash empty.
 */

/** Maximum wait for Host sampling fan-out. */
const HOST_SNAPSHOT_TIMEOUT_MS = 900;

interface PendingHostRequest {
  label: string;
  cancel: () => void;
  resolve: (result: HostResourceUsageSnapshotResultResponse) => void;
}

const pendingHostRequests = new Map<string, PendingHostRequest>();
const requestIdByHost = new Map<string, string>();
const lastHostResults = new Map<string, HostResourceUsageProcess[]>();

/** Called when desktopHostProcess receives a Host response. */
export function resolveHostResourceUsageResult(
  label: string,
  result: HostResourceUsageSnapshotResultResponse,
): void {
  const pending = pendingHostRequests.get(result.requestId);
  // A stale result from before close/reopen must not be written into a new sampling session; the requestId must also belong to the responding Host.
  if (!pending || pending.label !== label) return;
  lastHostResults.set(label, result.processes);
  pending.resolve(result);
}

/** Clear the Host's fallback cache when it exits. */
export function forgetHostResourceUsage(label: string): void {
  const requestId = requestIdByHost.get(label);
  if (requestId) pendingHostRequests.get(requestId)?.cancel();
  lastHostResults.delete(label);
}

export function requestHostResourceUsage(
  label: string,
  child: Pick<ElectronUtilityProcess, "postMessage">,
  timeoutMs: number = HOST_SNAPSHOT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<HostResourceUsageProcess[]> {
  if (signal?.aborted) return Promise.resolve([]);
  // Reuse the same sampling round after the display wait times out; do not keep queuing requests to a slow Host on every UI tick.
  if (requestIdByHost.has(label)) return Promise.resolve(lastHostResults.get(label) ?? []);
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      resolve(lastHostResults.get(label) ?? []);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pendingHostRequests.delete(requestId);
      if (requestIdByHost.get(label) === requestId) requestIdByHost.delete(label);
    };
    const cancel = () => {
      finish();
      lastHostResults.delete(label);
      try {
        child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotCancel, requestId });
      } catch {
        /* Host has exited; no further cancellation is needed. */
      }
      resolve([]);
    };
    requestIdByHost.set(label, requestId);
    pendingHostRequests.set(requestId, {
      label,
      cancel,
      resolve: (result) => {
        finish();
        resolve(result.processes);
      },
    });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId });
    } catch {
      finish();
      resolve(lastHostResults.get(label) ?? []);
    }
  });
}
