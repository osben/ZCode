import {
  BROWSER_TAB_LIMIT,
  selectBrowserTabLimitVictim,
  type BrowserTabResidencyCandidate,
} from "./browserTabResidencyPolicy.js";

export interface BrowserTabResidencyRecord extends BrowserTabResidencyCandidate {
  generation: number;
}

interface BrowserTabResidencyCoordinatorOptions {
  tabLimit?: number;
  now?: () => number;
  onEvict(record: BrowserTabResidencyRecord): Promise<boolean>;
}

/**
 * Each main-process instance coordinates all BrowserWindows, but logical-tab limits and victim
 * selection are isolated per window. BrowserGuestManager still owns guests/CDP; this class tracks
 * orthogonal residency state and serialized close transactions only.
 */
export class BrowserTabResidencyCoordinator {
  private readonly records = new Map<string, BrowserTabResidencyRecord>();
  private readonly pendingWindows = new Set<number>();
  private evaluation: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: BrowserTabResidencyCoordinatorOptions) {}

  upsert(candidate: BrowserTabResidencyCandidate): BrowserTabResidencyRecord {
    const existing = this.records.get(candidate.tabId);
    const record: BrowserTabResidencyRecord = {
      ...candidate,
      generation: existing?.generation ?? 0,
    };
    this.records.set(candidate.tabId, record);
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  get(tabId: string): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    return record ? { ...record } : null;
  }

  list(): BrowserTabResidencyRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  report(
    tabId: string,
    patch: Partial<
      Pick<
        BrowserTabResidencyRecord,
        | "currentTask"
        | "selected"
        | "visible"
        | "loading"
        | "operationActive"
        | "captureActive"
        | "audible"
        | "mediaActive"
        | "downloadActive"
      >
    >,
  ): void {
    const record = this.records.get(tabId);
    if (!record) return;
    const now = this.now();
    const runtimeActivityStarted = (
      [
        "operationActive",
        "captureActive",
        "audible",
        "mediaActive",
        "loading",
        "downloadActive",
      ] as const
    ).some((key) => patch[key] === true && record[key] !== true);
    Object.assign(record, patch);
    if (patch.selected === true) {
      for (const candidate of this.records.values()) {
        if (
          candidate.tabId !== record.tabId &&
          candidate.windowId === record.windowId &&
          candidate.sessionId === record.sessionId
        ) {
          candidate.preferred = false;
        }
      }
      record.preferred = true;
      record.lastSelectedAt = now;
      record.lastActivityAt = now;
    }
    if (patch.visible === true) record.lastActivityAt = now;
    if (runtimeActivityStarted) record.lastActivityAt = now;

    const protectedDuringSuspend =
      record.residency === "suspend-pending" &&
      (record.selected ||
        record.visible ||
        record.loading ||
        record.operationActive ||
        record.captureActive ||
        record.audible ||
        record.mediaActive ||
        record.downloadActive);
    if (protectedDuringSuspend) {
      // A late suspend ack can match only the old generation; cancel this eviction as soon as protected state appears.
      record.generation += 1;
      record.residency = record.visible ? "live-visible" : "live-background";
    }
    if (
      record.residency !== "suspended" &&
      record.residency !== "restoring" &&
      record.residency !== "suspend-pending"
    ) {
      record.residency = record.visible ? "live-visible" : "live-background";
    }
    this.requestEvaluation(record.windowId);
  }

  markRestoring(tabId: string): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (!record) return null;
    if (record.residency !== "suspended") return { ...record };
    record.generation += 1;
    record.residency = "restoring";
    record.loading = true;
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  completeRestore(tabId: string, generation: number): boolean {
    const record = this.records.get(tabId);
    if (!record || record.generation !== generation || record.residency !== "restoring") {
      return false;
    }
    record.loading = false;
    record.residency = record.visible ? "live-visible" : "live-background";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return true;
  }

  failRestore(tabId: string, generation: number): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (!record || record.generation !== generation || record.residency !== "restoring") {
      return null;
    }
    // Attach timeout/cancel previously had no failure terminal state, leaving the tab stuck in
    // restoring forever and allowing a late guest from the same generation to attach. Advance the
    // generation and return to suspended so the next access can safely retry restoration.
    record.generation += 1;
    record.loading = false;
    record.residency = "suspended";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  commitCancelledSuspend(
    tabId: string,
    cancelledGeneration: number,
  ): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (
      !record ||
      record.generation <= cancelledGeneration ||
      (record.residency !== "live-visible" && record.residency !== "live-background")
    ) {
      return null;
    }
    // If the renderer already received the old suspend, main rejecting only the stale ack would
    // leave the two sides inconsistent. Record the physical fact that the renderer unloaded, then
    // let the manager restore it fully with a new generation.
    record.loading = false;
    record.residency = "suspended";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  markAttached(tabId: string, visible: boolean, generation?: number): boolean {
    const record = this.records.get(tabId);
    if (!record) return false;
    if (
      record.residency === "restoring" &&
      (generation === undefined || generation !== record.generation)
    ) {
      return false;
    }
    record.guestAttached = true;
    record.visible = visible;
    if (record.residency !== "restoring") {
      record.residency = visible ? "live-visible" : "live-background";
    }
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return true;
  }

  markDetached(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    // After a guest is destroyed/detached, logical residency may temporarily remain live-background.
    // Clear the physical fact separately; the logical shell still counts toward the limit of 32 and
    // may be fully closed even without a guest.
    record.guestAttached = false;
    this.requestEvaluation(record.windowId);
  }

  isTransitionCurrent(
    tabId: string,
    generation: number,
    residency: BrowserTabResidencyRecord["residency"],
  ): boolean {
    const record = this.records.get(tabId);
    return Boolean(record && record.generation === generation && record.residency === residency);
  }

  remove(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    this.records.delete(tabId);
    this.requestEvaluation(record.windowId);
  }

  async whenIdle(): Promise<void> {
    await this.evaluation;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingWindows.clear();
    this.records.clear();
  }

  private requestEvaluation(windowId: number): void {
    if (this.disposed) return;
    this.pendingWindows.add(windowId);
    if (this.evaluation) return;
    this.evaluation = Promise.resolve()
      .then(() => this.evaluatePendingWindows())
      .finally(() => {
        this.evaluation = null;
        if (this.pendingWindows.size > 0) {
          const nextWindowId = this.pendingWindows.values().next().value as number | undefined;
          if (nextWindowId !== undefined) this.requestEvaluation(nextWindowId);
        }
      });
  }

  private async evaluatePendingWindows(): Promise<void> {
    while (!this.disposed && this.pendingWindows.size > 0) {
      const windowId = this.pendingWindows.values().next().value as number;
      this.pendingWindows.delete(windowId);
      while (!this.disposed) {
        const victim = selectBrowserTabLimitVictim([...this.records.values()], {
          windowId,
          tabLimit: this.options.tabLimit ?? BROWSER_TAB_LIMIT,
        });
        if (!victim) break;
        const record = this.records.get(victim.tabId);
        if (!record) continue;
        const evicted = await this.options.onEvict({ ...record });
        if (!evicted) break;
        // The manager's durable close removes this record first; callers using the pure coordinator finish cleanup here.
        this.remove(record.tabId);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
